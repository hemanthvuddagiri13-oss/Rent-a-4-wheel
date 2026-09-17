-- Preserve existing approved inventory. New host listings explicitly start PENDING.
ALTER TABLE "Vehicle" ADD COLUMN "listingApproval" TEXT NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN "location" TEXT NOT NULL DEFAULT 'Dallas, TX', ADD COLUMN "rules" TEXT;
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_listingApproval_check"
  CHECK ("listingApproval" IN ('PENDING', 'APPROVED', 'REJECTED'));
ALTER TABLE "VehicleOwner" ADD COLUMN "hostId" TEXT REFERENCES "HostProfile"("id");
CREATE INDEX "VehicleOwner_hostId_idx" ON "VehicleOwner"("hostId");
ALTER TABLE "AgreementAcceptance" ADD COLUMN "subjectSnapshot" JSONB;
CREATE FUNCTION marketplace_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."subjectSnapshot" IS DISTINCT FROM NEW."subjectSnapshot" THEN
    RAISE EXCEPTION 'Signed subject snapshot is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agreement_subject_immutable BEFORE UPDATE ON "AgreementAcceptance"
FOR EACH ROW EXECUTE FUNCTION marketplace_snapshot_immutable();

CREATE TABLE "MarketplaceFile" (
  "id" TEXT PRIMARY KEY, "hostId" TEXT NOT NULL REFERENCES "HostProfile"("id"),
  "vehicleId" TEXT REFERENCES "Vehicle"("id"), "uploadedById" TEXT NOT NULL REFERENCES "User"("id"),
  "purpose" TEXT NOT NULL CHECK ("purpose" IN ('OWNERSHIP','REGISTRATION','INSURANCE','LISTING_PHOTO')),
  "storageKey" TEXT NOT NULL, "mimeType" TEXT NOT NULL, "sha256" TEXT NOT NULL,
  "scanStatus" TEXT NOT NULL CHECK ("scanStatus" IN ('CLEAN','QUARANTINED')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MarketplaceFile_hostId_vehicleId_idx" ON "MarketplaceFile"("hostId", "vehicleId");
CREATE TABLE "MarketplaceRateLimit" (
  "key" TEXT PRIMARY KEY, "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "count" INTEGER NOT NULL DEFAULT 1
);
CREATE TRIGGER aa_financial_guard BEFORE INSERT OR UPDATE OR DELETE ON "TripChecklist"
FOR EACH ROW EXECUTE FUNCTION financial_authority_guard();
