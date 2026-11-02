const PUNCH_HEADERS = new Set(["E1", "S1", "E2", "S2", "E3", "S3", "E4", "S4"]);

export const TIME_MARKERS = [
  { value: "", label: "Nenhum" },
  { value: "⁰", label: "0" },
  { value: "¹", label: "1" },
  { value: "²", label: "2" },
  { value: "³", label: "3" },
  { value: "⁴", label: "4" },
  { value: "⁵", label: "5" },
] as const;

export type TimeMarker = (typeof TIME_MARKERS)[number]["value"];

export type ParsedTime = {
  hour: string;
  minute: string;
  marker: TimeMarker;
};

export type TimeEdit = {
  sheet: number;
  row: number;
  col: number;
  text: string;
};

const TIME_PATTERN = /^(\d{2}):(\d{2})(?:\s*([⁰¹²³⁴⁵°]))?$/;
const DURATION_PATTERN = /^(\d{1,4}):(\d{2})$/;
const PUNCH_PAIRS = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
] as const;

export function parseTime(raw: string): ParsedTime | null {
  const text = raw.replace(/\s+/g, " ").trim();
  const match = text.match(TIME_PATTERN);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;

  const symbol = match[3] ?? "";
  const marker = TIME_MARKERS.find((item) => item.value !== "" && item.value === symbol)?.value ?? "";

  return { hour: match[1], minute: match[2], marker };
}

export function formatTime(hour: string, minute: string, marker: TimeMarker): string {
  return marker ? `${hour}:${minute} ${marker}` : `${hour}:${minute}`;
}

function clockMinutes(value: ParsedTime): number {
  return Number(value.hour) * 60 + Number(value.minute);
}

export function pairMinutes(entry: string, exit: string): number {
  const start = parseTime(entry);
  const end = parseTime(exit);
  if (!start || !end) return 0;
  let from = clockMinutes(start);
  let to = clockMinutes(end);
  if (to < from) to += 24 * 60;
  return to - from;
}

export function parseDuration(raw: string): number | null {
  const match = raw.replace(/\s+/g, " ").trim().match(DURATION_PATTERN);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatDuration(totalMinutes: number): string {
  const sign = totalMinutes < 0 ? "-" : "";
  const absolute = Math.abs(totalMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function chprFromPunches(punches: string[]): string {
  let total = 0;
  for (const [entry, exit] of PUNCH_PAIRS) {
    total += pairMinutes(punches[entry] ?? "", punches[exit] ?? "");
  }
  return formatDuration(total);
}

export function chprAfterEdit(punchesBefore: string[], punchesAfter: string[], currentChpr: string): string {
  const changed = PUNCH_PAIRS.some(([entry, exit]) => {
    const before = pairMinutes(punchesBefore[entry] ?? "", punchesBefore[exit] ?? "");
    const after = pairMinutes(punchesAfter[entry] ?? "", punchesAfter[exit] ?? "");
    return before !== after;
  });
  return changed ? chprFromPunches(punchesAfter) : currentChpr;
}

export function isPunchHeader(text: string): boolean {
  return PUNCH_HEADERS.has(text.replace(/\s+/g, " ").trim());
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function plainCell(cell: string): string {
  return [...cell.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
    .map((match) => match[1])
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function writeCellText(cell: string, text: string): string {
  const escaped = escapeXml(text);
  let used = false;
  const next = cell.replace(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g, (node) => {
    if (used) return node.replace(/>[^<]*</, "><");
    used = true;
    return `<w:t xml:space="preserve">${escaped}</w:t>`;
  });
  if (used) return next;
  return cell.replace(
    /<\/w:p>/,
    `<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t xml:space="preserve">${escaped}</w:t></w:r></w:p>`,
  );
}

export function patchDocumentXml(xml: string, edits: TimeEdit[]): string {
  let sheet = 0;

  return xml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, (table) => {
    const rows = [...table.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((match) => match[0]);
    const isSheet = rows.some((row) =>
      [...row.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].some((cell) => plainCell(cell[0]) === "E1"),
    );
    if (!isSheet) return table;

    const index = sheet;
    sheet += 1;
    const pending = edits.filter((edit) => edit.sheet === index);
    if (pending.length === 0) return table;

    let rowIndex = 0;
    return table.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (row) => {
      const currentRow = rowIndex;
      rowIndex += 1;
      const rowEdits = pending.filter((edit) => edit.row === currentRow);
      if (rowEdits.length === 0) return row;

      let colIndex = 0;
      return row.replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, (cell) => {
        const currentCol = colIndex;
        colIndex += 1;
        const edit = rowEdits.find((item) => item.col === currentCol);
        return edit ? writeCellText(cell, edit.text) : cell;
      });
    });
  });
}

export async function replaceTimeCells(docx: Uint8Array, edits: TimeEdit[]): Promise<Uint8Array> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(docx);
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("Não encontrei o documento do Word.");

  const xml = await file.async("string");
  zip.file("word/document.xml", patchDocumentXml(xml, edits));
  return zip.generateAsync({ type: "uint8array" }) as Promise<Uint8Array>;
}
