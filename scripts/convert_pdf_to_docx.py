"""Convert PDF to editable DOCX with absolute layout fidelity.

Each PDF page becomes a Word section of the same size. Text spans are
editable floating text boxes; fills and strokes are recreated as shapes
at the original coordinates.
"""

from __future__ import annotations

import html
import re
import sys
from dataclasses import dataclass

import pymupdf
from docx import Document
from docx.enum.text import WD_BREAK
from docx.oxml import parse_xml
from docx.oxml.ns import qn
from docx.shared import Pt

EMU_PER_PT = 12700

# Manual-entry marks under times in Espelho Ponto are short horizontal strokes.
TIME_UNDERLINE_MIN_LEN = 5.0
TIME_UNDERLINE_MAX_LEN = 45.0
TIME_UNDERLINE_MAX_THICKNESS = 2.0

# Superscript / degree markers that may sit beside a time value.
ATTACH_MARKERS = {"²", "³", "°", "º", "*", "†"}
TIME_TOKEN_RE = re.compile(r"\d{1,3}:\d{2}")


@dataclass
class TextSpan:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    size: float
    bold: bool
    color: tuple[int, int, int]


@dataclass
class ShapeRect:
    x0: float
    y0: float
    x1: float
    y1: float
    fill: tuple[int, int, int] | None = None
    stroke: tuple[int, int, int] | None = None
    stroke_width: float = 0.75
    behind: bool = True


def pt_emu(value: float) -> int:
    return int(round(value * EMU_PER_PT))


def rgb_tuple(color) -> tuple[int, int, int] | None:
    if color is None:
        return None
    if isinstance(color, int):
        return ((color >> 16) & 255, (color >> 8) & 255, color & 255)
    if isinstance(color, (tuple, list)) and len(color) >= 3:
        r, g, b = color[:3]
        if max(r, g, b) <= 1:
            return (int(round(r * 255)), int(round(g * 255)), int(round(b * 255)))
        return (int(r), int(g), int(b))
    return None


def rgb_hex(color: tuple[int, int, int]) -> str:
    return f"{color[0]:02X}{color[1]:02X}{color[2]:02X}"


class ShapeIdFactory:
    def __init__(self) -> None:
        self._value = 1

    def next(self) -> int:
        value = self._value
        self._value += 1
        return value


def _clear_body(document: Document) -> None:
    body = document._element.body
    for child in list(body):
        if child.tag != qn("w:sectPr"):
            body.remove(child)


def _configure_section(section, width_pt: float, height_pt: float) -> None:
    section.page_width = Pt(width_pt)
    section.page_height = Pt(height_pt)
    section.left_margin = Pt(0)
    section.right_margin = Pt(0)
    section.top_margin = Pt(0)
    section.bottom_margin = Pt(0)


def _extract_spans(page: pymupdf.Page) -> list[TextSpan]:
    spans: list[TextSpan] = []
    seen: set[tuple] = set()

    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                text = span.get("text", "")
                # Ignore spacer glyphs between columns — they used to glue
                # neighboring times into one misplaced text box.
                if text == "" or not text.strip():
                    continue
                x0, y0, x1, y1 = span["bbox"]
                # QuickReports often paints the same glyph run multiple times.
                key = (
                    text,
                    round(float(x0), 1),
                    round(float(y0), 1),
                    round(float(x1), 1),
                    round(float(y1), 1),
                )
                if key in seen:
                    continue
                seen.add(key)
                spans.append(
                    TextSpan(
                        text=text,
                        x0=float(x0),
                        y0=float(y0),
                        x1=float(x1),
                        y1=float(y1),
                        size=float(span.get("size", 8)),
                        bold=bool(span.get("flags", 0) & 2**4),
                        color=rgb_tuple(span.get("color", 0)) or (0, 0, 0),
                    )
                )
    return spans


def _is_attachable_marker(text: str) -> bool:
    token = text.strip()
    return token in ATTACH_MARKERS


def _merge_spans(spans: list[TextSpan]) -> list[TextSpan]:
    """Attach only nearby markers to a span; never bridge table columns."""
    if not spans:
        return []

    ordered = sorted(spans, key=lambda s: ((s.y0 + s.y1) / 2, s.x0))
    merged: list[TextSpan] = []
    current = ordered[0]

    for span in ordered[1:]:
        # Ignore residual overlapping duplicates that survived key rounding.
        if (
            span.text == current.text
            and abs(span.x0 - current.x0) <= 0.8
            and abs(span.y0 - current.y0) <= 0.8
        ):
            continue

        same_line = abs(((span.y0 + span.y1) / 2) - ((current.y0 + current.y1) / 2)) <= 1.2
        marker = _is_attachable_marker(span.text)
        # Keep each time/value in its own box at the PDF x. Only glue markers
        # (² ³ °) that sit immediately after the current span.
        can_attach = (
            same_line
            and marker
            and span.x0 <= current.x1 + 2.2
            and not TIME_TOKEN_RE.search(span.text)
        )

        if can_attach:
            space = " " if (not current.text.endswith(" ")) else ""
            current = TextSpan(
                text=current.text + space + span.text.strip(),
                x0=current.x0,
                y0=min(current.y0, span.y0),
                x1=max(current.x1, span.x1),
                y1=max(current.y1, span.y1),
                size=current.size,
                bold=current.bold,
                color=current.color,
            )
        else:
            merged.append(current)
            current = span
    merged.append(current)
    return merged


def _is_time_underline(x0: float, y0: float, x1: float, y1: float) -> bool:
    """Short horizontal marks under punch times (lançamentos manuais)."""
    width = abs(x1 - x0)
    height = abs(y1 - y0)
    return (
        height <= TIME_UNDERLINE_MAX_THICKNESS
        and TIME_UNDERLINE_MIN_LEN < width < TIME_UNDERLINE_MAX_LEN
    )


def _is_point_artifact(x0: float, y0: float, x1: float, y1: float) -> bool:
    """Zero-length strokes that render as black dots (common on Sab/Dom)."""
    return abs(x1 - x0) <= 1.5 and abs(y1 - y0) <= TIME_UNDERLINE_MAX_THICKNESS


def _extract_shapes(page: pymupdf.Page) -> list[ShapeRect]:
    shapes: list[ShapeRect] = []
    page_area = float(page.rect.width * page.rect.height)

    for drawing in page.get_drawings():
        fill = rgb_tuple(drawing.get("fill"))
        stroke = rgb_tuple(drawing.get("color"))
        width = float(drawing.get("width") or 0.75)
        rect = drawing.get("rect")

        # Filled areas (zebra rows, boxes). Skip near-full-page white backgrounds.
        if fill is not None and rect is not None and rect.width > 2 and rect.height > 2:
            area = float(rect.width * rect.height)
            is_white = fill[0] > 250 and fill[1] > 250 and fill[2] > 250
            if not (is_white and area > page_area * 0.8):
                shapes.append(
                    ShapeRect(
                        x0=float(rect.x0),
                        y0=float(rect.y0),
                        x1=float(rect.x1),
                        y1=float(rect.y1),
                        fill=fill,
                        stroke=None,
                        behind=True,
                    )
                )

        for item in drawing.get("items", []):
            kind = item[0]
            if kind == "l":
                p1, p2 = item[1], item[2]
                x0, x1 = sorted((float(p1.x), float(p2.x)))
                y0, y1 = sorted((float(p1.y), float(p2.y)))
                # Skip point-like leftovers (black dots on empty weekend cells).
                if _is_point_artifact(x0, y0, x1, y1):
                    continue
                if abs(p1.y - p2.y) <= 1.2:  # horizontal
                    # Drop only the short underlines beneath times.
                    if _is_time_underline(x0, y0, x1, y1):
                        continue
                    y = (y0 + y1) / 2
                    half = max(width, 0.6) / 2
                    shapes.append(
                        ShapeRect(
                            x0=x0,
                            y0=y - half,
                            x1=x1,
                            y1=y + half,
                            fill=stroke or (0, 0, 0),
                            behind=True,
                        )
                    )
                elif abs(p1.x - p2.x) <= 1.2:  # vertical
                    x = (x0 + x1) / 2
                    half = max(width, 0.6) / 2
                    shapes.append(
                        ShapeRect(
                            x0=x - half,
                            y0=y0,
                            x1=x + half,
                            y1=y1,
                            fill=stroke or (0, 0, 0),
                            behind=True,
                        )
                    )
            elif kind == "re":
                shape_rect = item[1]
                rx0 = float(shape_rect.x0)
                ry0 = float(shape_rect.y0)
                rx1 = float(shape_rect.x1)
                ry1 = float(shape_rect.y1)
                if _is_point_artifact(rx0, ry0, rx1, ry1) or _is_time_underline(
                    rx0, ry0, rx1, ry1
                ):
                    continue
                if fill is None and stroke is not None:
                    shapes.append(
                        ShapeRect(
                            x0=rx0,
                            y0=ry0,
                            x1=rx1,
                            y1=ry1,
                            fill=None,
                            stroke=stroke,
                            stroke_width=width,
                            behind=True,
                        )
                    )

    # Deduplicate repeated strokes emitted by the PDF generator.
    unique: dict[tuple, ShapeRect] = {}
    for shape in shapes:
        if _is_point_artifact(shape.x0, shape.y0, shape.x1, shape.y1):
            continue
        if _is_time_underline(shape.x0, shape.y0, shape.x1, shape.y1):
            continue
        key = (
            round(shape.x0, 1),
            round(shape.y0, 1),
            round(shape.x1, 1),
            round(shape.y1, 1),
            shape.fill,
            shape.stroke,
            round(shape.stroke_width, 2),
        )
        unique[key] = shape
    return list(unique.values())


def _shape_rect_xml(shape: ShapeRect, shape_id: int) -> str:
    x = pt_emu(shape.x0)
    y = pt_emu(shape.y0)
    cx = max(pt_emu(shape.x1 - shape.x0), 635)  # >= 0.05pt
    cy = max(pt_emu(shape.y1 - shape.y0), 635)
    behind = 1 if shape.behind else 0

    if shape.fill is not None:
        fill_xml = f'<a:solidFill><a:srgbClr val="{rgb_hex(shape.fill)}"/></a:solidFill>'
        line_xml = "<a:ln><a:noFill/></a:ln>"
    else:
        fill_xml = "<a:noFill/>"
        color = rgb_hex(shape.stroke or (0, 0, 0))
        line_xml = (
            f'<a:ln w="{pt_emu(shape.stroke_width)}">'
            f'<a:solidFill><a:srgbClr val="{color}"/></a:solidFill>'
            f"</a:ln>"
        )

    return f"""
<w:drawing xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
           xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
           xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
           xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
  <wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0"
             relativeHeight="{shape_id}" behindDoc="{behind}" locked="0"
             layoutInCell="1" allowOverlap="1">
    <wp:simplePos x="0" y="0"/>
    <wp:positionH relativeFrom="page"><wp:posOffset>{x}</wp:posOffset></wp:positionH>
    <wp:positionV relativeFrom="page"><wp:posOffset>{y}</wp:posOffset></wp:positionV>
    <wp:extent cx="{cx}" cy="{cy}"/>
    <wp:effectExtent l="0" t="0" r="0" b="0"/>
    <wp:wrapNone/>
    <wp:docPr id="{shape_id}" name="Shape {shape_id}"/>
    <wp:cNvGraphicFramePr/>
    <a:graphic>
      <a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
        <wps:wsp>
          <wps:cNvSpPr/>
          <wps:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            {fill_xml}
            {line_xml}
          </wps:spPr>
          <wps:bodyPr/>
        </wps:wsp>
      </a:graphicData>
    </a:graphic>
  </wp:anchor>
</w:drawing>
""".strip()


def _textbox_xml(span: TextSpan, shape_id: int) -> str:
    # Keep the box origin exactly on the PDF glyph origin; pad only the size
    # so characters are not clipped by Word's text-frame edges.
    x = pt_emu(span.x0)
    y = pt_emu(span.y0)
    width = max(span.x1 - span.x0 + 1.2, span.size * 0.85)
    height = max(span.y1 - span.y0 + 0.9, span.size * 1.25)
    cx = pt_emu(width)
    cy = pt_emu(height)
    text = html.escape(span.text)
    bold = "<w:b/>" if span.bold else ""
    color = rgb_hex(span.color)
    size_half_points = max(int(round(span.size * 2)), 12)

    return f"""
<w:drawing xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
           xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
           xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
           xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
  <wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0"
             relativeHeight="{shape_id + 100000}" behindDoc="0" locked="0"
             layoutInCell="1" allowOverlap="1">
    <wp:simplePos x="0" y="0"/>
    <wp:positionH relativeFrom="page"><wp:posOffset>{x}</wp:posOffset></wp:positionH>
    <wp:positionV relativeFrom="page"><wp:posOffset>{y}</wp:posOffset></wp:positionV>
    <wp:extent cx="{cx}" cy="{cy}"/>
    <wp:effectExtent l="0" t="0" r="0" b="0"/>
    <wp:wrapNone/>
    <wp:docPr id="{shape_id}" name="Text {shape_id}"/>
    <wp:cNvGraphicFramePr/>
    <a:graphic>
      <a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
        <wps:wsp>
          <wps:cNvSpPr txBox="1"/>
          <wps:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:noFill/>
            <a:ln><a:noFill/></a:ln>
          </wps:spPr>
          <wps:txbx>
            <w:txbxContent>
              <w:p>
                <w:pPr>
                  <w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>
                  <w:ind w:left="0" w:right="0" w:firstLine="0"/>
                </w:pPr>
                <w:r>
                  <w:rPr>
                    <w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>
                    <w:sz w:val="{size_half_points}"/>
                    <w:szCs w:val="{size_half_points}"/>
                    <w:color w:val="{color}"/>
                    <w:spacing w:val="0"/>
                    {bold}
                  </w:rPr>
                  <w:t xml:space="preserve">{text}</w:t>
                </w:r>
              </w:p>
            </w:txbxContent>
          </wps:txbx>
          <wps:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t" upright="1"/>
        </wps:wsp>
      </a:graphicData>
    </a:graphic>
  </wp:anchor>
</w:drawing>
""".strip()


def _append_drawing(paragraph, xml: str) -> None:
    run = paragraph.add_run()
    run._r.append(parse_xml(xml))


def _add_page(
    document: Document,
    page: pymupdf.Page,
    ids: ShapeIdFactory,
    *,
    page_break_before: bool,
) -> None:
    if page_break_before:
        breaker = document.add_paragraph()
        breaker.paragraph_format.space_before = Pt(0)
        breaker.paragraph_format.space_after = Pt(0)
        breaker.add_run().add_break(WD_BREAK.PAGE)

    paragraph = document.add_paragraph()
    paragraph.paragraph_format.space_before = Pt(0)
    paragraph.paragraph_format.space_after = Pt(0)

    for shape in _extract_shapes(page):
        _append_drawing(paragraph, _shape_rect_xml(shape, ids.next()))

    for span in _merge_spans(_extract_spans(page)):
        _append_drawing(paragraph, _textbox_xml(span, ids.next()))


def convert_pdf_to_docx(pdf_path: str, docx_path: str) -> None:
    pdf = pymupdf.open(pdf_path)
    document = Document()
    _clear_body(document)
    ids = ShapeIdFactory()

    try:
        if pdf.page_count == 0:
            raise ValueError("O PDF não contém páginas.")

        first = pdf[0]
        _configure_section(
            document.sections[0],
            float(first.rect.width),
            float(first.rect.height),
        )

        for index, page in enumerate(pdf):
            _add_page(document, page, ids, page_break_before=index > 0)

        document.save(docx_path)
    finally:
        pdf.close()


def main() -> int:
    if len(sys.argv) != 3:
        print(
            "Usage: convert_pdf_to_docx.py <input.pdf> <output.docx>",
            file=sys.stderr,
        )
        return 1

    convert_pdf_to_docx(sys.argv[1], sys.argv[2])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
