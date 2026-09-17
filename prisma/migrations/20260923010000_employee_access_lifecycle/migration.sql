-- Existing memberships remain active. Revocation/expiry is checked on every read.
ALTER TABLE "HostEmployee" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "expiresAt" TIMESTAMP(3);
