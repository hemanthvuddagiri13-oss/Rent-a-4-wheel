CREATE TABLE "MobileUpload" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "reservationId" TEXT,
  "type" TEXT NOT NULL CHECK ("type" IN ('LICENSE_FRONT','LICENSE_BACK','SELFIE_WITH_LICENSE','INSPECTION')),
  "storageKey" TEXT,
  "mimeType" TEXT NOT NULL CHECK ("mimeType" IN ('image/jpeg','image/png','image/webp')),
  "expectedSha256" TEXT NOT NULL CHECK ("expectedSha256" ~ '^[0-9a-f]{64}$'),
  "expectedSize" INTEGER NOT NULL CHECK ("expectedSize" > 0 AND "expectedSize" <= 8388608),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "finalizedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MobileUpload_userId_expiresAt_idx" ON "MobileUpload"("userId", "expiresAt");
