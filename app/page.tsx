"use client";

import { useRef, useState } from "react";

type Status = "idle" | "loading" | "ready" | "error";

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
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

    try {
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
      setStatus("ready");
    } catch (err) {
      setStatus("error");
      setError(
        err instanceof Error ? err.message : "Não foi possível converter o PDF.",
      );
    }
  }

  return (
    <div className="home-shell relative flex flex-1 flex-col overflow-hidden">
      <div className="home-aurora" aria-hidden />
      <div className="home-grid" aria-hidden />

      <main className="relative z-10 mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        <p className="home-brand">Removedor de Traços RM</p>
        <h1 className="home-title mt-4">
          PDF em Word editável,
          <span className="home-title-accent"> sem os traços</span>
        </h1>
        <p className="home-subtitle mt-4 max-w-lg">
          Selecione o espelho de ponto e baixe o Word com o mesmo layout, pronto
          para editar.
        </p>

        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={handleFileChange}
        />

        {status === "loading" && (
          <div className="home-loading mt-12" role="status" aria-live="polite">
            <div className="home-loading-ring" aria-hidden>
              <span />
              <span />
              <span />
            </div>
            <p className="home-loading-text">
              Já estou preparando esse arquivo pra voce
            </p>
            {fileName && <p className="home-file-name">{fileName}</p>}
          </div>
        )}

        {status !== "loading" && (
          <div className="mt-12 flex w-full flex-col items-center gap-4">
            {status === "ready" && downloadUrl && fileName ? (
              <>
                <p className="home-ready-label">Pronto para baixar</p>
                <p className="home-file-name">{fileName}</p>
                <div className="flex flex-wrap items-center justify-center gap-4">
                  <a
                    href={downloadUrl}
                    download={fileName}
                    className="neon-btn neon-btn-primary"
                  >
                    Baixar Word
                  </a>
                  <button
                    type="button"
                    onClick={handleSelectClick}
                    className="neon-btn neon-btn-ghost"
                  >
                    Selecionar outro
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                onClick={handleSelectClick}
                className="neon-btn neon-btn-primary"
              >
                Selecionar PDF
              </button>
            )}

            {error && (
              <p className="home-error" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
