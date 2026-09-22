-- Statement-level fencing precedes row locks, matching provider dispatch order.
CREATE FUNCTION national_authority_fence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('release-control',0));
 RETURN NULL;
END $$;
CREATE TRIGGER jurisdiction_authority_fence BEFORE INSERT OR UPDATE OR DELETE ON "Jurisdiction" FOR EACH STATEMENT EXECUTE FUNCTION national_authority_fence();
CREATE TRIGGER jurisdiction_approval_fence BEFORE INSERT OR UPDATE OR DELETE ON "JurisdictionApproval" FOR EACH STATEMENT EXECUTE FUNCTION national_authority_fence();
CREATE TRIGGER pricing_policy_fence BEFORE INSERT OR UPDATE OR DELETE ON "MarketplacePricingPolicy" FOR EACH STATEMENT EXECUTE FUNCTION national_authority_fence();
CREATE FUNCTION reservation_jurisdiction_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD."jurisdictionCode" IS NOT NULL AND (NEW."jurisdictionCode" IS DISTINCT FROM OLD."jurisdictionCode" OR NEW."jurisdictionSnapshot" IS DISTINCT FROM OLD."jurisdictionSnapshot") THEN
  RAISE EXCEPTION 'Reservation jurisdiction evidence is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reservation_jurisdiction_immutable BEFORE UPDATE ON "Reservation" FOR EACH ROW EXECUTE FUNCTION reservation_jurisdiction_immutable();
