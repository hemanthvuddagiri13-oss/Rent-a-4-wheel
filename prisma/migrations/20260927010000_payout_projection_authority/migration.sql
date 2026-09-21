CREATE TABLE "AccountingCheckpoint" (
 "reservationId" TEXT PRIMARY KEY REFERENCES "Reservation"(id) ON DELETE CASCADE,
 fingerprint TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "PayoutBankProjection" (
 "operationId" TEXT PRIMARY KEY REFERENCES "FinancialOperation"(id),
 "batchId" TEXT NOT NULL REFERENCES "PayoutBatch"(id),
 "providerId" TEXT NOT NULL UNIQUE, currency TEXT NOT NULL,
 "amountCents" INTEGER NOT NULL CHECK("amountCents">0), status TEXT NOT NULL,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PayoutBankProjection_batchId_idx" ON "PayoutBankProjection"("batchId");
ALTER TABLE "PayoutBatch" ADD COLUMN "pendingBankCents" INTEGER NOT NULL DEFAULT 0;
-- Backfill only projections proven by the current owned, observed generation.
-- All other historic receipts deliberately require recovery before reversal.
INSERT INTO "PayoutBankProjection" ("operationId","batchId","providerId",currency,"amountCents",status)
SELECT o.id,b.id,o."providerId",b.currency,(o.result->>'amount')::integer,o.result->>'status'
FROM "PayoutBatch" b JOIN "FinancialOperation" o ON o.key='payout:'||b.id||':'||b.generation
WHERE o.kind='FINANCE_PAYOUT' AND o.state='OBSERVED' AND o."providerId"=b."payoutId"
 AND o.result->>'id'=o."providerId" AND o.result->>'currency'=b.currency
 AND (o.result->>'amount') ~ '^[1-9][0-9]*$'
 AND CASE WHEN (o.result->>'amount') ~ '^[1-9][0-9]*$' THEN (o.result->>'amount')::numeric<=2147483647 ELSE false END
 AND o.result->>'status' IN ('paid','failed','canceled','pending','in_transit');
UPDATE "PayoutBatch" b SET "pendingBankCents"=p."amountCents"
FROM "PayoutBankProjection" p WHERE p."batchId"=b.id AND p.status IN ('pending','in_transit');
-- Preserve historical evidence, quarantine deficits, and reject all new invalid
-- materialized states. Proper reversing journals remain unrestricted.
INSERT INTO "FinanceIssue" (id,key,kind,"hostId",reason,evidence)
SELECT 'balance-migration:'||id,'bank-movement:'||id,'BANK_MOVEMENT_INCOMPLETE',"hostId",
 'Historical Connect balance requires authoritative reconciliation',jsonb_build_object('batchId',id)
FROM "PayoutBatch" WHERE "paidCents"+"pendingBankCents"+"reversedCents"+"reversalReservedCents">"transferredCents";
ALTER TABLE "PayoutBatch" ADD CONSTRAINT payout_available_funds_nonnegative
 CHECK ("pendingBankCents">=0 AND "paidCents"+"pendingBankCents"+"reversedCents"+"reversalReservedCents"<="transferredCents") NOT VALID;
CREATE FUNCTION bank_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b record; v record;
BEGIN
 SELECT * INTO b FROM "PayoutBatch" WHERE id=COALESCE(NEW."batchId",OLD."batchId");
 FOR v IN SELECT DISTINCT r."vehicleId" FROM "PayoutItem" i JOIN "Reservation" r ON r.id=i."reservationId" WHERE i."batchId"=b.id ORDER BY r."vehicleId" LOOP
  PERFORM financial_guard_try_xact('vehicle:'||v."vehicleId");
 END LOOP;
 PERFORM financial_guard_try_xact('host-finance:'||b."hostId");
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Bank projection evidence cannot be deleted'; END IF;
 IF TG_OP='UPDATE' AND (NEW."operationId",NEW."batchId",NEW."providerId",NEW.currency,NEW."amountCents") IS DISTINCT FROM (OLD."operationId",OLD."batchId",OLD."providerId",OLD.currency,OLD."amountCents") THEN RAISE EXCEPTION 'Immutable bank projection identity'; END IF;
 IF TG_OP='UPDATE' AND OLD.status='paid' AND NEW.status<>'paid' THEN RAISE EXCEPTION 'Paid bank projection cannot regress'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bank_projection_guard BEFORE INSERT OR UPDATE OR DELETE ON "PayoutBankProjection" FOR EACH ROW EXECUTE FUNCTION bank_projection_guard();
CREATE TRIGGER accounting_checkpoint_guard BEFORE INSERT OR UPDATE OR DELETE ON "AccountingCheckpoint" FOR EACH ROW EXECUTE FUNCTION financial_authority_guard();
