"use client";

import { useEffect, useRef, useState } from "react";
import { DocxPreview } from "@/components/DocxPreview";
import type { TimeEdit } from "@/lib/editTimeCell";

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type Status = "idle" | "loading" | "ready" | "error";

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const downloadUrlRef = useRef<string | null>(null);
  const fileBytesRef = useRef<Uint8Array | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [docxBytes, setDocxBytes] = useState<Uint8Array | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
    };
  }, []);

  function publishDownload(bytes: Uint8Array) {
    if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
    const url = URL.createObjectURL(new Blob([bytes.slice()], { type: DOCX_TYPE }));
    downloadUrlRef.current = url;
    setDownloadUrl(url);
  }

  function handleSelectClick() {
    inputRef.current?.click();
  }

  async function handleDownloadPdf() {
    if (!fileBytesRef.current || !fileName || pdfBusy) return;
    setPdfBusy(true);
    setError(null);
    try {
      const pdfName = /\.docx$/i.test(fileName) ? fileName.replace(/\.docx$/i, ".pdf") : `${fileName}.pdf`;
      const response = await fetch("/api/docx-to-pdf", {
        method: "POST",
        headers: { "Content-Type": DOCX_TYPE },
        body: new Blob([fileBytesRef.current.slice()], { type: DOCX_TYPE }),
      });
      if (!response.ok) {
        throw new Error((await response.text()) || "Não foi possível gerar o PDF.");
      }
      const url = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = pdfName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível gerar o PDF.");
    } finally {
      setPdfBusy(false);
    }
  }

  async function handleTimeEdited(edits: TimeEdit[]) {
    if (!fileBytesRef.current || edits.length === 0) return;
    const { replaceTimeCells } = await import("@/lib/editTimeCell");
    const next = await replaceTimeCells(fileBytesRef.current, edits);
    fileBytesRef.current = next;
    publishDownload(next);
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";

    if (!file) return;

    setFileName(file.name);
    setStatus("loading");
    setError(null);

    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
      setDownloadUrl(null);
    }
    setDocxBytes(null);
    setPdfBusy(false);
    fileBytesRef.current = null;

    try {
      const { convertPdfToDocx } = await import("@/lib/convertPdfToDocx");
      const pdfBytes = new Uint8Array(await file.arrayBuffer());
      const converted = await convertPdfToDocx(pdfBytes);
      const convertedName = file.name.replace(/\.pdf$/i, "") + ".docx";
      const bytes = new Uint8Array(converted);

      setFileName(convertedName);
      fileBytesRef.current = bytes;
      setDocxBytes(bytes);
      publishDownload(bytes);
      setStatus("ready");
    } catch (err) {
      setStatus("error");
      setError(
        err instanceof Error ? err.message : "Não foi possível converter o PDF.",
      );
    }
  }

  return (
    <div className="home-shell relative flex flex-1 flex-col overflow-x-clip">
      <main
        className={`relative z-10 mx-auto flex w-full flex-1 flex-col items-center px-6 py-16 text-center ${status === "ready" ? "max-w-5xl justify-start" : "max-w-3xl justify-center"}`}
      >
        <h1 className="home-title">Conversor de PDF</h1>

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
          <div className="mt-6 flex w-full flex-col items-center gap-4">
            {status === "ready" && downloadUrl && fileName && docxBytes ? (
              <>
                <p className="home-ready-label">Documento na tela</p>
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
                    onClick={handleDownloadPdf}
                    disabled={pdfBusy}
                    className="neon-btn neon-btn-primary"
                    aria-busy={pdfBusy}
                  >
                    {pdfBusy ? "Gerando PDF..." : "Baixar PDF"}
                  </button>
                  <button
                    type="button"
                    onClick={handleSelectClick}
                    className="neon-btn neon-btn-ghost"
                  >
                    Selecionar outro
                  </button>
                </div>
                <DocxPreview data={docxBytes} onTimeEdited={handleTimeEdited} />
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
