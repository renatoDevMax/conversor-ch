import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const WORD_FORMAT_PDF = 17;

const SCRIPT = `
$ErrorActionPreference = "Stop"
$docx = (Resolve-Path $args[0]).Path
$pdf = $args[1]
$pidFile = $args[2]
if (Test-Path $pdf) { Remove-Item -Force $pdf }

$before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$word = New-Object -ComObject Word.Application
$after = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$created = @($after | Where-Object { $before -notcontains $_ })
Set-Content -Path $pidFile -Value ($created -join ",") -Encoding ascii

$previousAlerts = $word.DisplayAlerts
if ($created.Count -gt 0) { $word.Visible = $false }
$word.DisplayAlerts = 0

try {
  $doc = $word.Documents.Open($docx, $false, $true, $false)
  $doc.SaveAs2($pdf, ${WORD_FORMAT_PDF})
  $doc.Close($false)
} finally {
  if ($created.Count -eq 0) {
    $word.DisplayAlerts = $previousAlerts
  } else {
    try { $word.Quit() } catch {}
    foreach ($id in $created) {
      $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
      if ($proc) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    }
  }
}
`;

function stopRecordedWord(pidFile: string) {
  return readFile(pidFile, "utf8")
    .then((raw) => {
      const ids = raw.split(/[^0-9]+/).filter(Boolean);
      for (const id of ids) {
        spawn("taskkill", ["/PID", id, "/F"], { windowsHide: true });
      }
    })
    .catch(() => undefined);
}

function runWord(scriptPath: string, docxPath: string, pdfPath: string, pidFile: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptPath, docxPath, pdfPath, pidFile],
      { windowsHide: true },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill();
      void stopRecordedWord(pidFile).finally(() => {
        reject(new Error("O Word demorou demais para gerar o PDF."));
      });
    }, 90_000);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim().split(/\r?\n/).find(Boolean) ?? "";
      reject(new Error(detail && detail.length < 180 ? detail : "Não foi possível converter o Word em PDF."));
    });
  });
}

export async function docxToPdf(docx: Uint8Array): Promise<Uint8Array> {
  const dir = await mkdtemp(path.join(tmpdir(), "conversor-ch-"));
  const docxPath = path.join(dir, "documento.docx");
  const pdfPath = path.join(dir, "documento.pdf");
  const scriptPath = path.join(dir, "convert.ps1");
  const pidFile = path.join(dir, "word.pid");

  try {
    await writeFile(docxPath, docx);
    await writeFile(scriptPath, SCRIPT.trim(), "utf8");
    await runWord(scriptPath, docxPath, pdfPath, pidFile);
    return new Uint8Array(await readFile(pdfPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
