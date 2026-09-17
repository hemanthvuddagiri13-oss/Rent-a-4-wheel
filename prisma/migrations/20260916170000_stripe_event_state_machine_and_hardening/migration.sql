-- Hardening pass following independent review of commit 5459da5:
--  - StripeEvent gains a real RECEIVED/PROCESSING/PROCESSED/FAILED state
--    machine (attemptCount/lastError/receivedAt/processingStartedAt/
--    processedAt/nextRetryAt) instead of being "claimed" by mere
--    existence, so a failed processing attempt is retryable instead of
--    being permanently mistaken for a duplicate.
--  - PaymentReconciliation records every case where a Stripe payment
--    succeeded but couldn't cleanly produce a confirmed reservation
--    (expired hold, dates no longer available, a DB failure after a
--    successful Stripe-side call) so a successful charge is never
--    silently lost.
--  - EmergencyOverrideRecord + Role.SUPER_ADMIN replace the old ordinary
--    "force" admin quick-actions with an audited, step-up-verified
--    escape hatch.
--  - MalwareScanStatus.NOT_SCANNED is renamed to QUARANTINED: a newly
--    uploaded document is not merely "not yet looked at", it is actively
--    held back from host/reviewer access until a scan clears it (or, in
--    production, rejected outright if no scanner is configured — see
--    src/lib/documents.ts). The enum rename preserves existing rows'
--    values (Postgres reassigns the same ordinal to the renamed label).
-- CreateEnum
CREATE TYPE "StripeEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReconciliationReason" AS ENUM ('DEPOSIT_AUTH_SUCCEEDED_DB_UPDATE_FAILED', 'PAYMENT_SUCCEEDED_AFTER_HOLD_EXPIRED', 'PAYMENT_SUCCEEDED_DATES_UNAVAILABLE', 'WEBHOOK_PROCESSING_REPEATEDLY_FAILED');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('OPEN', 'AUTO_RESOLVED', 'REFUNDED', 'NEEDS_MANUAL_REVIEW', 'RESOLVED');

-- AlterEnum
ALTER TYPE "AuthCodePurpose" ADD VALUE 'EMERGENCY_OVERRIDE_STEP_UP';

-- AlterEnum
-- A true rename (not the create-new-type-and-cast dance Prisma's own diff
-- generated here originally) — that naive approach fails outright on any
-- database with existing DriverDocument rows, since none of them have a
-- 'NOT_SCANNED'-equivalent label to cast into in a brand-new enum that
-- only defines 'QUARANTINED'. `RENAME VALUE` reassigns the same
-- underlying enum ordinal to a new label, so every existing row's value
-- is preserved automatically with no data migration needed, and (unlike
-- `ADD VALUE`) it is fully transaction-safe.
ALTER TYPE "MalwareScanStatus" RENAME VALUE 'NOT_SCANNED' TO 'QUARANTINED';
ALTER TABLE "DriverDocument" ALTER COLUMN "malwareScanStatus" SET DEFAULT 'QUARANTINED';

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'SUPER_ADMIN';

-- AlterTable
ALTER TABLE "StripeEvent" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "nextRetryAt" TIMESTAMP(3),
ADD COLUMN     "processingStartedAt" TIMESTAMP(3),
ADD COLUMN     "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "status" "StripeEventStatus" NOT NULL DEFAULT 'RECEIVED',
ALTER COLUMN "processedAt" DROP NOT NULL,
ALTER COLUMN "processedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "PaymentReconciliation" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT,
    "paymentId" TEXT,
    "stripePaymentIntentId" TEXT,
    "reason" "ReconciliationReason" NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'OPEN',
    "detail" JSONB,
    "refundId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "PaymentReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyOverrideRecord" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "originalStatus" "ReservationStatus" NOT NULL,
    "resultingStatus" "ReservationStatus" NOT NULL,
    "unmetGateReasons" JSONB NOT NULL,
    "stepUpVerifiedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmergencyOverrideRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentReconciliation_status_idx" ON "PaymentReconciliation"("status");

-- CreateIndex
CREATE INDEX "PaymentReconciliation_reservationId_idx" ON "PaymentReconciliation"("reservationId");

-- CreateIndex
CREATE INDEX "EmergencyOverrideRecord_reservationId_idx" ON "EmergencyOverrideRecord"("reservationId");

-- CreateIndex
CREATE INDEX "StripeEvent_status_idx" ON "StripeEvent"("status");

-- AddForeignKey
ALTER TABLE "PaymentReconciliation" ADD CONSTRAINT "PaymentReconciliation_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyOverrideRecord" ADD CONSTRAINT "EmergencyOverrideRecord_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyOverrideRecord" ADD CONSTRAINT "EmergencyOverrideRecord_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

