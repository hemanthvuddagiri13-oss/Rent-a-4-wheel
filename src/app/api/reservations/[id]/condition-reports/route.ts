import { withReservationLock } from "@/lib/financial-locks";
import { safeLog } from "@/lib/safe-log";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { validateAndSanitizeDocument, InvalidDocumentError, MAX_DOCUMENT_SIZE_BYTES } from "@/lib/documents";
import { storePrivateDocument } from "@/lib/storage";
import { getHostContext, hostOwnsReservation } from "@/lib/host-access";
import type { ConditionPhotoCategory, ConditionReportPhase } from "@prisma/client";
import { tripParticipant } from "@/lib/trip-experience";
import { MarketplaceError, marketplaceLimit } from "@/lib/marketplace";

const VALID_PHASES: ConditionReportPhase[] = ["PRE_TRIP", "POST_TRIP"];
const VALID_CATEGORIES: ConditionPhotoCategory[] = ["EXTERIOR", "INTERIOR", "ODOMETER", "FUEL_GAUGE", "DAMAGE"];

/**
 * Submits one party's (customer's or host's) condition report for a
 * pickup/return phase, with photo evidence. Both a customer and a host
 * report are required per phase before a trip can start or a return can
 * complete (see src/lib/trip-gate.ts) — this endpoint records one side of
 * that pair per call, attributed to whichever role the caller actually
 * holds for this reservation (never a client-supplied role).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: reservationId } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!reservation) return NextResponse.json({ error: "Reservation not found." }, { status: 404 });

  const isCustomer = reservation.customerId === session.user.id;
  const hostContext = isCustomer ? null : await getHostContext(session.user.id);
  const isHost = hostContext ? await hostOwnsReservation(hostContext, reservationId) : false;
  if (!isCustomer && !isHost) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const role = isCustomer ? "CUSTOMER" : "HOST";

  const formData = await req.formData();
  const phase = formData.get("phase");
  const mileage = Number(formData.get("mileage"));
  const fuelLevel = Number(formData.get("fuelLevel"));
  const damageNotes = formData.get("damageNotes");

  if (typeof phase !== "string" || !VALID_PHASES.includes(phase as ConditionReportPhase)) {
    return NextResponse.json({ error: "Invalid phase." }, { status: 400 });
  }
  if (!Number.isSafeInteger(mileage) || mileage < 0) {
    return NextResponse.json({ error: "Invalid mileage." }, { status: 400 });
  }
  if (!Number.isSafeInteger(fuelLevel) || fuelLevel < 0 || fuelLevel > 100) {
    return NextResponse.json({ error: "Invalid fuel/charge level." }, { status: 400 });
  }

  const photoFiles = formData.getAll("photo");
  const photoCategories = formData.getAll("category");
  if (photoFiles.length === 0) {
    return NextResponse.json({ error: "At least one photo is required." }, { status: 400 });
  }
  if (photoFiles.length !== photoCategories.length) {
    return NextResponse.json({ error: "Each photo must have a matching category." }, { status: 400 });
  }
  for (const category of photoCategories) {
    if (typeof category !== "string" || !VALID_CATEGORIES.includes(category as ConditionPhotoCategory)) {
      return NextResponse.json({ error: `Invalid photo category: ${String(category)}` }, { status: 400 });
    }
  }

  try {
    await marketplaceLimit(session.user.id);
    if (photoFiles.length > 10 || (typeof damageNotes === "string" && damageNotes.length > 2000)) throw new MarketplaceError("Too many photos or notes are too long.");
    if (!photoCategories.includes("EXTERIOR") || !photoCategories.includes("INTERIOR")) throw new MarketplaceError("Exterior and interior photos are required.");
    const storedPhotos: Array<{ category: ConditionPhotoCategory; storageKey: string }> = [];
    for (let i = 0; i < photoFiles.length; i++) {
      const file = photoFiles[i];
      if (!(file instanceof File)) return NextResponse.json({ error: "Invalid photo upload." }, { status: 400 });
      if (file.size > MAX_DOCUMENT_SIZE_BYTES) return NextResponse.json({ error: "A photo is too large (max 8MB)." }, { status: 400 });
      const buffer = Buffer.from(await file.arrayBuffer());
      const sanitized = await validateAndSanitizeDocument(buffer, file.type);
      const { storageKey } = await storePrivateDocument(sanitized.buffer, sanitized.mimeType);
      storedPhotos.push({ category: photoCategories[i] as ConditionPhotoCategory, storageKey });
    }

    const report = await withReservationLock(reservationId, async tx => {
      const fresh = await tripParticipant(tx, session.user.id, reservationId);
      const allowed = phase === "PRE_TRIP" ? ["CONFIRMED", "DOCUMENTS_REQUIRED", "READY_FOR_CHECK_IN", "CHECK_IN_PROGRESS", "READY_TO_START"] : ["RETURN_IN_PROGRESS"];
      if (!allowed.includes(fresh.reservation.status)) throw new MarketplaceError("Inspection is not open for this trip phase.", 409);
      if (await tx.conditionReport.findFirst({ where: { reservationId, phase: phase as ConditionReportPhase, submittedByRole: fresh.role } })) throw new MarketplaceError("A report already exists for this party and phase. Review the saved report.", 409);
      return tx.conditionReport.create({
      data: {
        reservationId,
        phase: phase as ConditionReportPhase,
        submittedByRole: role,
        submittedById: session.user.id,
        mileage,
        fuelLevel,
        damageNotes: typeof damageNotes === "string" && damageNotes ? damageNotes : null,
        photos: { create: storedPhotos },
      },
    }); });

    await prisma.tripEvent.create({
      data: {
        reservationId,
        type: "CONDITION_REPORT_SUBMITTED",
        actorId: session.user.id,
        metadata: { phase, role, conditionReportId: report.id },
      },
    });

    return NextResponse.json({ id: report.id });
  } catch (err) {
    if (err instanceof MarketplaceError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof InvalidDocumentError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    safeLog("CONDITION_REPORT_SUBMISSION_FAILED", err);
    return NextResponse.json({ error: "Something went wrong submitting the condition report." }, { status: 500 });
  }
}
