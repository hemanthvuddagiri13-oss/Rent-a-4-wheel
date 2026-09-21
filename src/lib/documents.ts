import { withReservationLock } from "@/lib/financial-locks";
import { createHash } from "crypto";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { storePrivateDocument } from "@/lib/storage";
import type { DocumentType, Prisma } from "@prisma/client";
import { scanWithClamAv } from "@/lib/clamav";
import { localDevelopment } from "@/lib/deployment-environment";

export const MAX_DOCUMENT_SIZE_BYTES = 8 * 1024 * 1024; // 8MB

// Default retention window for identity documents once a reservation
// completes (or a document is never attached to one). Configurable per
// deployment via PlatformSetting in a later phase; documented here as the
// single source of truth for the current default.
const DEFAULT_RETENTION_DAYS = 365 * 3;

export class InvalidDocumentError extends Error {}

/**
 * Validates that `buffer` actually is what its declared mime type claims
 * (a real file-signature check, not just trusting the browser-supplied
 * Content-Type) by re-encoding it through sharp, which both proves the
 * bytes decode as a genuine image and strips all EXIF/IPTC/XMP metadata
 * (sharp's output never carries the source metadata unless
 * `.withMetadata()` is called, which we don't call).
 *
 * PDF is intentionally NOT accepted for identity documents: a PDF can
 * embed active content (JavaScript, launch actions) that a
 * magic-byte-only check does nothing to rule out, and this deployment has
 * no PDF-capable malware scanner. Only re-encoded raster images are
 * accepted — see README "Identity Verification" for the reasoning if PDF
 * support is reintroduced later, which would first require routing PDFs
 * through a real scanner before they're ever readable.
 *
 * Returns the re-encoded bytes that should actually be stored, plus a
 * sha256 of those stored bytes for later integrity checks.
 */
export async function validateAndSanitizeDocument(
  buffer: Buffer,
  declaredMimeType: string
): Promise<{ buffer: Buffer; mimeType: string; sha256: string }> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(declaredMimeType)) {
    throw new InvalidDocumentError("Unsupported file type. Upload a JPG, PNG, or WEBP image.");
  }

  let reencoded: Buffer;
  let outputMimeType: string;
  try {
    const image = sharp(buffer, { failOn: "error", limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    if (!metadata.format) throw new Error("Unrecognized image format.");

    if (metadata.format === "png") {
      reencoded = await image.png().toBuffer();
      outputMimeType = "image/png";
    } else if (metadata.format === "webp") {
      reencoded = await image.webp({ quality: 90 }).toBuffer();
      outputMimeType = "image/webp";
    } else {
      reencoded = await image.jpeg({ quality: 90 }).toBuffer();
      outputMimeType = "image/jpeg";
    }
  } catch {
    throw new InvalidDocumentError("File does not appear to be a valid image.");
  }
  if (reencoded.length > MAX_DOCUMENT_SIZE_BYTES) throw new InvalidDocumentError("Decoded image is too large. Choose a smaller image.");
  return { buffer: reencoded, mimeType: outputMimeType, sha256: sha256Hex(reencoded) };
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export type MalwareScanResult = { status: "CLEAN" | "INFECTED" | "SCAN_UNAVAILABLE" };

/**
 * Configured private ClamAV INSTREAM integration. Missing configuration,
 * connection errors and malformed or incomplete replies are unavailable,
 * never a pass. See docs/phase-2-delivery.md for deployment requirements.
 */
export async function scanForMalware(buffer: Buffer): Promise<MalwareScanResult> {
  return scanWithClamAv(buffer);
}

export function computeRetentionExpiresAt(from: Date = new Date()): Date {
  return new Date(from.getTime() + DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Stores an identity document with fail-closed malware-scan semantics:
 *  - INFECTED is always rejected outright.
 *  - SCAN_UNAVAILABLE is rejected in production — an unscanned file is not an
 *    accepted file, full stop. It is only accepted in non-production
 *    environments, and only via an explicit opt-in
 *    (`ALLOW_UNSCANNED_DOCUMENT_UPLOADS_IN_DEV=true`), so a developer
 *    without a scanner configured can still exercise the booking flow
 *    locally without silently normalizing "unscanned" as "safe" anywhere
 *    that matters.
 * A document that is accepted without a CLEAN result is stored with
 * `malwareScanStatus: QUARANTINED` and is not readable by anyone but its
 * owner until it actually becomes CLEAN — see `assertDocumentViewable`.
 */
export async function storeIdentityDocument(params: {
  userId: string;
  reservationId: string | null;
  type: DocumentType;
  rawBuffer: Buffer;
  declaredMimeType: string;
}) {
  if (params.rawBuffer.byteLength > MAX_DOCUMENT_SIZE_BYTES) {
    throw new InvalidDocumentError("File is too large (max 8MB).");
  }

  const sanitized = await validateAndSanitizeDocument(params.rawBuffer, params.declaredMimeType);
  const scan = await scanForMalware(sanitized.buffer);

  if (scan.status === "INFECTED") {
    throw new InvalidDocumentError("This file failed a security scan and was rejected.");
  }

  if (scan.status === "SCAN_UNAVAILABLE") {
    const isProduction = !localDevelopment();
    const devBypassEnabled = process.env.ALLOW_UNSCANNED_DOCUMENT_UPLOADS_IN_DEV === "true";
    if (isProduction || !devBypassEnabled) {
      throw new InvalidDocumentError(
        isProduction
          ? "Document uploads are temporarily unavailable (malware scanning is not configured). Please try again later or contact support."
          : "Document uploads require a malware scanner in this environment. Set ALLOW_UNSCANNED_DOCUMENT_UPLOADS_IN_DEV=true to bypass locally for development only."
      );
    }
  }

  const { storageKey } = await storePrivateDocument(sanitized.buffer, sanitized.mimeType);

  const create = (tx: Prisma.TransactionClient) => tx.driverDocument.create({
    data: {
      userId: params.userId,
      reservationId: params.reservationId,
      type: params.type,
      storageKey,
      mimeType: sanitized.mimeType,
      fileSizeBytes: sanitized.buffer.byteLength,
      contentSha256: sanitized.sha256,
      malwareScanStatus: scan.status === "CLEAN" ? "CLEAN" : "QUARANTINED",
      status: "PENDING_VERIFICATION",
      retentionExpiresAt: computeRetentionExpiresAt(),
    },
  });
  return params.reservationId ? withReservationLock(params.reservationId, async tx => {
    const reservation = await tx.reservation.findUniqueOrThrow({ where: { id: params.reservationId! } });
    if (reservation.customerId !== params.userId) throw new InvalidDocumentError("Reservation ownership changed");
    return create(tx);
  }) : create(prisma);
}

/**
 * Enforces "no host [or staff reviewer] access until CLEAN": the
 * document's own uploader may always view it (it's already fully theirs
 * to see), but any other viewer — a host verifying identity at pickup, a
 * staff reviewer — is refused until the scan status is actually CLEAN.
 * When scanning is unavailable, development uploads remain quarantined
 * and non-owner access is refused until a successful scan is recorded.
 */
export function assertDocumentViewable(document: { userId: string; malwareScanStatus: string }, viewerId: string): void {
  if (document.malwareScanStatus === "INFECTED") throw new InvalidDocumentError("Infected content is not available.");
  if (document.userId === viewerId) return;
  if (document.malwareScanStatus !== "CLEAN") {
    throw new InvalidDocumentError("This document has not cleared malware scanning and cannot be viewed yet.");
  }
}

/**
 * Verifies that every document ID in `documentIds` actually belongs to
 * `userId` and is either unattached or already attached to this exact
 * reservation (idempotent retry) — never to a *different* reservation, and
 * never to a document some other user uploaded. This is the single
 * enforcement point behind "a user must never be able to associate a
 * document with a reservation they do not own."
 */
export async function verifyDocumentOwnership(params: {
  documentIds: string[];
  userId: string;
  reservationId: string;
}): Promise<boolean> {
  if (params.documentIds.length === 0) return false;
  const owned = await prisma.driverDocument.findMany({
    where: {
      id: { in: params.documentIds },
      userId: params.userId,
      OR: [{ reservationId: null }, { reservationId: params.reservationId }],
    },
    select: { id: true },
  });
  return owned.length === params.documentIds.length;
}

/**
 * Every read of a private identity document must go through this so there
 * is always an access-audit row, per-document, per-viewer, regardless of
 * which route or role is reading it.
 */
export async function logDocumentAccess(params: {
  documentId: string;
  accessedById: string;
  purpose: string;
  ipAddress: string | null;
}) {
  await prisma.documentAccessLog.create({
    data: {
      documentId: params.documentId,
      accessedById: params.accessedById,
      purpose: params.purpose,
      ipAddress: params.ipAddress,
    },
  });
}
