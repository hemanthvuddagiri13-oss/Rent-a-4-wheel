-- CreateEnum
CREATE TYPE "OutboxMessageStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterEnum
ALTER TYPE "RefundStatus" ADD VALUE 'CANCELLED';

-- AlterTable: Refund
-- `idempotencyKey` is added NULLABLE first and backfilled from each
-- existing row's own id (a stable, guaranteed-unique placeholder) before
-- being made NOT NULL, so this migration does not fail on a database that
-- already has Refund rows — the same pattern used throughout this
-- project's migrations for adding a new required column.
ALTER TABLE "Refund" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "initiatedById" TEXT,
ADD COLUMN     "lastError" TEXT;

UPDATE "Refund" SET "idempotencyKey" = 'legacy-' || "id" WHERE "idempotencyKey" IS NULL;

ALTER TABLE "Refund" ALTER COLUMN "idempotencyKey" SET NOT NULL;

-- AlterTable
ALTER TABLE "SecurityDeposit" ADD COLUMN     "authorizationExpiresAt" TIMESTAMP(3),
ADD COLUMN     "authorizedAt" TIMESTAMP(3),
ADD COLUMN     "stripeStatus" TEXT;

-- AlterTable
ALTER TABLE "StripeEvent" ADD COLUMN     "leaseToken" TEXT;

-- CreateTable
CREATE TABLE "OutboxMessage" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxMessageStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),

    CONSTRAINT "OutboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboxMessage_status_nextRetryAt_idx" ON "OutboxMessage"("status", "nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_idempotencyKey_key" ON "Refund"("idempotencyKey");

-- Extend the overlap exclusion constraint to also cover PAYMENT_FAILED:
-- that status now blocks the vehicle unconditionally too (we're still
-- holding the customer's rental payment and may yet recover the deposit
-- or re-confirm — see src/lib/payment-reconciliation.ts), so the
-- database-level guarantee against overlapping bookings must include it,
-- consistent with DURABLE_BLOCKING_STATUSES in
-- src/lib/reservation-state-machine.ts. Constraints can't be altered in
-- place — drop and recreate with the same shape plus the one added value.
ALTER TABLE "Reservation" DROP CONSTRAINT "reservation_no_overlap_when_blocking";

ALTER TABLE "Reservation"
  ADD CONSTRAINT "reservation_no_overlap_when_blocking"
  EXCLUDE USING gist (
    "vehicleId" WITH =,
    "duringRange" WITH &&
  )
  WHERE (
    "status" IN (
      'CONFIRMED',
      'DOCUMENTS_REQUIRED',
      'READY_FOR_CHECK_IN',
      'CHECK_IN_PROGRESS',
      'READY_TO_START',
      'ACTIVE',
      'RETURN_IN_PROGRESS',
      'DISPUTED',
      'UNDER_CLAIM_REVIEW',
      'PAYMENT_FAILED'
    )
  );

