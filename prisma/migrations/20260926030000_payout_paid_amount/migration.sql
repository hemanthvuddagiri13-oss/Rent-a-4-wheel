ALTER TABLE "PayoutBatch" ADD COLUMN "paidCents" INTEGER NOT NULL DEFAULT 0;
-- Existing bank payments are recovered from immutable provider-operation evidence,
-- never inferred from gross transfer amount after a partial reversal.
UPDATE "PayoutBatch" b SET "paidCents"=(o.result->>'amount')::integer
FROM "FinancialOperation" o WHERE b.state='PAID' AND o.kind='FINANCE_PAYOUT'
 AND o."providerId"=b."payoutId" AND o.result->>'status'='paid'
 AND (o.result->>'amount') ~ '^[0-9]+$';
ALTER TABLE "PayoutBatch" ADD CHECK ("paidCents">=0 AND "paidCents"<="transferredCents");

CREATE FUNCTION finance_operation_mutation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v record;
BEGIN
 IF OLD.kind LIKE 'FINANCE_%' THEN
  FOR v IN SELECT DISTINCT r."vehicleId" FROM "PayoutItem" i JOIN "Reservation" r ON r.id=i."reservationId" WHERE i."batchId"=OLD.payload->>'batchId' ORDER BY r."vehicleId" LOOP
   PERFORM financial_guard_try_xact('vehicle:'||v."vehicleId");
  END LOOP;
  PERFORM financial_guard_try_xact('host-finance:'||(OLD.payload->>'hostId'));
  PERFORM financial_guard_try_xact('operation:'||OLD.id);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER aa_finance_operation_guard BEFORE UPDATE OR DELETE ON "FinancialOperation" FOR EACH ROW EXECUTE FUNCTION finance_operation_mutation_guard();
