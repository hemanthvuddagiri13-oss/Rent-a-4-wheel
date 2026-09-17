ALTER TABLE "Reservation" ADD COLUMN "bookingTimezone" TEXT NOT NULL DEFAULT 'America/Chicago';
ALTER TABLE "SecurityDeposit" ADD COLUMN "capturableAmountCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "FinancialOperation" ADD COLUMN "consecutiveFailures" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "generation" INTEGER, ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 50;
CREATE TABLE "FinancialCase" (
 "id" TEXT PRIMARY KEY, "sourceKey" TEXT NOT NULL UNIQUE, "reservationId" TEXT NOT NULL, "customerId" TEXT NOT NULL,
 "operationId" TEXT, "refundId" TEXT, "paymentId" TEXT, "kind" TEXT NOT NULL, "amountCents" INTEGER NOT NULL,
 "currency" TEXT NOT NULL DEFAULT 'usd', "originalKey" TEXT, "providerId" TEXT, "reason" TEXT NOT NULL,
 "evidence" JSONB, "status" TEXT NOT NULL DEFAULT 'OPEN', "assignedToId" TEXT, "attempts" INTEGER NOT NULL DEFAULT 0,
 "lastError" TEXT, "resolution" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "resolvedAt" TIMESTAMP(3)
);
CREATE INDEX "FinancialCase_status_createdAt_idx" ON "FinancialCase"("status", "createdAt");
CREATE INDEX "FinancialCase_reservationId_idx" ON "FinancialCase"("reservationId");
CREATE INDEX "financial_recovery_due_idx" ON "FinancialOperation"("kind", "state", "priority", "nextAttemptAt", "createdAt");
CREATE INDEX "Reservation_financialCheckedAt_id_idx" ON "Reservation"("financialCheckedAt", "id");
CREATE INDEX "Refund_status_legacyUncertain_createdAt_idx" ON "Refund"("status", "legacyUncertain", "createdAt");
UPDATE "Refund" f SET "legacyUncertain"=true WHERE f."status"='PENDING' AND f."stripeRefundId" IS NULL AND NOT EXISTS (SELECT 1 FROM "FinancialOperation" o WHERE o."key"=f."idempotencyKey" AND o."kind"='REFUND');
-- A legacy FAILED projection is not authoritative rejection evidence. Preserve
-- the old status and reserve its balance until Stripe identity is reconciled.
UPDATE "Refund" f SET "legacyUncertain" = true
WHERE f."status" = 'FAILED' AND NOT EXISTS (
 SELECT 1 FROM "FinancialOperation" o WHERE o."key" = f."idempotencyKey" AND o."kind" = 'REFUND'
 AND o."providerId" = f."stripeRefundId" AND o."result"->>'id' = f."stripeRefundId"
 AND o."result"->>'status' IN ('failed','canceled')
 AND o."result"->>'amount' = f."amountCents"::text
);
-- Preserve the pre-upgrade ownership evidence. Multiple legacy attempts have
-- no trustworthy generation chronology, even if only one matches the cached ID.
INSERT INTO "FinancialCase" ("id","sourceKey","reservationId","customerId","kind","amountCents","providerId","reason","evidence")
SELECT 'case-deposit-'||d."id",'deposit:'||d."id",r."id",r."customerId",'DEPOSIT',d."amountCents",d."stripePaymentIntentId",'LEGACY_GENERATION_OWNERSHIP_AMBIGUOUS',jsonb_build_object('previousOperationId',d."operationId",'previousGeneration',d."generation")
FROM "SecurityDeposit" d JOIN "Reservation" r ON r."id"=d."reservationId" WHERE (SELECT count(*) FROM "FinancialOperation" o WHERE o."reservationId"=d."reservationId" AND o."kind"='DEPOSIT')>1;
UPDATE "SecurityDeposit" d SET "legacyUncertain"=true WHERE (SELECT count(*) FROM "FinancialOperation" o WHERE o."reservationId"=d."reservationId" AND o."kind"='DEPOSIT')>1;
-- Identity, not chronology, owns a deposit. Only a unique exact provider
-- identity may be bound. Capturable amount is refreshed from Stripe, never
-- invented from the requested authorization amount.
UPDATE "SecurityDeposit" d SET "operationId" = o."id", "generation" = GREATEST(d."generation",1)
FROM "FinancialOperation" o WHERE o."reservationId"=d."reservationId" AND o."kind"='DEPOSIT'
 AND o."providerId"=d."stripePaymentIntentId"
 AND (SELECT count(*) FROM "FinancialOperation" x WHERE x."reservationId"=d."reservationId" AND x."kind"='DEPOSIT' AND x."providerId"=d."stripePaymentIntentId")=1;
UPDATE "FinancialOperation" o SET "generation"=d."generation", "state"='RETRY', "nextAttemptAt"=CURRENT_TIMESTAMP
FROM "SecurityDeposit" d WHERE d."operationId"=o."id" AND o."providerId"=d."stripePaymentIntentId" AND o."kind"='DEPOSIT';
UPDATE "SecurityDeposit" d SET "legacyUncertain"=true, "operationId"=NULL
WHERE d."legacyUncertain" OR (d."stripePaymentIntentId" IS NOT NULL OR d."status" <> 'REQUIRES_PAYMENT') AND NOT EXISTS
 (SELECT 1 FROM "FinancialOperation" o WHERE o."id"=d."operationId" AND o."reservationId"=d."reservationId" AND o."kind"='DEPOSIT' AND o."providerId"=d."stripePaymentIntentId" AND o."generation"=d."generation"
 AND (SELECT count(*) FROM "FinancialOperation" x WHERE x."reservationId"=d."reservationId" AND x."kind"='DEPOSIT' AND x."providerId"=d."stripePaymentIntentId")=1);
UPDATE "SecurityDeposit" d SET "operationId"=NULL WHERE "operationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "FinancialOperation" o WHERE o."id"=d."operationId");
ALTER TABLE "SecurityDeposit" ADD CONSTRAINT "SecurityDeposit_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "FinancialOperation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
INSERT INTO "FinancialCase" ("id","sourceKey","reservationId","customerId","refundId","kind","amountCents","originalKey","providerId","reason","evidence")
SELECT 'case-refund-'||f."id", 'refund:'||f."id",r."id",r."customerId",f."id",'REFUND',f."amountCents",f."idempotencyKey",f."stripeRefundId",'LEGACY_REFUND_OUTCOME_UNCERTAIN',jsonb_build_object('previousStatus',f."status",'lastError',f."lastError")
FROM "Refund" f JOIN "Reservation" r ON r."id"=f."reservationId" WHERE f."legacyUncertain";
INSERT INTO "FinancialCase" ("id","sourceKey","reservationId","customerId","kind","amountCents","providerId","reason","evidence")
SELECT 'case-deposit-'||d."id",'deposit:'||d."id",r."id",r."customerId",'DEPOSIT',d."amountCents",d."stripePaymentIntentId",'DEPOSIT_OWNERSHIP_UNVERIFIED',jsonb_build_object('generation',d."generation",'previousStatus',d."status")
FROM "SecurityDeposit" d JOIN "Reservation" r ON r."id"=d."reservationId" WHERE d."legacyUncertain" ON CONFLICT ("sourceKey") DO NOTHING;
UPDATE "FinancialOperation" o SET "state"='REVIEW' FROM "SecurityDeposit" d WHERE d."reservationId"=o."reservationId" AND d."legacyUncertain" AND o."kind"='DEPOSIT';
INSERT INTO "FinancialCase" ("id","sourceKey","reservationId","customerId","operationId","kind","amountCents","originalKey","providerId","reason","evidence")
SELECT 'case-op-'||o."id",'operation:'||o."id",r."id",r."customerId",o."id",o."kind",COALESCE((o."payload"->>'amount')::integer,0),o."key",o."providerId",'PROVIDER_OUTCOME_UNCERTAIN',jsonb_build_object('attempts',o."attempts",'lastError',o."lastError")
FROM "FinancialOperation" o JOIN "Reservation" r ON r."id"=o."reservationId" WHERE o."state"='REVIEW';
UPDATE "Reservation" r SET "financialDisposition"='REVIEW' WHERE EXISTS (SELECT 1 FROM "FinancialCase" c WHERE c."reservationId"=r."id");
-- Historical terminal observations do not enter urgent work; unresolved
-- provider objects and pending refunds have an explicit polling obligation.
UPDATE "FinancialOperation" SET "state"='POLL', "nextAttemptAt"=CURRENT_TIMESTAMP
WHERE "state"='OBSERVED' AND (("kind"='REFUND' AND COALESCE("result"->>'status','') NOT IN ('succeeded','failed','canceled'))
 OR ("kind"='RENTAL' AND COALESCE("result"->>'status','') NOT IN ('succeeded','canceled')));

-- Existing known refunds are adopted on demand by the operator workflow.

INSERT INTO "FinancialCase" ("id","sourceKey","reservationId","customerId","kind","amountCents","reason")
SELECT 'case-reservation-'||r."id",'reservation:'||r."id",r."id",r."customerId",'RENTAL',r."totalCents",'LEGACY_RESERVATION_REVIEW'
FROM "Reservation" r WHERE r."financialDisposition"='REVIEW' AND NOT EXISTS (SELECT 1 FROM "FinancialCase" c WHERE c."reservationId"=r."id");



INSERT INTO "FinancialCase" ("id","sourceKey","reservationId","customerId","paymentId","kind","amountCents","currency","originalKey","reason","evidence")
SELECT 'case-payment-'||p."id",'payment:'||p."id",r."id",r."customerId",p."id",'RENTAL',p."amountCents",p."currency",p."idempotencyKey",'LEGACY_PAYMENT_OUTCOME_UNCERTAIN',jsonb_build_object('previousStatus',p."status")
FROM "Payment" p JOIN "Reservation" r ON r."id"=p."reservationId" WHERE p."type"='RENTAL' AND p."stripePaymentIntentId" IS NULL AND p."status" IN ('PROCESSING','FAILED','SUCCEEDED') AND NOT EXISTS (SELECT 1 FROM "FinancialOperation" o WHERE o."key"=p."idempotencyKey" AND o."kind"='RENTAL');
UPDATE "Reservation" r SET "financialDisposition"='REVIEW' WHERE EXISTS (SELECT 1 FROM "FinancialCase" c WHERE c."reservationId"=r."id" AND c."status"='OPEN');
UPDATE "FinancialOperation" SET "priority"=CASE WHEN "kind" IN ('REFUND','DEPOSIT_RELEASE') THEN 10 WHEN "kind"='RENTAL' THEN 20 ELSE 50 END;
