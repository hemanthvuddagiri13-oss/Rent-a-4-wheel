ALTER TABLE "PrivateObject" ADD COLUMN "writeState" TEXT NOT NULL DEFAULT 'PREPARED';
-- Old uploaded/scanning/failed rows may reflect a lost provider response.
UPDATE "PrivateObject" SET "writeState"=CASE WHEN state IN ('CLEAN','QUARANTINED','INFECTED','DELETED') THEN 'STORED' ELSE 'UNCERTAIN' END;
ALTER TABLE "PrivateObject" ADD CONSTRAINT private_write_states CHECK ("writeState" IN ('PREPARED','RUNNING','STORED','UNCERTAIN'));
ALTER TABLE "JurisdictionApproval" ADD CONSTRAINT jurisdiction_version_valid CHECK (version>0 AND ("endsAt" IS NULL OR "endsAt">"effectiveAt") AND (status<>'STAGING_READY' OR ("reviewedAt" IS NOT NULL AND "reviewedById" IS NOT NULL)));
ALTER TABLE "MarketplacePricingPolicy" ADD CONSTRAINT pricing_version_valid CHECK (version>0 AND ("endsAt" IS NULL OR "endsAt">"effectiveAt") AND (status<>'STAGING_READY' OR ("reviewedAt" IS NOT NULL AND "reviewedById" IS NOT NULL)));
