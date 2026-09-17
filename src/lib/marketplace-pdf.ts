import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
/** Private, printable evidence. Text is wrapped and every page uses black ink. */
export async function evidencePdf(title: string, lines: string[]) {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  let page = doc.addPage([612, 792]), y = 742;
  for (const paragraph of ["RENT A 4WHEEL", title, "", ...lines]) {
    const plain = paragraph.replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7e\n]/g, "");
    for (const row of plain.split("\n")) for (const chunk of row.match(/.{1,86}(?:\s|$)|.{1,86}/g) ?? [""]) {
      if (y < 55) { page = doc.addPage([612, 792]); y = 742; }
      page.drawText(chunk.trim(), { x: 48, y, size: 10, font, color: rgb(.08, .08, .08) }); y -= 15;
    }
  }
  return Buffer.from(await doc.save());
}
