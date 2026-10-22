import JSZip from "jszip";
import type { Font, Matrix, Path, PDFPage, StrokeState } from "mupdf";
import { loadMupdf, type MupdfModule } from "@/lib/loadMupdf";

const EMU_PER_PT = 12700;

const TIME_UNDERLINE_MIN_LEN = 5;
const TIME_UNDERLINE_MAX_LEN = 45;
const TIME_UNDERLINE_MAX_THICKNESS = 2;
const ATTACH_MARKERS = new Set(["²", "³", "°", "º", "*", "†"]);
const TIME_TOKEN_RE = /\d{1,3}:\d{2}/;

type RGB = [number, number, number];

type TextSpan = {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  size: number;
  bold: boolean;
  color: RGB;
};

type ShapeRect = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  fill?: RGB | null;
  stroke?: RGB | null;
  strokeWidth?: number;
  behind?: boolean;
};

function ptEmu(value: number): number {
  return Math.round(value * EMU_PER_PT);
}

function rgbHex(color: RGB): string {
  return color.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("").toUpperCase();
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isTimeUnderline(x0: number, y0: number, x1: number, y1: number): boolean {
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);
  return height <= TIME_UNDERLINE_MAX_THICKNESS && width > TIME_UNDERLINE_MIN_LEN && width < TIME_UNDERLINE_MAX_LEN;
}

function isPointArtifact(x0: number, y0: number, x1: number, y1: number): boolean {
  return Math.abs(x1 - x0) <= 1.5 && Math.abs(y1 - y0) <= TIME_UNDERLINE_MAX_THICKNESS;
}

function toRgb(color: number[] | undefined | null): RGB | null {
  if (!color || color.length < 3) return null;
  const [r, g, b] = color;
  if (Math.max(r, g, b) <= 1) {
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }
  return [Math.round(r), Math.round(g), Math.round(b)];
}

function extractSpans(page: PDFPage): TextSpan[] {
  const stext = page.toStructuredText("preserve-spans");
  type CharRun = {
    c: string;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    size: number;
    bold: boolean;
    color: RGB;
  };

  const chars: CharRun[] = [];

  stext.walk({
    onChar(c: string, _origin: number[], font: Font, size: number, a: number[], b: number[]) {
      if (!c || !c.trim()) return;

      const quad = a.length === 8 ? a : b;
      const colorArr = b.length === 3 ? b : a.length === 3 ? a : [0, 0, 0];
      if (quad.length < 8) return;

      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      const fontName = typeof font?.getName === "function" ? font.getName() : String(font ?? "");
      const bold = /bold/i.test(fontName);
      const color = toRgb(colorArr) ?? [0, 0, 0];

      chars.push({
        c,
        x0: Math.min(...xs),
        y0: Math.min(...ys),
        x1: Math.max(...xs),
        y1: Math.max(...ys),
        size,
        bold,
        color,
      });
    },
  });

  const spans: TextSpan[] = [];
  let current: TextSpan | null = null;

  for (const ch of chars) {
    if (
      current &&
      current.bold === ch.bold &&
      current.color[0] === ch.color[0] &&
      current.color[1] === ch.color[1] &&
      current.color[2] === ch.color[2] &&
      Math.abs(current.size - ch.size) < 0.2 &&
      Math.abs((current.y0 + current.y1) / 2 - (ch.y0 + ch.y1) / 2) <= 1.2 &&
      ch.x0 <= current.x1 + 1.2
    ) {
      current.text += ch.c;
      current.x1 = Math.max(current.x1, ch.x1);
      current.y0 = Math.min(current.y0, ch.y0);
      current.y1 = Math.max(current.y1, ch.y1);
      continue;
    }

    if (current) spans.push(current);
    current = {
      text: ch.c,
      x0: ch.x0,
      y0: ch.y0,
      x1: ch.x1,
      y1: ch.y1,
      size: ch.size,
      bold: ch.bold,
      color: ch.color,
    };
  }
  if (current) spans.push(current);

  const seen = new Set<string>();
  return spans.filter((span) => {
    const key = `${span.text}|${span.x0.toFixed(1)}|${span.y0.toFixed(1)}|${span.x1.toFixed(1)}|${span.y1.toFixed(1)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeSpans(spans: TextSpan[]): TextSpan[] {
  if (spans.length === 0) return [];

  const ordered = [...spans].sort(
    (a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 || a.x0 - b.x0,
  );
  const merged: TextSpan[] = [];
  let current = ordered[0];

  for (let i = 1; i < ordered.length; i++) {
    const span = ordered[i];
    if (
      span.text === current.text &&
      Math.abs(span.x0 - current.x0) <= 0.8 &&
      Math.abs(span.y0 - current.y0) <= 0.8
    ) {
      continue;
    }

    const sameLine = Math.abs((span.y0 + span.y1) / 2 - (current.y0 + current.y1) / 2) <= 1.2;
    const marker = ATTACH_MARKERS.has(span.text.trim());
    const canAttach =
      sameLine && marker && span.x0 <= current.x1 + 2.2 && !TIME_TOKEN_RE.test(span.text);

    if (canAttach) {
      const space = current.text.endsWith(" ") ? "" : " ";
      current = {
        ...current,
        text: current.text + space + span.text.trim(),
        y0: Math.min(current.y0, span.y0),
        x1: Math.max(current.x1, span.x1),
        y1: Math.max(current.y1, span.y1),
      };
    } else {
      merged.push(current);
      current = span;
    }
  }
  merged.push(current);
  return merged;
}

function extractShapes(mupdf: MupdfModule, page: PDFPage): ShapeRect[] {
  const pageBounds = page.getBounds();
  const pageWidth = pageBounds[2] - pageBounds[0];
  const pageHeight = pageBounds[3] - pageBounds[1];
  const pageArea = pageWidth * pageHeight;
  const shapes: ShapeRect[] = [];

  const fillStroke = new mupdf.StrokeState({
    lineCap: "Butt",
    lineJoin: "Miter",
    lineWidth: 0,
    miterLimit: 10,
  });

  // DeviceFunctions is not exported from mupdf types; callbacks match runtime shape.
  const device = new mupdf.Device({
    fillPath(path: Path, _evenOdd: boolean, ctm: Matrix, _cs: unknown, color: number[]) {
      const bounds = path.getBounds(fillStroke, ctm);
      const [x0, y0, x1, y1] = bounds;
      const fill = toRgb(color);
      if (!fill) return;
      const width = x1 - x0;
      const height = y1 - y0;
      if (width <= 2 || height <= 2) return;
      // Pure white fills are invisible on white paper and, in Word, often paint
      // over the gray table-header / zebra rows because of anchor z-order.
      const isWhite = fill[0] >= 250 && fill[1] >= 250 && fill[2] >= 250;
      if (isWhite) return;
      if (width * height > pageArea * 0.8) return;
      shapes.push({ x0, y0, x1, y1, fill, behind: true });
    },
    strokePath(path: Path, stroke: StrokeState, ctm: Matrix, _cs: unknown, color: number[]) {
      const bounds = path.getBounds(stroke, ctm);
      const [x0, y0, x1, y1] = bounds;
      if (isPointArtifact(x0, y0, x1, y1) || isTimeUnderline(x0, y0, x1, y1)) return;

      const strokeRgb = toRgb(color) ?? [0, 0, 0];
      const lineWidth = typeof stroke?.getLineWidth === "function" ? stroke.getLineWidth() : 0.75;
      const width = x1 - x0;
      const height = y1 - y0;

      if (height <= 1.5 || width <= 1.5) {
        shapes.push({ x0, y0, x1, y1, fill: strokeRgb, behind: true });
        return;
      }

      shapes.push({
        x0,
        y0,
        x1,
        y1,
        stroke: strokeRgb,
        strokeWidth: lineWidth || 0.75,
        behind: true,
      });
    },
  } as never);

  try {
    page.run(device, mupdf.Matrix.identity);
    // MuPDF warns ("dropping unclosed device") if close() is skipped before GC/destroy.
    device.close();
  } finally {
    device.destroy();
    fillStroke.destroy();
  }

  const unique = new Map<string, ShapeRect>();
  for (const shape of shapes) {
    if (isPointArtifact(shape.x0, shape.y0, shape.x1, shape.y1)) continue;
    if (isTimeUnderline(shape.x0, shape.y0, shape.x1, shape.y1)) continue;
    const key = [
      shape.x0.toFixed(1),
      shape.y0.toFixed(1),
      shape.x1.toFixed(1),
      shape.y1.toFixed(1),
      shape.fill?.join(",") ?? "",
      shape.stroke?.join(",") ?? "",
      String(shape.strokeWidth ?? ""),
    ].join("|");
    unique.set(key, shape);
  }

  // Larger fills first (lower Word relativeHeight), then strokes/lines on top.
  return [...unique.values()].sort((a, b) => {
    const areaA = Math.abs(a.x1 - a.x0) * Math.abs(a.y1 - a.y0);
    const areaB = Math.abs(b.x1 - b.x0) * Math.abs(b.y1 - b.y0);
    if (areaA !== areaB) return areaB - areaA;
    return a.y0 - b.y0 || a.x0 - b.x0;
  });
}

function shapeRectXml(shape: ShapeRect, shapeId: number): string {
  const x = ptEmu(shape.x0);
  const y = ptEmu(shape.y0);
  const cx = Math.max(ptEmu(shape.x1 - shape.x0), 635);
  const cy = Math.max(ptEmu(shape.y1 - shape.y0), 635);
  const behind = shape.behind ? 1 : 0;

  let fillXml = "<a:noFill/>";
  let lineXml = "<a:ln><a:noFill/></a:ln>";
  if (shape.fill) {
    fillXml = `<a:solidFill><a:srgbClr val="${rgbHex(shape.fill)}"/></a:solidFill>`;
  } else if (shape.stroke) {
    lineXml = `<a:ln w="${ptEmu(shape.strokeWidth ?? 0.75)}"><a:solidFill><a:srgbClr val="${rgbHex(shape.stroke)}"/></a:solidFill></a:ln>`;
  }

  return `<w:drawing xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${shapeId}" behindDoc="${behind}" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${x}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${y}</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${shapeId}" name="Shape ${shapeId}"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fillXml}${lineXml}</wps:spPr><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing>`;
}

function textboxXml(span: TextSpan, shapeId: number): string {
  const x = ptEmu(span.x0);
  const y = ptEmu(span.y0);
  const cx = ptEmu(Math.max(span.x1 - span.x0 + 1.2, span.size * 0.85));
  const cy = ptEmu(Math.max(span.y1 - span.y0 + 0.9, span.size * 1.25));
  const text = escapeXml(span.text);
  const bold = span.bold ? "<w:b/>" : "";
  const color = rgbHex(span.color);
  const sizeHalfPoints = Math.max(Math.round(span.size * 2), 12);
  const relHeight = shapeId + 100000;

  return `<w:drawing xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${relHeight}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${x}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${y}</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${shapeId}" name="Text ${shapeId}"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr><wps:txbx><w:txbxContent><w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="0" w:right="0" w:firstLine="0"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="${sizeHalfPoints}"/><w:szCs w:val="${sizeHalfPoints}"/><w:color w:val="${color}"/><w:spacing w:val="0"/>${bold}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t" upright="1"/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing>`;
}

function buildDocumentXml(
  pages: Array<{ width: number; height: number; drawings: string[] }>,
): string {
  const first = pages[0];
  const pageWidthTwips = Math.round(first.width * 20);
  const pageHeightTwips = Math.round(first.height * 20);

  const bodyParts: string[] = [];
  pages.forEach((page, index) => {
    if (index > 0) {
      bodyParts.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    }
    const runs = page.drawings.map((drawing) => `<w:r>${drawing}</w:r>`).join("");
    bodyParts.push(
      `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>${runs}</w:p>`,
    );
  });

  bodyParts.push(
    `<w:sectPr><w:pgSz w:w="${pageWidthTwips}" w:h="${pageHeightTwips}"/><w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`,
  );

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
  <w:body>
    ${bodyParts.join("\n")}
  </w:body>
</w:document>`;
}

async function packDocx(documentXml: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
  );
  zip.folder("_rels")?.file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  const word = zip.folder("word");
  word?.file("document.xml", documentXml);
  word?.file(
    "styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
  </w:style>
</w:styles>`,
  );
  word?.folder("_rels")?.file(
    "document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
  );

  return zip.generateAsync({ type: "uint8array" });
}

export async function convertPdfToDocx(pdfBytes: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const data = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  const doc = mupdf.Document.openDocument(data, "application/pdf");

  try {
    const pageCount = doc.countPages();
    if (pageCount === 0) {
      throw new Error("O PDF não contém páginas.");
    }

    let shapeId = 1;
    const pages: Array<{ width: number; height: number; drawings: string[] }> = [];

    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i) as PDFPage;
      const bounds = page.getBounds();
      const width = bounds[2] - bounds[0];
      const height = bounds[3] - bounds[1];
      const drawings: string[] = [];

      for (const shape of extractShapes(mupdf, page)) {
        drawings.push(shapeRectXml(shape, shapeId++));
      }
      for (const span of mergeSpans(extractSpans(page))) {
        drawings.push(textboxXml(span, shapeId++));
      }

      pages.push({ width, height, drawings });
    }

    return packDocx(buildDocumentXml(pages));
  } finally {
    doc.destroy?.();
  }
}
