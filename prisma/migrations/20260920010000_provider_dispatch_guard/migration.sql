CREATE TABLE "FinancialDispatch" (
 "id" text PRIMARY KEY, "operationId" text NOT NULL REFERENCES "FinancialOperation"("id") ON DELETE CASCADE,
 "leaseToken" text NOT NULL, "phase" text NOT NULL CHECK ("phase" IN ('DISPATCHED','SUCCEEDED','UNCERTAIN')),
 "providerId" text, "result" jsonb, "errorCode" text, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "FinancialDispatch_operationId_createdAt_idx" ON "FinancialDispatch"("operationId","createdAt");

-- Two sorted 64-bit portions of SHA-256. Collisions only over-serialize; the
-- complete operation/owner identity is always revalidated after acquisition.
CREATE FUNCTION financial_guard_keys(scope text) RETURNS SETOF bigint LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT DISTINCT ('x'||part)::bit(64)::bigint FROM
 (SELECT substr(encode(sha256(convert_to('rent-a-4wheel:dispatch:v1:'||scope,'UTF8')),'hex'),n,16) part FROM unnest(ARRAY[1,17]) n) s ORDER BY 1
$$;
CREATE FUNCTION financial_guard_xact(scope text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE k bigint; BEGIN FOR k IN SELECT * FROM financial_guard_keys(scope) LOOP PERFORM pg_advisory_xact_lock(k); END LOOP; RETURN true; END $$;
CREATE FUNCTION financial_guard_session(scope text,acquire boolean) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE k bigint; BEGIN FOR k IN SELECT * FROM financial_guard_keys(scope) LOOP
 IF acquire THEN PERFORM pg_advisory_lock(k); ELSE PERFORM pg_advisory_unlock(k); END IF;
 END LOOP; RETURN true; END $$;
CREATE FUNCTION financial_guard_try_xact(scope text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE k bigint; BEGIN FOR k IN SELECT * FROM financial_guard_keys(scope) LOOP
 IF NOT pg_try_advisory_xact_lock(k) THEN RAISE EXCEPTION 'Financial dispatch guard busy; retry transaction' USING ERRCODE='40001'; END IF;
 END LOOP; RETURN true; END $$;
CREATE OR REPLACE FUNCTION financial_authority_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v jsonb; r text; vehicle text; scope text;
BEGIN
 -- Row triggers use try-lock, never wait while holding a row a dispatcher may
 -- need. Normal application writers acquire the blocking guard before row locks.
 FOR v IN SELECT to_jsonb(OLD) WHERE TG_OP<>'INSERT' UNION ALL SELECT to_jsonb(NEW) WHERE TG_OP<>'DELETE' LOOP
   IF TG_TABLE_NAME='StripeEvent' THEN scope:='event:'||(v->>'id');
   ELSIF TG_TABLE_NAME='Reservation' THEN scope:='vehicle:'||(v->>'vehicleId');
   ELSE
     r:=v->>'reservationId';
     IF TG_TABLE_NAME='ConditionPhoto' THEN SELECT "reservationId" INTO r FROM "ConditionReport" WHERE "id"=v->>'conditionReportId'; END IF;
     SELECT "vehicleId" INTO vehicle FROM "Reservation" WHERE "id"=r;
     scope:=CASE WHEN vehicle IS NOT NULL THEN 'vehicle:'||vehicle ELSE 'operation:'||(v->>'id') END;
   END IF;
   IF scope IS NOT NULL THEN PERFORM financial_guard_try_xact(scope); END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER aa_financial_guard BEFORE INSERT OR UPDATE OR DELETE ON "FinancialOperation" FOR EACH ROW EXECUTE FUNCTION financial_authority_guard();
CREATE TRIGGER aa_financial_guard BEFORE INSERT OR UPDATE OR DELETE ON "ProviderObjectOwnership" FOR EACH ROW EXECUTE FUNCTION financial_authority_guard();
CREATE TRIGGER aa_financial_guard BEFORE INSERT OR UPDATE OR DELETE ON "Reservation" FOR EACH ROW EXECUTE FUNCTION financial_authority_guard();
CREATE TRIGGER aa_financial_guard BEFORE INSERT OR UPDATE OR DELETE ON "SecurityDeposit" FOR EACH ROW EXECUTE FUNCTION financial_authority_guard();
CREATE TRIGGER aa_financial_guard BEFORE INSERT OR UPDATE OR DELETE ON "Payment" FOR EACH ROW EXECUTE FUNCTION financial_authority_guard();
CREATE TRIGGER aa_financial_guard BEFORE INSERT OR UPDATE OR DELETE ON "Refund" FOR EACH ROW EXECUTE FUNCTION financial_authority_guard();
CREATE TRIGGER aa_financial_guard BEFORE INSERT OR UPDATE OR DELETE ON "StripeEvent" FOR EACH ROW EXECUTE FUNCTION financial_authority_guard();

-- Customers are user-scoped and never own rental/deposit/refund identities.
CREATE OR REPLACE FUNCTION enforce_provider_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid text;k text;o text;p text;d text;f text;
BEGIN
 IF TG_TABLE_NAME='FinancialOperation' THEN
   IF NEW."kind"='CUSTOMER' AND NEW."reservationId" IS NULL THEN RETURN NEW; END IF;
   pid:=NEW."providerId";k:=NEW."kind";o:=NEW."id";
   IF k='DEPOSIT_RELEASE' THEN k:='DEPOSIT';o:=NULL; END IF;
 ELSIF TG_TABLE_NAME='Payment' THEN pid:=NEW."stripePaymentIntentId";p:=NEW."id";k:=CASE WHEN NEW."type" IN ('DEPOSIT_AUTH','DEPOSIT_CAPTURE') THEN 'DEPOSIT' ELSE NEW."type"::text END;
 ELSIF TG_TABLE_NAME='SecurityDeposit' THEN pid:=NEW."stripePaymentIntentId";d:=NEW."id";k:='DEPOSIT';
 ELSE pid:=NEW."stripeRefundId";f:=NEW."id";k:='REFUND'; END IF;
 IF pid IS NOT NULL THEN PERFORM claim_provider_object(pid,k,NEW."reservationId",o,p,d,f); END IF;
 RETURN NEW;
END $$;

-- All inputs to the trip-start gate share the same reservation authority guard.
CREATE TRIGGER aa_financial_guard BEFORE INSERT OR UPDATE OR DELETE ON "DriverDocument" FOR EACH ROW EXECUTE FUNCTION financial_authority_guard();
CREATE TRIGGER aa_financial_guard BEFORE INSERT OR UPDATE OR DELETE ON "AgreementAcceptance" FOR EACH ROW EXECUTE FUNCTION financial_authority_guard();
CREATE TRIGGER aa_financial_guard BEFORE INSERT OR UPDATE OR DELETE ON "IdentityHandoffVerification" FOR EACH ROW EXECUTE FUNCTION financial_authority_guard();
CREATE TRIGGER aa_financial_guard BEFORE INSERT OR UPDATE OR DELETE ON "ConditionReport" FOR EACH ROW EXECUTE FUNCTION financial_authority_guard();
CREATE TRIGGER aa_financial_guard BEFORE INSERT OR UPDATE OR DELETE ON "ConditionPhoto" FOR EACH ROW EXECUTE FUNCTION financial_authority_guard();
CREATE TRIGGER aa_financial_guard BEFORE INSERT OR UPDATE OR DELETE ON "Trip" FOR EACH ROW EXECUTE FUNCTION financial_authority_guard();
CREATE FUNCTION protect_agreement_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW."type",NEW."documentVersion",NEW."contentHash",NEW."contentSnapshot",NEW."signedByUserId",NEW."signerName",NEW."signedAt",NEW."ipAddress",NEW."userAgent") IS DISTINCT FROM
    ROW(OLD."type",OLD."documentVersion",OLD."contentHash",OLD."contentSnapshot",OLD."signedByUserId",OLD."signerName",OLD."signedAt",OLD."ipAddress",OLD."userAgent") THEN
   RAISE EXCEPTION 'Signed agreement evidence is immutable';
 END IF;
 IF OLD."signedPdfStorageKey" IS NOT NULL AND NEW."signedPdfStorageKey" IS DISTINCT FROM OLD."signedPdfStorageKey" THEN RAISE EXCEPTION 'Signed PDF identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agreement_snapshot_immutable BEFORE UPDATE ON "AgreementAcceptance" FOR EACH ROW EXECUTE FUNCTION protect_agreement_snapshot();
