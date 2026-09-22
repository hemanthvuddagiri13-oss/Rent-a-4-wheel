CREATE TABLE "Jurisdiction" (code TEXT PRIMARY KEY,mode TEXT NOT NULL DEFAULT 'DISABLED',version INTEGER NOT NULL DEFAULT 1,"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT jurisdiction_phase5_modes CHECK (mode IN ('DISABLED','STAGING')));
INSERT INTO "Jurisdiction" (code) SELECT unnest(ARRAY['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC']);
ALTER TABLE "Vehicle" ADD COLUMN "jurisdictionCode" TEXT REFERENCES "Jurisdiction"(code);
ALTER TABLE "HostProfile" ADD COLUMN "jurisdictionCode" TEXT REFERENCES "Jurisdiction"(code);
ALTER TABLE "Reservation" ADD COLUMN "jurisdictionCode" TEXT REFERENCES "Jurisdiction"(code),ADD COLUMN "jurisdictionSnapshot" JSONB;
CREATE TABLE "JurisdictionApproval" (id TEXT PRIMARY KEY,"jurisdictionCode" TEXT NOT NULL REFERENCES "Jurisdiction"(code),category TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'SAMPLE',"contentHash" TEXT NOT NULL,"reviewedById" TEXT REFERENCES "User"(id),"reviewedAt" TIMESTAMP(3),"effectiveAt" TIMESTAMP(3) NOT NULL,"endsAt" TIMESTAMP(3),"evidenceReference" TEXT NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT jurisdiction_review_scope CHECK (status IN ('SAMPLE','STAGING_READY','REVOKED') AND "contentHash" ~ '^[a-f0-9]{64}$' AND category IN ('ENTITY','LEGAL','INSURANCE','TAX','PRIVACY_RETENTION','OPERATIONS','PAYMENTS','HOST_PAYOUTS','LOCAL_RESTRICTIONS','HOST_ELIGIBILITY','GUEST_ELIGIBILITY','VEHICLE_ELIGIBILITY')));
CREATE UNIQUE INDEX "JurisdictionApproval_jurisdictionCode_category_version_key" ON "JurisdictionApproval"("jurisdictionCode",category,version);
CREATE INDEX "JurisdictionApproval_jurisdictionCode_category_effectiveAt_idx" ON "JurisdictionApproval"("jurisdictionCode",category,"effectiveAt");
CREATE TABLE "MarketplacePricingPolicy" (id TEXT PRIMARY KEY,"jurisdictionCode" TEXT NOT NULL REFERENCES "Jurisdiction"(code),version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'SAMPLE',config JSONB NOT NULL,"contentHash" TEXT NOT NULL,"effectiveAt" TIMESTAMP(3) NOT NULL,"endsAt" TIMESTAMP(3),"createdById" TEXT REFERENCES "User"(id),"reviewedById" TEXT REFERENCES "User"(id),"reviewedAt" TIMESTAMP(3),"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT pricing_phase5_unapproved CHECK (status IN ('SAMPLE','STAGING_READY','REVOKED') AND "contentHash" ~ '^[a-f0-9]{64}$'));
CREATE UNIQUE INDEX "MarketplacePricingPolicy_jurisdictionCode_version_key" ON "MarketplacePricingPolicy"("jurisdictionCode",version);
CREATE INDEX "MarketplacePricingPolicy_jurisdictionCode_effectiveAt_idx" ON "MarketplacePricingPolicy"("jurisdictionCode","effectiveAt");
CREATE TABLE "HostSubscription" ("hostId" TEXT PRIMARY KEY REFERENCES "HostProfile"(id),plan TEXT NOT NULL,"jurisdictionCode" TEXT NOT NULL REFERENCES "Jurisdiction"(code),"activeUntil" TIMESTAMP(3) NOT NULL,"providerReference" TEXT,"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE FUNCTION jurisdiction_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('release-control',0));
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Jurisdictions cannot be deleted'; END IF;
 IF NEW.code<>OLD.code THEN RAISE EXCEPTION 'Jurisdiction identity is immutable'; END IF;
 NEW.version:=OLD.version+1; RETURN NEW;
END $$;
CREATE TRIGGER jurisdiction_change BEFORE UPDATE OR DELETE ON "Jurisdiction" FOR EACH ROW EXECUTE FUNCTION jurisdiction_change_guard();
CREATE FUNCTION national_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR NEW.status NOT IN (OLD.status,'REVOKED') THEN RAISE EXCEPTION 'Create a new immutable jurisdiction or pricing version'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER jurisdiction_approval_immutable BEFORE UPDATE OR DELETE ON "JurisdictionApproval" FOR EACH ROW EXECUTE FUNCTION national_version_immutable();
CREATE TRIGGER marketplace_pricing_immutable BEFORE UPDATE OR DELETE ON "MarketplacePricingPolicy" FOR EACH ROW EXECUTE FUNCTION national_version_immutable();
-- No existing geographic location is guessed or sample policy approved.
