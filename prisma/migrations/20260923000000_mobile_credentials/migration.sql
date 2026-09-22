ALTER TYPE "AuthCodePurpose" ADD VALUE 'MOBILE_SIGN_IN';

CREATE TABLE "MobileSession" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "deviceId" TEXT NOT NULL,
  "platform" TEXT NOT NULL CHECK ("platform" IN ('IOS', 'ANDROID')),
  "appVersion" TEXT NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 0 CHECK ("generation" >= 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "revocationReason" TEXT,
  "reuseDetectedAt" TIMESTAMP(3)
);
CREATE INDEX "MobileSession_userId_revokedAt_idx" ON "MobileSession"("userId", "revokedAt");
CREATE INDEX "MobileSession_userId_deviceId_idx" ON "MobileSession"("userId", "deviceId");
CREATE TABLE "MobileCredential" (
  "id" TEXT PRIMARY KEY,
  "sessionId" TEXT NOT NULL REFERENCES "MobileSession"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "generation" INTEGER NOT NULL CHECK ("generation" >= 0),
  "accessHash" TEXT NOT NULL,
  "refreshHash" TEXT NOT NULL,
  "accessExpiresAt" TIMESTAMP(3) NOT NULL,
  "refreshExpiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "MobileCredential_accessHash_key" ON "MobileCredential"("accessHash");
CREATE UNIQUE INDEX "MobileCredential_refreshHash_key" ON "MobileCredential"("refreshHash");
CREATE UNIQUE INDEX "MobileCredential_sessionId_generation_key" ON "MobileCredential"("sessionId", "generation");
CREATE TABLE "MobileMutation" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MobileMutation_userId_createdAt_idx" ON "MobileMutation"("userId", "createdAt");
