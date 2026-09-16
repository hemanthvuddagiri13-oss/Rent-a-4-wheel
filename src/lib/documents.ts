import { createHash } from "crypto";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { storePrivateDocument } from "@/lib/storage";
import type { DocumentType } from "@prisma/client";

export const MAX_DOCUMENT_SIZE_BYTES = 8 * 1024 * 1024; // 8MB

// Default retention window for identity documents once a reservation
// completes (or a document is never attached to one). Configurable per
// deployment via PlatformSetting in a later phase; documented here as the
// single source of truth for the current default.
const DEFAULT_RETENTION_DAYS = 365 * 3;

const PDF_MAGIC = Buffer.from("%PDF-");

export class InvalidDocumentError extends Error {}

/**
 * Validates that `buffer` actually is what its declared mime type claims
 * (a real file-signature check, not just trusting the browser-supplied
 * Content-Type), then:
 *  - for images: re-encodes through sharp, which both proves the bytes
 *    decode as a genuine image and strips all EXIF/IPTC/XMP metadata
 *    (sharp's output never carries the source metadata unless
 *    `.withMetadata()` is called, which we don't call);
 *  - for PDFs: checks the `%PDF-` magic header.
 *
 * Returns the bytes that should actually be stored (the re-encoded image,
 * or the original buffer for PDFs) plus a sha256 of those stored bytes for
 * later integrity checks.
 */
export async function validateAndSanitizeDocument(
  buffer: Buffer,
  declaredMimeType: string
): Promise<{ buffer: Buffer; mimeType: string; sha256: string }> {
  if (declaredMimeType === "application/pdf") {
    if (!buffer.subarray(0, 5).equals(PDF_MAGIC)) {
      throw new InvalidDocumentError("File does not appear to be a valid PDF.");
    }
    return { buffer, mimeType: "application/pdf", sha256: sha256Hex(buffer) };
  }

  if (["image/jpeg", "image/png", "image/webp"].includes(declaredMimeType)) {
    let reencoded: Buffer;
    let outputMimeType: string;
    try {
      const image = sharp(buffer, { failOn: "error" });
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
    return { buffer: reencoded, mimeType: outputMimeType, sha256: sha256Hex(reencoded) };
  }

  throw new InvalidDocumentError("Unsupported file type. Upload a JPG, PNG, WEBP, or PDF.");
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export type MalwareScanResult = { status: "CLEAN" | "INFECTED" | "SCAN_UNAVAILABLE" };

/**
 * Integration point for a malware scanner (e.g. ClamAV, VirusTotal, an S3
 * Object Lambda scanner). No scanning provider is configured in this
 * environment, so this always returns SCAN_UNAVAILABLE rather than
 * silently/falsely reporting CLEAN — callers must not treat
 * SCAN_UNAVAILABLE as a pass. Wire a real provider here before accepting
 * uploads in production; see README "Identity Verification" for notes.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature documents the intended integration point
export async function scanForMalware(buffer: Buffer): Promise<MalwareScanResult> {
  return { status: "SCAN_UNAVAILABLE" };
}

export function computeRetentionExpiresAt(from: Date = new Date()): Date {
  return new Date(from.getTime() + DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

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

  const { storageKey } = await storePrivateDocument(sanitized.buffer, sanitized.mimeType);

  return prisma.driverDocument.create({
    data: {
      userId: params.userId,
      reservationId: params.reservationId,
      type: params.type,
      storageKey,
      mimeType: sanitized.mimeType,
      fileSizeBytes: sanitized.buffer.byteLength,
      contentSha256: sanitized.sha256,
      malwareScanStatus: scan.status,
      status: "PENDING_VERIFICATION",
      retentionExpiresAt: computeRetentionExpiresAt(),
    },
  });
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
