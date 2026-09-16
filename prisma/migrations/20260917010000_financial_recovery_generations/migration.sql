ALTER TABLE "SecurityDeposit" ADD COLUMN "legacyUncertain" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "operationId" TEXT;
ALTER TABLE "Refund" ADD COLUMN "legacyUncertain" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "BookingDraft" ("id" TEXT PRIMARY KEY, "customerId" TEXT NOT NULL, "vehicleId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0, "fingerprint" TEXT, "reservationId" TEXT, "updatedAt" TIMESTAMP(3) NOT NULL);
CREATE INDEX "BookingDraft_customerId_vehicleId_idx" ON "BookingDraft"("customerId","vehicleId");

-- No ID is not proof that Stripe never accepted a pre-ledger request. Quarantine
-- these rows; old deposit keys and refund parameters must never be replaced.
UPDATE "SecurityDeposit" d SET "legacyUncertain" = true
WHERE d."stripePaymentIntentId" IS NULL
  AND (d."status" <> 'REQUIRES_PAYMENT' OR EXISTS (SELECT 1 FROM "Payment" p WHERE p."reservationId"=d."reservationId" AND p."type"='RENTAL' AND p."status"='SUCCEEDED'))
  AND NOT EXISTS (SELECT 1 FROM "FinancialOperation" o WHERE o."reservationId"=d."reservationId" AND o."kind"='DEPOSIT');
UPDATE "Refund" f SET "legacyUncertain" = true
WHERE f."status"='PENDING' AND f."stripeRefundId" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "FinancialOperation" o WHERE o."key"=f."idempotencyKey" AND o."createdAt" <= f."createdAt");
UPDATE "Reservation" r SET "financialDisposition"='REVIEW'
WHERE r."financialDisposition"='OPEN' AND EXISTS
  (SELECT 1 FROM "SecurityDeposit" d WHERE d."reservationId"=r."id" AND d."legacyUncertain");
UPDATE "SecurityDeposit" d SET "operationId" = (
  SELECT o."id" FROM "FinancialOperation" o WHERE o."reservationId"=d."reservationId" AND o."kind"='DEPOSIT'
  ORDER BY o."createdAt" DESC,o."id" DESC LIMIT 1), "generation" = (
  SELECT COUNT(*)::integer FROM "FinancialOperation" o WHERE o."reservationId"=d."reservationId" AND o."kind"='DEPOSIT');

CREATE FUNCTION protect_deposit_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."stripePaymentIntentId" IS NOT DISTINCT FROM OLD."stripePaymentIntentId"
    AND (OLD."status"='CANCELLED' OR OLD."stripeStatus" IN ('canceled','succeeded') OR OLD."releasedAt" IS NOT NULL)
    AND NEW."stripeStatus"='requires_capture' THEN
    RAISE EXCEPTION 'Terminal deposit intent cannot be reauthorized';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deposit_terminal_monotonic BEFORE UPDATE ON "SecurityDeposit"
FOR EACH ROW EXECUTE FUNCTION protect_deposit_terminal();
