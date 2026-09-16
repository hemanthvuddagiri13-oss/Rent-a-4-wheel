import { NextRequest, NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { formatCurrency } from "@/lib/utils";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const reservation = await prisma.reservation.findUnique({
    where: { id },
    include: { vehicle: true, agreement: true },
  });
  if (!reservation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isOwner = reservation.customerId === session.user.id;
  const isReviewer = ["ADMIN", "STAFF"].includes(session.user.role);
  if (!isOwner && !isReviewer) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const legalDoc = await prisma.legalDocument.findUnique({ where: { type: "RENTAL_AGREEMENT" } });

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  let page = pdfDoc.addPage([612, 792]);
  const gold = rgb(0.831, 0.686, 0.216);
  const white = rgb(1, 1, 1);
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
  draw(`Agreement Version: ${reservation.agreementVersionAccepted ?? "v1-draft"}`);
  draw(`Accepted At: ${reservation.agreementAcceptedAt?.toLocaleString("en-US") ?? "—"}`);
  draw("");
  draw("VEHICLE", { bold: true, color: gold });
  draw(`${reservation.vehicle.year} ${reservation.vehicle.make} ${reservation.vehicle.model} ${reservation.vehicle.trim ?? ""}`);
  draw(`VIN: ${reservation.vehicle.vin}`);
  draw("");
  draw("RENTAL PERIOD", { bold: true, color: gold });
  draw(`Pickup: ${reservation.pickupAt.toLocaleString("en-US")}`);
  draw(`Return: ${reservation.returnAt.toLocaleString("en-US")}`);
  draw("");
  draw("DRIVER", { bold: true, color: gold });
  draw(`${reservation.driverFirstName} ${reservation.driverLastName}`);
  draw(`${reservation.driverAddress}, ${reservation.driverCity}, ${reservation.driverState} ${reservation.driverZip}`);
  draw(`License: ${reservation.licenseNumber} (${reservation.licenseState})`);
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

  const legalText =
    legalDoc?.content ??
    "PLACEHOLDER — Rental Agreement terms have not yet been finalized by a licensed Texas attorney.";
  for (const line of wrapText(legalText, 95)) {
    draw(line, { size: 9, color: gray, gap: 13 });
  }

  const pdfBytes = await pdfDoc.save();
  return new NextResponse(new Uint8Array(pdfBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${reservation.confirmationNumber}-rental-agreement.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
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
