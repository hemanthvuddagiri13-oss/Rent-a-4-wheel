import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { formatCurrency } from "@/lib/utils";
import type { AgreementAcceptance, Reservation, Vehicle } from "@prisma/client";

/**
 * Renders the signed rental-agreement PDF for one acceptance. Called once,
 * at signing time, to produce the immutable snapshot stored in
 * `AgreementAcceptance.signedPdfStorageKey` — the content baked into the
 * PDF (legal text, version) comes from `acceptance.contentSnapshot`, not
 * the live/editable LegalDocument row, so the PDF can never drift from
 * what was actually signed.
 */
export async function generateRentalAgreementPdf(params: {
  reservation: Reservation;
  vehicle: Vehicle;
  acceptance: AgreementAcceptance;
}): Promise<Uint8Array> {
  const { acceptance } = params;
  const frozen = acceptance.subjectSnapshot as { reservation?: Record<string, unknown>; vehicle?: Vehicle } | null;
  const vehicle = frozen?.vehicle ?? params.vehicle;
  const reservation = frozen?.reservation ? { ...params.reservation, ...frozen.reservation,
    pickupAt: new Date(String(frozen.reservation.pickupAt)), returnAt: new Date(String(frozen.reservation.returnAt)) } as Reservation : params.reservation;

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  let page = pdfDoc.addPage([612, 792]);
  const gold = rgb(0.831, 0.686, 0.216);
  const white = rgb(0.08, 0.08, 0.08);
  const gray = rgb(0.55, 0.55, 0.55);

  let y = 740;
  function draw(text: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; gap?: number } = {}) {
    const { size = 11, bold = false, color = white, gap = 18 } = opts;
    if (y < 60) {
      page = pdfDoc.addPage([612, 792]);
      y = 740;
    }
    page.drawText(sanitizeForWinAnsi(text), { x: 56, y, size, font: bold ? fontBold : font, color });
    y -= gap;
  }

  page.drawRectangle({ x: 0, y: 760, width: 612, height: 32, color: rgb(0.03, 0.03, 0.03) });
  page.drawText("RENT A 4WHEEL — RENTAL AGREEMENT", { x: 56, y: 770, size: 14, font: fontBold, color: gold });
  y = 720;

  draw(`Confirmation Number: ${reservation.confirmationNumber}`, { bold: true });
  draw(`Agreement Version: ${acceptance.documentVersion}`);
  draw(`Content Hash (SHA-256): ${acceptance.contentHash}`, { size: 8 });
  draw(`Signed By: ${acceptance.signerName}`);
  draw(`Signed At: ${acceptance.signedAt.toLocaleString("en-US")}`);
  draw(`IP Address: ${acceptance.ipAddress ?? "—"}`);
  draw("");
  draw("VEHICLE", { bold: true, color: gold });
  draw(`${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim ?? ""}`);
  draw(`VIN: ${vehicle.vin}`);
  draw("");
  draw("RENTAL PERIOD", { bold: true, color: gold });
  draw(`Pickup: ${reservation.pickupAt.toLocaleString("en-US")}`);
  draw(`Return: ${reservation.returnAt.toLocaleString("en-US")}`);
  draw("");
  draw("DRIVER", { bold: true, color: gold });
  draw(`${reservation.driverFirstName ?? ""} ${reservation.driverLastName ?? ""}`);
  draw(`${reservation.driverAddress ?? ""}, ${reservation.driverCity ?? ""}, ${reservation.driverState ?? ""} ${reservation.driverZip ?? ""}`);
  draw(`License: ${reservation.licenseNumber ?? ""} (${reservation.licenseState ?? ""})`);
  draw("");
  draw("CHARGES", { bold: true, color: gold });
  draw(`Rental Subtotal: ${formatCurrency(reservation.subtotalCents)}`);
  draw(`Extras: ${formatCurrency(reservation.extrasCents)}`);
  draw(`Taxes: ${formatCurrency(reservation.taxCents)}`);
  draw(`Fees: ${formatCurrency(reservation.feesCents)}`);
  draw(`Discount: -${formatCurrency(reservation.discountCents)}`);
  draw(`TOTAL: ${formatCurrency(reservation.totalCents)}`, { bold: true });
  draw(`Security Deposit: ${formatCurrency(reservation.depositCents)}`);
  draw("");
  draw("TERMS", { bold: true, color: gold });

  for (const line of wrapText(acceptance.contentSnapshot, 95)) {
    draw(line, { size: 9, color: gray, gap: 13 });
  }

  return pdfDoc.save();
}

// Legal document content is admin-editable free text, so it may contain
// characters outside the WinAnsi codepage the standard PDF fonts support
// (curly quotes, arrows, emoji, etc). Normalize common punctuation and
// drop anything else rather than letting pdf-lib throw at render time.
function sanitizeForWinAnsi(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x00-\xFF]/g, "");
}

function wrapText(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const word of paragraph.split(" ")) {
      if ((current + " " + word).trim().length > maxChars) {
        lines.push(current.trim());
        current = word;
      } else {
        current = `${current} ${word}`.trim();
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}
