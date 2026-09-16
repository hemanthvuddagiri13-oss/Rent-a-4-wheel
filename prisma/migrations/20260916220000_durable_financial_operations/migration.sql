ALTER TABLE "Reservation"
  ADD COLUMN "financialCheckedAt" TIMESTAMP(3),
  ADD COLUMN "financialDisposition" TEXT NOT NULL DEFAULT 'OPEN',
  ADD COLUMN "bookingFingerprint" TEXT,
  ADD COLUMN "checkoutFingerprint" TEXT;

UPDATE "Reservation" SET "financialDisposition" = 'TERMINATED'
WHERE "status" IN ('CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_HOST');
UPDATE "Reservation" r SET "financialDisposition" = 'REFUND_REQUIRED'
WHERE EXISTS (SELECT 1 FROM "Refund" f WHERE f."reservationId" = r."id"
  AND f."status" IN ('PENDING', 'SUCCEEDED')
  GROUP BY f."reservationId" HAVING SUM(f."amountCents") >= r."totalCents");

-- Old six-day estimates are not Stripe-authoritative. Recovery retrieves the
-- original intent; no new authorization is created to replace an unknown one.
UPDATE "SecurityDeposit" SET "authorizationExpiresAt" = NULL WHERE "status" = 'SUCCEEDED';

ALTER TABLE "OutboxMessage" ADD COLUMN "deliveryKey" TEXT,
  ADD COLUMN "leaseToken" TEXT, ADD COLUMN "leaseExpiresAt" TIMESTAMP(3), ADD COLUMN "firstAttemptAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "OutboxMessage_deliveryKey_key" ON "OutboxMessage"("deliveryKey");
ALTER TABLE "Notification" ADD COLUMN "deliveryKey" TEXT;
CREATE UNIQUE INDEX "Notification_deliveryKey_key" ON "Notification"("deliveryKey");

CREATE TABLE "FinancialOperation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "key" TEXT NOT NULL UNIQUE,
  "kind" TEXT NOT NULL,
  "reservationId" TEXT,
  "fingerprint" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "providerId" TEXT,
  "result" JSONB,
  "state" TEXT NOT NULL DEFAULT 'READY',
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "firstAttemptAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "FinancialOperation_state_nextAttemptAt_idx" ON "FinancialOperation"("state", "nextAttemptAt");
CREATE INDEX "FinancialOperation_reservationId_kind_idx" ON "FinancialOperation"("reservationId", "kind");

-- Enforce immutable provider intent even if a future caller bypasses the service.
CREATE FUNCTION protect_financial_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."key" IS DISTINCT FROM OLD."key" OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."payload" IS DISTINCT FROM OLD."payload" OR NEW."fingerprint" IS DISTINCT FROM OLD."fingerprint"
    OR NEW."reservationId" IS DISTINCT FROM OLD."reservationId" THEN
    RAISE EXCEPTION 'Financial operation intent is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_intent_immutable BEFORE UPDATE ON "FinancialOperation"
FOR EACH ROW EXECUTE FUNCTION protect_financial_intent();

CREATE FUNCTION protect_payment_success() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'SUCCEEDED' AND NEW."status" <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'Captured payment cannot be downgraded';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_success_monotonic BEFORE UPDATE ON "Payment"
FOR EACH ROW EXECUTE FUNCTION protect_payment_success();

CREATE FUNCTION protect_financial_termination() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD."financialDisposition" <> 'OPEN' AND NEW."financialDisposition" = 'OPEN')
    OR (OLD."status" IN ('CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_HOST') AND NEW."status" <> OLD."status") THEN
    RAISE EXCEPTION 'Financial termination cannot be reversed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_termination_monotonic BEFORE UPDATE ON "Reservation"
FOR EACH ROW EXECUTE FUNCTION protect_financial_termination();
