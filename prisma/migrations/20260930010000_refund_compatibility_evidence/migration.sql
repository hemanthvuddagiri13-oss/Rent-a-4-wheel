CREATE TABLE "RefundCompatibilityEvidence" (
 "journalId" TEXT PRIMARY KEY REFERENCES "LedgerJournal"(id),
 "reservationId" TEXT NOT NULL REFERENCES "Reservation"(id),
 "refundId" TEXT NOT NULL UNIQUE REFERENCES "Refund"(id),
 "paymentId" TEXT NOT NULL REFERENCES "Payment"(id),
 version INTEGER NOT NULL CHECK (version = 1),
 "evidenceHash" TEXT NOT NULL,
 "validationResult" TEXT NOT NULL CHECK ("validationResult" = 'VALID_HISTORICAL_V1'),
 inputs JSONB NOT NULL,
 "openingAllocation" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "RefundCompatibilityEvidence_reservationId_idx" ON "RefundCompatibilityEvidence"("reservationId");
CREATE TRIGGER refund_compatibility_immutable BEFORE UPDATE OR DELETE ON "RefundCompatibilityEvidence" FOR EACH ROW EXECUTE FUNCTION finance_immutable();
