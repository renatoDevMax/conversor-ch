import JSZip from "jszip";
import type { PDFPage } from "mupdf";
import { loadMupdf } from "@/lib/loadMupdf";

const ROW_BAND = 4;
const PAGE_MARGIN = 28;
const SIGN_X = 321.5;
const SIGN_WIDTH = 246;
const PAGE_RIGHT = 26;
const PAGE_TOP = 28;
const TICK_X = 140;
const RIGHT_COL_X = 450;
const TITLE_ROW = 14;
const SUB_ROW = 14;
const BAR_ROW = 7;
const BODY_TOP = PAGE_TOP + TITLE_ROW + SUB_ROW + BAR_ROW;

type RGB = [number, number, number];

type Glyph = {
  c: string;
  x0: number;
  x1: number;
  y0: number;
  baseline: number;
  size: number;
  bold: boolean;
  color: RGB;
};

type RichCell = {
  x0: number;
  x1: number;
  glyphs: Glyph[];
};

type VisualLine = {
  y: number;
  cells: RichCell[];
};

type TextRun = {
  text: string;
  size: number;
  bold: boolean;
  color: RGB;
  baseline: number;
};

function tw(points: number): number {
  return Math.round(points * 20);
}

function rgbHex(color: RGB): string {
  return color
    .map((channel) => Math.max(0, Math.min(255, channel)).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function cleanText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function toRgb(color: ArrayLike<number> | undefined | null): RGB | null {
  if (!color || color.length === 0) return null;
  const scale = Math.max(...Array.from(color)) <= 1;
  const channel = (value: number) => Math.round(scale ? value * 255 : value);
  if (color.length === 1) {
    const gray = channel(color[0]);
    return [gray, gray, gray];
  }
  if (color.length < 3) return null;
  return [channel(color[0]), channel(color[1]), channel(color[2])];
}

function cellText(cell: RichCell): string {
  return cell.glyphs
    .map((glyph) => glyph.c)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function lineText(line: VisualLine): string {
  return line.cells.map(cellText).join(" ");
}

function yOf(cell: RichCell): number {
  return Math.min(...cell.glyphs.map((glyph) => glyph.y0));
}

function regroup(lines: VisualLine[], band: number): VisualLine[] {
  const sorted = lines
    .flatMap((line) => line.cells)
    .sort((a, b) => yOf(a) - yOf(b) || a.x0 - b.x0);
  const rows: VisualLine[] = [];

  for (const cell of sorted) {
    const y = yOf(cell);
    const row = rows.at(-1);
    if (row && y - row.y <= band) {
      row.cells.push(cell);
      continue;
    }
    rows.push({ y, cells: [cell] });
  }

  for (const row of rows) row.cells.sort((a, b) => a.x0 - b.x0);
  return rows;
}

function cellFromSpan(glyphs: Glyph[]): RichCell | null {
  const ordered = [...glyphs].sort((a, b) => a.x0 - b.x0);
  const compact: Glyph[] = [];
  for (const glyph of ordered) {
    const prev = compact.at(-1);
    // QuickReports paints the same glyph twice. The second copy overlaps the first.
    if (prev && glyph.x0 < prev.x1 - 0.5) continue;
    compact.push(glyph);
  }

  while (compact.length > 0 && !compact[0].c.trim()) compact.shift();
  while (compact.length > 0 && !compact.at(-1)!.c.trim()) compact.pop();
  if (compact.length === 0) return null;

  return {
    x0: Math.min(...compact.map((glyph) => glyph.x0)),
    x1: Math.max(...compact.map((glyph) => glyph.x1)),
    glyphs: compact,
  };
}

function extractRows(page: PDFPage): VisualLine[] {
  const stext = page.toStructuredText("preserve-spans");
  const spans: Array<RichCell & { y: number }> = [];
  let current: Glyph[] = [];

  try {
    stext.walk({
      beginLine() {
        current = [];
      },
      onChar(c, origin, font, size, quad, color) {
        if (!c || quad.length < 8) return;
        const xs = [quad[0], quad[2], quad[4], quad[6]];
        const ys = [quad[1], quad[3], quad[5], quad[7]];
        const fontName = typeof font?.getName === "function" ? font.getName() : "";
        current.push({
          c,
          x0: Math.min(...xs),
          x1: Math.max(...xs),
          y0: Math.min(...ys),
          baseline: origin[1],
          size,
          bold: /bold/i.test(fontName),
          color: toRgb(color) ?? [0, 0, 0],
        });
      },
      endLine() {
        const cell = cellFromSpan(current);
        if (!cell) return;
        spans.push({ ...cell, y: Math.min(...cell.glyphs.map((glyph) => glyph.y0)) });
        current = [];
      },
    });
  } finally {
    stext.destroy?.();
  }

  const ordered = spans.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const rows: Array<{ y: number; cells: RichCell[] }> = [];

  for (const span of ordered) {
    const row = rows.at(-1);
    if (row && span.y - row.y <= ROW_BAND) {
      row.cells.push(span);
      continue;
    }
    rows.push({ y: span.y, cells: [span] });
  }

  return rows
    .map((row) => {
      const cells = row.cells
        .sort((a, b) => a.x0 - b.x0)
        .filter((cell, index, all) => {
          const prev = all[index - 1];
          if (!prev) return true;
          return !(Math.abs(cell.x0 - prev.x0) < 0.8 && cellText(cell) === cellText(prev));
        });
      return { y: row.y, cells };
    })
    .filter((line) => line.cells.length > 0);
}

function canMerge(run: TextRun, glyph: Glyph): boolean {
  return (
    run.bold === glyph.bold &&
    Math.abs(run.size - glyph.size) < 0.2 &&
    run.color[0] === glyph.color[0] &&
    run.color[1] === glyph.color[1] &&
    run.color[2] === glyph.color[2]
  );
}

function cellRuns(cell: RichCell): TextRun[] {
  const glyphs = [...cell.glyphs];
  while (glyphs.length > 0 && !glyphs[0].c.trim()) glyphs.shift();
  while (glyphs.length > 0 && !glyphs.at(-1)!.c.trim()) glyphs.pop();

  const runs: TextRun[] = [];
  for (const glyph of glyphs) {
    const text = cleanText(glyph.c);
    if (!text) continue;
    const current = runs.at(-1);
    if (current && canMerge(current, glyph)) {
      current.text += text;
      continue;
    }
    runs.push({
      text,
      size: glyph.size,
      bold: glyph.bold,
      color: glyph.color,
      baseline: glyph.baseline,
    });
  }
  return runs.filter((run) => run.text.length > 0);
}

function runXml(run: TextRun): string {
  const size = Math.max(Math.round(run.size * 2), 12);
  const bold = run.bold ? "<w:b/>" : "";
  return `<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:color w:val="${rgbHex(run.color)}"/>${bold}</w:rPr><w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`;
}

function runsXml(cells: RichCell[]): string {
  const parts: string[] = [];
  for (const cell of cells) {
    const runs = cellRuns(cell);
    if (runs.length === 0) continue;
    if (parts.length > 0) {
      parts.push(runXml({ ...runs[0], text: " ", bold: false }));
    }
    parts.push(runs.map(runXml).join(""));
  }
  return parts.join("");
}

function isGridHeader(line: VisualLine): boolean {
  const texts = line.cells.map(cellText);
  return texts.includes("E1") && texts.some((text) => text.startsWith("Per"));
}

function isFooter(line: VisualLine): boolean {
  const text = lineText(line);
  return text.startsWith("Marcações") || text.startsWith("Sistema em Conformidade");
}

function isDayRow(cells: RichCell[][]): boolean {
  return /^\d{2}\/\d{2}\/\d{4}/.test(cellText(cells[0]?.[0] ?? { x0: 0, x1: 0, glyphs: [] }));
}

function columnOf(x: number, xs: number[]): number {
  let index = 0;
  for (let i = 0; i < xs.length; i++) {
    if (x + 3 >= xs[i]) index = i;
  }
  return index;
}

function columnWidths(xs: number[], right: number): number[] {
  return xs.map((x, index) => Math.max(tw((xs[index + 1] ?? right) - x), 240));
}

function bucketLine(line: VisualLine, xs: number[]): RichCell[][] {
  const buckets: RichCell[][] = xs.map(() => []);
  for (const cell of line.cells) buckets[columnOf(cell.x0, xs)].push(cell);
  return buckets;
}

const NIL_BORDERS = `<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>`;
const BAR_COLOR = "D9D9D9";

type CellEdges = {
  top?: boolean;
  bottom?: boolean;
  right?: boolean;
  rightColor?: string;
};

function tableXml(widths: number[], rows: string[], cellMar = 20, indent = 0): string {
  const total = widths.reduce((sum, width) => sum + width, 0);
  const grid = widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:jc w:val="left"/><w:tblInd w:w="${indent}" w:type="dxa"/>${NIL_BORDERS}<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="${cellMar}" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="${cellMar}" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows.join("")}</w:tbl>`;
}

function edgeXml(edge: string, on: boolean, color: string): string {
  if (!on) return `<w:${edge} w:val="nil"/>`;
  return `<w:${edge} w:val="single" w:sz="8" w:space="0" w:color="${color}"/>`;
}

function cellXml(
  width: number,
  body: string,
  fill: string | null,
  edges: CellEdges | null,
  noWrap: boolean,
  span = 1,
): string {
  const shade = fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : "";
  const border = edges
    ? `<w:tcBorders>${edgeXml("top", Boolean(edges.top), "000000")}${edgeXml("left", false, "000000")}${edgeXml("bottom", Boolean(edges.bottom), "000000")}${edgeXml("right", Boolean(edges.right), edges.rightColor ?? BAR_COLOR)}</w:tcBorders>`
    : "";
  const wrap = noWrap ? "<w:noWrap/>" : "";
  const gridSpan = span > 1 ? `<w:gridSpan w:val="${span}"/>` : "";
  const content = body || `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr></w:p>`;
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${gridSpan}${border}${shade}${wrap}<w:vAlign w:val="center"/></w:tcPr>${content}</w:tc>`;
}

function cellParagraph(runs: string): string {
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="0" w:right="0"/></w:pPr>${runs}</w:p>`;
}

function gridParagraph(runs: string, line: number): string {
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="${line}" w:lineRule="exact"/><w:ind w:left="0" w:right="0"/></w:pPr>${runs}</w:p>`;
}

function gridTable(lines: VisualLine[], pageRight: number): string {
  const xs = lines[0].cells.map((cell) => cell.x0);
  const widths = columnWidths(xs, pageRight);
  let day = 0;
  const headerLine = 320;
  const bodyLine = 272;

  const rows = lines.map((line, index) => {
    const buckets = bucketLine(line, xs);
    const dayRow = index > 0 && isDayRow(buckets);
    const fill = index === 0 ? BAR_COLOR : dayRow && day % 2 === 0 ? "E3E3E3" : null;
    if (dayRow) day += 1;
    const height = index === 0 ? headerLine : bodyLine;

    const cells = buckets.map((bucket, column) =>
      cellXml(widths[column], gridParagraph(runsXml(bucket), height), fill, null, true),
    );
    return `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${height}" w:hRule="exact"/></w:trPr>${cells.join("")}</w:tr>`;
  });

  return tableXml(widths, rows, 0, Math.max(0, tw(xs[0] - PAGE_MARGIN)));
}

function employeeBuckets(line: VisualLine, xs: number[]): RichCell[][] {
  if (line.cells.length <= 2) {
    const buckets: RichCell[][] = xs.map(() => []);
    line.cells.forEach((cell, index) => {
      if (buckets[index]) buckets[index].push(cell);
    });
    return buckets;
  }
  return bucketLine(line, xs);
}

function employeeTable(lines: VisualLine[], pageRight: number): string {
  const model = lines.reduce((best, line) => (line.cells.length > best.cells.length ? line : best));
  const xs = model.cells.map((cell) => cell.x0);
  const widths = columnWidths(xs, pageRight);

  const rows = lines.map((line) => {
    const buckets = employeeBuckets(line, xs);
    const cells = buckets.map((bucket, column) =>
      cellXml(widths[column], cellParagraph(runsXml(bucket)), null, null, false),
    );
    return `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="260" w:hRule="exact"/></w:trPr>${cells.join("")}</w:tr>`;
  });

  return tableXml(widths, rows, 0);
}

function contentWidths(contentRight: number): number[] {
  const total = tw(contentRight - PAGE_MARGIN);
  const left = tw(TICK_X - PAGE_MARGIN);
  const right = tw(Math.max(90, contentRight - RIGHT_COL_X));
  return [left, Math.max(total - left - right, 400), right];
}

function bannerParagraph(runs: string, align: "left" | "right", indent: number, rightTab = 0): string {
  const tabs =
    align === "right" && rightTab > 0
      ? `<w:tabs><w:tab w:val="right" w:pos="${rightTab}"/></w:tabs>`
      : "";
  const ind = indent > 0 ? `<w:ind w:left="${indent}"/>` : "";
  const lead = align === "right" ? "<w:r><w:tab/></w:r>" : "";
  return `<w:p><w:pPr>${tabs}<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>${ind}<w:rPr><w:sz w:val="2"/></w:rPr></w:pPr>${lead}${runs}</w:p>`;
}

function bannerSlots(rows: VisualLine[]): Array<[RichCell[], RichCell[], RichCell[]]> {
  if (rows.length === 0) return [];
  const cut = rows[0].y + 8;
  const bands = [rows.filter((row) => row.y < cut), rows.filter((row) => row.y >= cut)].filter(
    (band) => band.length > 0,
  );

  return bands.map((band) => {
    const slots: [RichCell[], RichCell[], RichCell[]] = [[], [], []];
    for (const row of band) {
      for (const cell of row.cells) {
        const slot = cell.x0 >= RIGHT_COL_X - 30 ? 2 : cell.x0 >= TICK_X - 10 ? 1 : 0;
        slots[slot].push(cell);
      }
    }
    return slots;
  });
}

function bannerTable(rows: VisualLine[], contentRight: number): string {
  const widths = contentWidths(contentRight);
  const total = widths.reduce((sum, width) => sum + width, 0);
  const bands = bannerSlots(rows);
  const title = bands[0] ?? [[], [], []];
  const subtitle = bands[1] ?? [[], [], []];

  const textRow = (slots: [RichCell[], RichCell[], RichCell[]], height: number, tick: boolean) => {
    const cells = slots.map((slot, index) => {
      const indent = index === 1 && slot[0] ? Math.max(0, tw(slot[0].x0 - TICK_X)) : 0;
      const align = index === 2 ? "right" : "left";
      return cellXml(
        widths[index],
        bannerParagraph(runsXml(slot), align, indent, widths[index]),
        null,
        tick ? { right: index === 0 } : null,
        true,
      );
    });
    return `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${tw(height)}" w:hRule="exact"/></w:trPr>${cells.join("")}</w:tr>`;
  };

  const bar = `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${tw(BAR_ROW)}" w:hRule="exact"/></w:trPr>${cellXml(total, "", BAR_COLOR, null, true, 3)}</w:tr>`;
  return tableXml(widths, [textRow(title, TITLE_ROW, true), textRow(subtitle, SUB_ROW, true), bar], 0);
}

function companyBuckets(line: VisualLine): RichCell[][] {
  const buckets: RichCell[][] = [[], [], [], []];
  for (const cell of line.cells) {
    const index = cell.x0 >= 250 ? 3 : cell.x0 >= 200 ? 2 : cell.x0 >= 70 ? 1 : 0;
    buckets[index].push(cell);
  }
  return buckets;
}

function companyTable(lines: VisualLine[], contentRight: number): string {
  const total = tw(contentRight - PAGE_MARGIN);
  const widths = [tw(53), tw(151), tw(29), total - tw(53) - tw(151) - tw(29)];
  const rows = lines.map((line, index) => {
    const last = index === lines.length - 1;
    const cells = companyBuckets(line).map((bucket, column) =>
      cellXml(widths[column], cellParagraph(runsXml(bucket)), null, last ? { bottom: true } : null, true),
    );
    return `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="260" w:hRule="exact"/></w:trPr>${cells.join("")}</w:tr>`;
  });
  return tableXml(widths, rows, 0);
}

function spacer(twips: number): string {
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="${twips}" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>`;
}

function introParagraph(line: VisualLine, pageBreak: boolean, after = 0): string {
  const [first, ...rest] = line.cells;
  const tabs: number[] = [];
  const parts = [runsXml([first])];
  let previous = first;

  for (const cell of rest) {
    const pos = tw(cell.x0 - PAGE_MARGIN);
    const indent = tw(Math.max(0, first.x0 - PAGE_MARGIN));
    if (cell.x0 - previous.x1 >= 2 && pos > (tabs.at(-1) ?? indent)) {
      tabs.push(pos);
      parts.push("<w:r><w:tab/></w:r>");
      parts.push(runsXml([cell]));
    } else {
      parts.push(runsXml([cell]));
    }
    previous = cell;
  }

  const tabXml =
    tabs.length > 0
      ? `<w:tabs>${tabs.map((pos) => `<w:tab w:val="left" w:pos="${pos}"/>`).join("")}</w:tabs>`
      : "";
  const breakXml = pageBreak ? "<w:pageBreakBefore/>" : "";
  const indent = tw(Math.max(0, first.x0 - PAGE_MARGIN));

  return `<w:p><w:pPr>${breakXml}<w:spacing w:before="60" w:after="${after}" w:line="240" w:lineRule="auto"/><w:ind w:left="${indent}" w:right="0"/>${tabXml}</w:pPr>${parts.join("")}</w:p>`;
}

function isSignatureLine(line: VisualLine): boolean {
  return line.cells.some((cell) => cell.x0 >= SIGN_X - 20);
}

function tightParagraph(runs: string, align: "left" | "center"): string {
  const jc = align === "center" ? `<w:jc w:val="center"/>` : "";
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="160" w:lineRule="exact"/>${jc}</w:pPr>${runs}</w:p>`;
}

function signatureBlock(note: VisualLine | null, line: VisualLine, contentRight: number): string {
  const right = tw(SIGN_WIDTH);
  const left = Math.max(tw(contentRight - PAGE_MARGIN) - right, tw(200));
  const notes = line.cells.filter((cell) => cell.x0 < SIGN_X - 20);
  const name = line.cells.filter((cell) => cell.x0 >= SIGN_X - 20);
  const row = (height: number, leftRuns: string, rightRuns: string, align: "left" | "center", lineOnRight: boolean) =>
    `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${height}" w:hRule="exact"/></w:trPr>${cellXml(left, tightParagraph(leftRuns, "left"), null, null, true)}${cellXml(right, tightParagraph(rightRuns, align), null, lineOnRight ? { top: true } : null, true)}</w:tr>`;
  const rows = [
    note ? row(200, runsXml(note.cells), "", "left", true) : "",
    row(200, runsXml(notes), runsXml(name), "center", note == null),
  ].filter(Boolean);
  return tableXml([left, right], rows, 0);
}

function footerXml(lines: VisualLine[], contentRight: number): string {
  const signAt = lines.findIndex(isSignatureLine);
  if (signAt < 0) return lines.map((line) => introParagraph(line, false)).join("");

  const head = lines.slice(0, signAt > 0 ? signAt - 1 : 0);
  const note = signAt > 0 ? lines[signAt - 1] : null;
  return [
    head.map((line) => introParagraph(line, false, 48)).join(""),
    signatureBlock(note, lines[signAt], contentRight),
    lines
      .slice(signAt + 1)
      .map((line) => introParagraph(line, false))
      .join(""),
  ].join("");
}

type PageOut = {
  width: number;
  height: number;
  body: string;
  header: string | null;
};

function startsWithLabel(line: VisualLine, label: string): boolean {
  return line.cells.some((cell) => cellText(cell).startsWith(label));
}

function pageParts(lines: VisualLine[], contentRight: number): { body: string; header: string | null } {
  const gridAt = lines.findIndex(isGridHeader);
  if (gridAt < 0) {
    return { header: null, body: lines.map((line) => introParagraph(line, false)).join("") };
  }

  const footerAt = lines.findIndex((line, index) => index > gridAt && isFooter(line));
  const gridEnd = footerAt === -1 ? lines.length : footerAt;
  const employeeAt = lines.findIndex((line, index) => index < gridAt && startsWithLabel(line, "Funcionário"));
  const introEnd = employeeAt === -1 ? gridAt : employeeAt;
  const intro = regroup(lines.slice(0, introEnd), 2);
  const empresaAt = intro.findIndex((line) => startsWithLabel(line, "Empresa"));
  const employee = employeeAt === -1 ? [] : lines.slice(employeeAt, gridAt);
  const grid = lines.slice(gridAt, gridEnd);
  const footer = lines.slice(gridEnd);

  const header = empresaAt > 0 ? bannerTable(intro.slice(0, empresaAt), contentRight) : null;
  const company = empresaAt >= 0 ? intro.slice(empresaAt) : intro;

  const parts: string[] = [];
  if (!header && company.length > 0) {
    parts.push(company.map((line) => introParagraph(line, false)).join(""));
  } else if (company.length > 0) {
    parts.push(spacer(120));
    parts.push(companyTable(company, contentRight));
    parts.push(spacer(160));
  }
  if (employee.length > 0) parts.push(employeeTable(employee, contentRight));
  parts.push(spacer(40));
  parts.push(gridTable(grid, contentRight));
  if (footer.length > 0) {
    parts.push(spacer(200));
    parts.push(footerXml(footer, contentRight));
  }
  return { header, body: parts.join("") };
}

function sectionXml(page: PageOut, headerId: string | null): string {
  const header = headerId ? `<w:headerReference w:type="default" r:id="${headerId}"/>` : "";
  const top = headerId ? BODY_TOP : 36;
  const headerDistance = headerId ? PAGE_TOP : 0;
  return `<w:sectPr>${header}<w:type w:val="nextPage"/><w:pgSz w:w="${tw(page.width)}" w:h="${tw(page.height)}"/><w:pgMar w:top="${tw(top)}" w:right="${tw(PAGE_RIGHT)}" w:bottom="${tw(36)}" w:left="${tw(PAGE_MARGIN)}" w:header="${tw(headerDistance)}" w:footer="0" w:gutter="0"/></w:sectPr>`;
}

function buildDocumentXml(pages: PageOut[]): string {
  const chunks = pages.map((page, index) => {
    const headerId = page.header ? `rIdH${index + 1}` : null;
    const section = sectionXml(page, headerId);
    if (index === pages.length - 1) return `${page.body || "<w:p/>"}${section}`;
    return `${page.body || "<w:p/>"}<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="1" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr>${section}</w:pPr></w:p>`;
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${chunks.join("")}
  </w:body>
</w:document>`;
}

function headerXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${body}</w:hdr>`;
}

async function packDocx(pages: PageOut[]): Promise<Uint8Array> {
  const zip = new JSZip();
  const headerOverrides = pages
    .map((page, index) =>
      page.header
        ? `<Override PartName="/word/header${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>`
        : "",
    )
    .join("");
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  ${headerOverrides}
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
  word?.file("document.xml", buildDocumentXml(pages));
  word?.file(
    "styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>
        <w:sz w:val="16"/>
        <w:szCs w:val="16"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:before="0" w:after="0"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
  </w:style>
</w:styles>`,
  );

  const headerRels = pages
    .map((page, index) =>
      page.header
        ? `<Relationship Id="rIdH${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header${index + 1}.xml"/>`
        : "",
    )
    .join("");
  pages.forEach((page, index) => {
    if (page.header) word?.file(`header${index + 1}.xml`, headerXml(page.header));
  });
  word?.folder("_rels")?.file(
    "document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${headerRels}</Relationships>`,
  );

  return zip.generateAsync({ type: "uint8array" });
}

export async function convertPdfToDocx(pdfBytes: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const data = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  const doc = mupdf.Document.openDocument(data, "application/pdf");

  try {
    const pageCount = doc.countPages();
    if (pageCount === 0) throw new Error("O PDF não contém páginas.");

    const pages: PageOut[] = [];
    let textLines = 0;

    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      try {
        const bounds = page.getBounds();
        const width = bounds[2] - bounds[0];
        const lines = extractRows(page as PDFPage);
        textLines += lines.length;
        const parts = pageParts(lines, width - PAGE_RIGHT);
        pages.push({
          width,
          height: bounds[3] - bounds[1],
          body: parts.body,
          header: parts.header,
        });
      } finally {
        page.destroy?.();
      }
    }

    if (textLines === 0) {
      throw new Error("Não encontrei texto neste PDF. Arquivos só com imagem não viram texto editável.");
    }

    return packDocx(pages);
  } finally {
    doc.destroy?.();
  }
}
