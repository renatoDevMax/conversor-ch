import { docxToPdf } from "@/lib/docxToPdf";

export async function POST(request: Request) {
  const docx = new Uint8Array(await request.arrayBuffer());
  if (docx.byteLength < 4) {
    return new Response("Envie o Word gerado para converter.", { status: 400 });
  }

  try {
    const pdf = await docxToPdf(docx);
    return new Response(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Não foi possível gerar o PDF.";
    return new Response(message, { status: 500 });
  }
}
