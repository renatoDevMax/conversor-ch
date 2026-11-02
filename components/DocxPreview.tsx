"use client";

import { useEffect, useState } from "react";
import { TimeModal } from "@/components/TimeModal";
import {
  chprAfterEdit,
  formatDuration,
  isPunchHeader,
  parseDuration,
  parseTime,
  type ParsedTime,
  type TimeEdit,
} from "@/lib/editTimeCell";

type PreviewPhase = "loading" | "ready" | "error";

type EditingTime = ParsedTime & {
  cell: HTMLTableCellElement;
  sheet: number;
  row: number;
  col: number;
};

type DocxPreviewProps = {
  data: Uint8Array;
  onTimeEdited?: (edits: TimeEdit[]) => Promise<void> | void;
};

const PUNCH_NAMES = ["E1", "S1", "E2", "S2", "E3", "S3", "E4", "S4"];

type CellUpdate = {
  cell: HTMLTableCellElement;
  text: string;
  row: number;
  col: number;
};

function fitPages(host: HTMLElement) {
  const available = host.clientWidth;
  if (available <= 0) return;

  host.querySelectorAll<HTMLElement>("section.docx").forEach((page) => {
    page.style.zoom = "1";
    const width = page.getBoundingClientRect().width;
    page.style.zoom = width > available ? String(available / width) : "1";
  });
}

function cellLabel(cell: HTMLTableCellElement): string {
  return cell.innerText.replace(/\s+/g, " ").trim();
}

function markTimeCells(host: HTMLElement) {
  let sheet = 0;

  host.querySelectorAll("table").forEach((table) => {
    const rows = [...table.rows];
    const headerIndex = rows.findIndex((row) => [...row.cells].some((cell) => cellLabel(cell) === "E1"));
    if (headerIndex < 0) return;

    const punchCols = [...rows[headerIndex].cells]
      .map((cell, index) => (isPunchHeader(cellLabel(cell)) ? index : -1))
      .filter((index) => index >= 0);

    rows.forEach((row, rowIndex) => {
      if (rowIndex === headerIndex) return;
      punchCols.forEach((col) => {
        const cell = row.cells[col];
        if (!cell || !parseTime(cell.innerText)) return;
        cell.classList.add("time-cell");
        cell.dataset.sheet = String(sheet);
        cell.dataset.row = String(rowIndex);
        cell.dataset.col = String(col);
        cell.tabIndex = 0;
        cell.setAttribute("role", "button");
        cell.title = "Editar horário";
      });
    });

    sheet += 1;
  });
}

function timesheetTables(host: HTMLElement): HTMLTableElement[] {
  return [...host.querySelectorAll("table")].filter((table) =>
    [...table.rows].some((row) => [...row.cells].some((cell) => cellLabel(cell) === "E1")),
  );
}

function chprUpdates(
  table: HTMLTableElement,
  rowIndex: number,
  editedCol: number,
  newText: string,
): CellUpdate[] {
  const rows = [...table.rows];
  const headerIndex = rows.findIndex((row) => [...row.cells].some((cell) => cellLabel(cell) === "E1"));
  if (headerIndex < 0) return [];

  const columnOf = new Map<string, number>();
  [...rows[headerIndex].cells].forEach((cell, index) => columnOf.set(cellLabel(cell), index));
  const chprCol = columnOf.get("CHPr");
  if (chprCol == null) return [];

  const before = PUNCH_NAMES.map((name) => {
    const column = columnOf.get(name);
    return column == null ? "" : cellLabel(rows[rowIndex].cells[column]);
  });
  const after = before.map((value, index) => (columnOf.get(PUNCH_NAMES[index]) === editedCol ? newText : value));
  const dayCell = rows[rowIndex].cells[chprCol];
  if (!dayCell) return [];

  const current = cellLabel(dayCell);
  const next = chprAfterEdit(before, after, current);
  const updates: CellUpdate[] = [];
  if (next !== current) updates.push({ cell: dayCell, text: next, row: rowIndex, col: chprCol });

  const delta = (parseDuration(next) ?? 0) - (parseDuration(current) ?? 0);
  if (delta === 0) return updates;

  const totalsIndex = rows.findIndex((row, index) => {
    if (index <= headerIndex || index === rowIndex) return false;
    return !/^\d{2}\/\d{2}\/\d{4}/.test(cellLabel(row.cells[0]));
  });
  const totalCell = totalsIndex < 0 ? undefined : rows[totalsIndex].cells[chprCol];
  const totalMinutes = totalCell ? parseDuration(cellLabel(totalCell)) : null;
  if (!totalCell || totalMinutes == null) return updates;

  const updated = formatDuration(totalMinutes + delta);
  if (updated !== cellLabel(totalCell)) {
    updates.push({ cell: totalCell, text: updated, row: totalsIndex, col: chprCol });
  }
  return updates;
}

function applyTimeText(cell: HTMLTableCellElement, text: string) {
  const spans = [...cell.querySelectorAll("span")];
  if (spans.length > 0) {
    spans[0].textContent = text;
    spans.slice(1).forEach((span) => span.remove());
  } else {
    const paragraph = cell.querySelector("p");
    if (paragraph) paragraph.textContent = text;
    else cell.textContent = text;
  }
  cell.classList.add("time-edited");
}

function editingFromCell(cell: HTMLTableCellElement): EditingTime | null {
  const parsed = parseTime(cell.innerText);
  if (!parsed) return null;
  return {
    cell,
    sheet: Number(cell.dataset.sheet),
    row: Number(cell.dataset.row),
    col: Number(cell.dataset.col),
    ...parsed,
  };
}

export function DocxPreview({ data, onTimeEdited }: DocxPreviewProps) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<PreviewPhase>("loading");
  const [editing, setEditing] = useState<EditingTime | null>(null);

  useEffect(() => {
    if (!host) return;

    const root = host;
    let cancelled = false;
    setPhase("loading");
    setEditing(null);
    root.replaceChildren();

    function openCell(target: EventTarget | null) {
      if (!(target instanceof Element)) return;
      const cell = target.closest("td.time-cell");
      if (!(cell instanceof HTMLTableCellElement) || !root.contains(cell)) return;
      const next = editingFromCell(cell);
      if (next) setEditing(next);
    }

    function onClick(event: MouseEvent) {
      openCell(event.target);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (!(event.target instanceof HTMLTableCellElement)) return;
      if (!event.target.classList.contains("time-cell")) return;
      event.preventDefault();
      openCell(event.target);
    }

    root.addEventListener("click", onClick);
    root.addEventListener("keydown", onKeyDown);

    (async () => {
      try {
        const { renderAsync } = await import("docx-preview");
        if (cancelled) return;
        await renderAsync(data, root, undefined, {
          className: "docx",
          inWrapper: true,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          experimental: true,
          useBase64URL: true,
        });
        if (cancelled) return;
        markTimeCells(root);
        fitPages(root);
        setPhase("ready");
      } catch {
        if (!cancelled) setPhase("error");
      }
    })();

    const onResize = () => fitPages(root);
    window.addEventListener("resize", onResize);

    return () => {
      cancelled = true;
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [data, host]);

  async function confirmTime(text: string) {
    if (!editing || !host) return;
    const table = timesheetTables(host)[editing.sheet];
    const related = table ? chprUpdates(table, editing.row, editing.col, text) : [];
    await onTimeEdited?.([
      { sheet: editing.sheet, row: editing.row, col: editing.col, text },
      ...related.map((item) => ({
        sheet: editing.sheet,
        row: item.row,
        col: item.col,
        text: item.text,
      })),
    ]);
    applyTimeText(editing.cell, text);
    related.forEach((item) => applyTimeText(item.cell, item.text));
    setEditing(null);
  }

  return (
    <div className="docx-stage">
      {phase === "loading" && (
        <p className="home-loading-text" role="status">
          Abrindo o documento...
        </p>
      )}
      {phase === "error" && (
        <p className="home-error" role="alert">
          Não consegui mostrar o documento aqui. O download continua disponível.
        </p>
      )}
      <div ref={setHost} className="docx-preview" />
      {editing && (
        <TimeModal
          key={`${editing.sheet}-${editing.row}-${editing.col}-${editing.hour}${editing.minute}${editing.marker}`}
          hour={editing.hour}
          minute={editing.minute}
          marker={editing.marker}
          onCancel={() => setEditing(null)}
          onConfirm={confirmTime}
        />
      )}
    </div>
  );
}
