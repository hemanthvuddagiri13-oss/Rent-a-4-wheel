-- Existing journals remain untouched. Their original pricing basis is retained.
-- The existing immutable journal trigger also protects this evidence column.
ALTER TABLE "LedgerJournal" ADD COLUMN "allocationEvidence" JSONB;
