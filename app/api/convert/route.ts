import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";

const SCRIPT_PATH = join(process.cwd(), "scripts", "convert_pdf_to_docx.py");

function runPython(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("python", args, {
      windowsHide: true,
    });

    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(
        new Error(
          `Não foi possível executar o Python. Verifique se ele está instalado. (${error.message})`,
        ),
      );
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          stderr.trim() ||
            `A conversão falhou com código ${code ?? "desconhecido"}.`,
        ),
      );
    });
  });
}

export async function POST(request: Request) {
  let tempDir: string | null = null;

  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Envie um arquivo PDF." },
        { status: 400 },
      );
    }

    const isPdf =
      file.type === "application/pdf" ||
      file.name.toLowerCase().endsWith(".pdf");

    if (!isPdf) {
      return NextResponse.json(
        { error: "O arquivo precisa ser um PDF." },
        { status: 400 },
      );
    }

    tempDir = await mkdtemp(join(tmpdir(), "pdf-to-docx-"));
    const pdfPath = join(tempDir, "input.pdf");
    const docxPath = join(tempDir, "output.docx");

    await writeFile(pdfPath, Buffer.from(await file.arrayBuffer()));
    await runPython([SCRIPT_PATH, pdfPath, docxPath]);

    const buffer = await readFile(docxPath);
    const fileName = file.name.replace(/\.pdf$/i, "") + ".docx";

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `inline; filename="${encodeURIComponent(fileName)}"`,
        "X-Converted-Filename": encodeURIComponent(fileName),
      },
    });
  } catch (error) {
    console.error("Falha ao converter PDF:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Não foi possível converter o PDF.";

    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
