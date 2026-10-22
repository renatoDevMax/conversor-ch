"use client";

import { renderAsync } from "docx-preview";
import { useRef, useState } from "react";

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  function handleSelectClick() {
    inputRef.current?.click();
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";

    if (!file) return;

    setFileName(file.name);
    setStatus("loading");
    setError(null);

    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      setDownloadUrl(null);
    }

    if (viewerRef.current) {
      viewerRef.current.innerHTML = "";
    }

    try {
      // Conversion runs in the browser (no Python / Vercel serverless Python).
      const { convertPdfToDocx } = await import("@/lib/convertPdfToDocx");
      const pdfBytes = new Uint8Array(await file.arrayBuffer());
      const docxBytes = await convertPdfToDocx(pdfBytes);
      const convertedName = file.name.replace(/\.pdf$/i, "") + ".docx";

      setFileName(convertedName);

      const docxCopy = new Uint8Array(docxBytes);
      const blob = new Blob([docxCopy], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      setDownloadUrl(URL.createObjectURL(blob));

      if (!viewerRef.current) {
        throw new Error("Área de visualização indisponível.");
      }

      await renderAsync(docxCopy.buffer, viewerRef.current, undefined, {
        className: "docx",
        inWrapper: true,
        breakPages: true,
        renderHeaders: true,
        renderFooters: true,
      });

      setStatus("ready");
    } catch (err) {
      setStatus("error");
      setError(
        err instanceof Error ? err.message : "Não foi possível converter o PDF.",
      );
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center px-6 py-10">
      <main className="flex w-full max-w-5xl flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Converter PDF em Word
          </h1>
          <p className="max-w-xl text-sm text-zinc-600 dark:text-zinc-400">
            Converte o PDF em Word editável com o mesmo layout, já sem os
            sublinhados dos horários. Use &quot;Baixar Word&quot; para abrir no
            Microsoft Word.
          </p>

          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={handleFileChange}
          />

          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={handleSelectClick}
              disabled={status === "loading"}
              className="rounded-lg bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {status === "loading" ? "Convertendo..." : "Selecionar PDF"}
            </button>

            {downloadUrl && fileName && (
              <a
                href={downloadUrl}
                download={fileName}
                className="rounded-lg border border-zinc-300 px-5 py-2.5 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
              >
                Baixar Word
              </a>
            )}
          </div>

          {fileName && (
            <p className="text-sm text-zinc-700 dark:text-zinc-300">
              {status === "ready" ? "Documento Word: " : "Arquivo: "}
              <span className="font-medium">{fileName}</span>
            </p>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div
          ref={viewerRef}
          className="docx-viewer w-full overflow-auto rounded-lg border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
          aria-live="polite"
        />
      </main>
    </div>
  );
}
