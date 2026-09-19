ALTER TYPE "Role" ADD VALUE 'FINANCE_AGENT';
ALTER TYPE "AuthCodePurpose" ADD VALUE 'FINANCE_STEP_UP';
CREATE TABLE "FinanceRule" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "kind" TEXT NOT NULL,
 "scope" TEXT NOT NULL,
 "scopeId" TEXT NOT NULL DEFAULT '*',
 "version" INTEGER NOT NULL,
 "config" JSONB NOT NULL,
 "effectiveAt" TIMESTAMP(3) NOT NULL,
 "endsAt" TIMESTAMP(3),
 "approvedAt" TIMESTAMP(3),
 "approvedById" TEXT,
 "createdById" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("kind","scope","scopeId","version")
);
CREATE INDEX "FinanceRule_kind_approvedAt_effectiveAt_idx" ON "FinanceRule" ("kind","approvedAt","effectiveAt");
CREATE TABLE "FinanceSnapshot" (
 "reservationId" TEXT NOT NULL PRIMARY KEY,
 "hostId" TEXT,
 "currency" TEXT NOT NULL DEFAULT 'usd',
 "commission" JSONB NOT NULL,
 "tax" JSONB NOT NULL,
 "settlement" JSONB NOT NULL,
 "amounts" JSONB NOT NULL,
 "approved" BOOLEAN NOT NULL DEFAULT false,
 "frozenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "contentHash" TEXT NOT NULL
);
CREATE TABLE "ConnectAccount" (
 "hostId" TEXT NOT NULL PRIMARY KEY,
 "accountId" TEXT UNIQUE,
 "operationId" TEXT UNIQUE,
 "active" BOOLEAN NOT NULL DEFAULT true,
 "detailsSubmitted" BOOLEAN NOT NULL DEFAULT false,
 "chargesEnabled" BOOLEAN NOT NULL DEFAULT false,
 "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
 "currentlyDue" JSONB NOT NULL DEFAULT '[]',
 "eventuallyDue" JSONB NOT NULL DEFAULT '[]',
 "disabledReason" TEXT,
 "verificationStatus" TEXT NOT NULL DEFAULT 'MISSING',
 "taxStatus" TEXT NOT NULL DEFAULT 'MISSING',
 "schedule" TEXT NOT NULL DEFAULT 'MANUAL',
 "timezone" TEXT NOT NULL DEFAULT 'America/Chicago',
 "minimumCents" INTEGER NOT NULL DEFAULT 100,
 "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "synchronizedAt" TIMESTAMP(3),
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "FinanceGrant" (
 "hostId" TEXT NOT NULL,
 "userId" TEXT NOT NULL,
 "manage" BOOLEAN NOT NULL DEFAULT false,
 "grantedById" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("hostId","userId")
);
CREATE TABLE "LedgerJournal" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "key" TEXT NOT NULL UNIQUE,
 "kind" TEXT NOT NULL,
 "currency" TEXT NOT NULL,
 "reservationId" TEXT,
 "hostId" TEXT,
 "operationId" TEXT,
 "providerId" TEXT,
 "reversalOf" TEXT UNIQUE,
 "description" TEXT NOT NULL,
 "fingerprint" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "LedgerJournal_reservationId_createdAt_idx" ON "LedgerJournal" ("reservationId","createdAt");
CREATE INDEX "LedgerJournal_hostId_createdAt_idx" ON "LedgerJournal" ("hostId","createdAt");
CREATE TABLE "LedgerLine" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "journalId" TEXT NOT NULL,
 "account" TEXT NOT NULL,
 "debitCents" INTEGER NOT NULL DEFAULT 0,
 "creditCents" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX "LedgerLine_journalId_idx" ON "LedgerLine" ("journalId");
CREATE INDEX "LedgerLine_account_idx" ON "LedgerLine" ("account");
CREATE TABLE "HostEarning" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "reservationId" TEXT NOT NULL UNIQUE,
 "hostId" TEXT NOT NULL,
 "currency" TEXT NOT NULL DEFAULT 'usd',
 "grossCents" INTEGER NOT NULL,
 "commissionCents" INTEGER NOT NULL,
 "hostDiscountCents" INTEGER NOT NULL,
 "netCents" INTEGER NOT NULL,
 "refundedCents" INTEGER NOT NULL DEFAULT 0,
 "adjustmentCents" INTEGER NOT NULL DEFAULT 0,
 "availableAt" TIMESTAMP(3),
 "checkedAt" TIMESTAMP(3),
 "holdReason" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "HostEarning_hostId_checkedAt_idx" ON "HostEarning" ("hostId","checkedAt");
CREATE TABLE "PayoutBatch" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "hostId" TEXT NOT NULL,
 "accountId" TEXT NOT NULL,
 "currency" TEXT NOT NULL,
 "amountCents" INTEGER NOT NULL,
 "state" TEXT NOT NULL DEFAULT 'PLANNED',
 "transferId" TEXT UNIQUE,
 "payoutId" TEXT UNIQUE,
 "transferredCents" INTEGER NOT NULL DEFAULT 0,
 "reversedCents" INTEGER NOT NULL DEFAULT 0,
 "reversalReservedCents" INTEGER NOT NULL DEFAULT 0,
 "generation" INTEGER NOT NULL DEFAULT 1,
 "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "reason" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "PayoutBatch_state_nextAttemptAt_idx" ON "PayoutBatch" ("state","nextAttemptAt");
CREATE INDEX "PayoutBatch_hostId_createdAt_idx" ON "PayoutBatch" ("hostId","createdAt");
CREATE TABLE "PayoutItem" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "batchId" TEXT NOT NULL,
 "earningId" TEXT NOT NULL,
 "reservationId" TEXT NOT NULL,
 "amountCents" INTEGER NOT NULL,
 "active" BOOLEAN NOT NULL DEFAULT true,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("batchId","earningId")
);
CREATE INDEX "PayoutItem_earningId_idx" ON "PayoutItem" ("earningId");
CREATE TABLE "PayoutReversal" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "key" TEXT NOT NULL UNIQUE,
 "batchId" TEXT NOT NULL,
 "amountCents" INTEGER NOT NULL,
 "reason" TEXT NOT NULL,
 "operationId" TEXT UNIQUE,
 "providerId" TEXT UNIQUE,
 "state" TEXT NOT NULL DEFAULT 'PLANNED',
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "FinanceObject" (
 "providerId" TEXT NOT NULL PRIMARY KEY,
 "hostId" TEXT NOT NULL,
 "operationId" TEXT NOT NULL,
 "kind" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "FinanceIssue" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "key" TEXT NOT NULL UNIQUE,
 "reservationId" TEXT,
 "hostId" TEXT,
 "operationId" TEXT,
 "kind" TEXT NOT NULL,
 "reason" TEXT NOT NULL,
 "evidence" JSONB NOT NULL DEFAULT '{}',
 "status" TEXT NOT NULL DEFAULT 'OPEN',
 "resolution" TEXT,
 "resolvedById" TEXT,
 "checkedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "FinanceIssue_status_checkedAt_idx" ON "FinanceIssue" ("status","checkedAt");
CREATE TABLE "ProviderDispute" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "reservationId" TEXT NOT NULL,
 "chargeId" TEXT NOT NULL,
 "currency" TEXT NOT NULL,
 "amountCents" INTEGER NOT NULL,
 "status" TEXT NOT NULL,
 "active" BOOLEAN NOT NULL DEFAULT true,
 "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ProviderDispute_reservationId_active_idx" ON "ProviderDispute" ("reservationId","active");
CREATE TABLE "FinanceAdjustment" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "reservationId" TEXT NOT NULL,
 "kind" TEXT NOT NULL,
 "amountCents" INTEGER NOT NULL,
 "reason" TEXT NOT NULL,
 "evidenceId" TEXT NOT NULL,
 "createdById" TEXT NOT NULL,
 "approvedById" TEXT,
 "state" TEXT NOT NULL DEFAULT 'PROPOSED',
 "journalId" TEXT UNIQUE,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "FinanceDocument" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "key" TEXT NOT NULL UNIQUE,
 "kind" TEXT NOT NULL,
 "reservationId" TEXT,
 "hostId" TEXT,
 "customerId" TEXT,
 "version" INTEGER NOT NULL,
 "templateVersion" TEXT NOT NULL,
 "currency" TEXT NOT NULL,
 "timezone" TEXT NOT NULL,
 "snapshot" JSONB NOT NULL,
 "contentHash" TEXT NOT NULL,
 "pdf" BYTEA NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "FinanceDocument_hostId_createdAt_idx" ON "FinanceDocument" ("hostId","createdAt");
CREATE INDEX "FinanceDocument_customerId_createdAt_idx" ON "FinanceDocument" ("customerId","createdAt");
CREATE TABLE "TaxExemption" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "customerId" TEXT NOT NULL,
 "jurisdiction" TEXT NOT NULL,
 "evidenceReference" TEXT NOT NULL,
 "approvedById" TEXT NOT NULL,
 "expiresAt" TIMESTAMP(3) NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "FinanceSnapshot" ADD FOREIGN KEY ("reservationId") REFERENCES "Reservation"(id) ON DELETE CASCADE;
ALTER TABLE "ConnectAccount" ADD FOREIGN KEY ("hostId") REFERENCES "HostProfile"(id);
ALTER TABLE "FinanceGrant" ADD FOREIGN KEY ("hostId","userId") REFERENCES "HostEmployee"("hostId","userId") ON DELETE CASCADE;
ALTER TABLE "HostEarning" ADD FOREIGN KEY ("reservationId") REFERENCES "Reservation"(id);
ALTER TABLE "HostEarning" ADD FOREIGN KEY ("hostId") REFERENCES "HostProfile"(id);
ALTER TABLE "LedgerLine" ADD FOREIGN KEY ("journalId") REFERENCES "LedgerJournal"(id);
ALTER TABLE "LedgerJournal" ADD FOREIGN KEY ("reservationId") REFERENCES "Reservation"(id);
ALTER TABLE "LedgerJournal" ADD FOREIGN KEY ("reversalOf") REFERENCES "LedgerJournal"(id);
ALTER TABLE "PayoutItem" ADD FOREIGN KEY ("earningId") REFERENCES "HostEarning"(id);
ALTER TABLE "PayoutItem" ADD FOREIGN KEY ("batchId") REFERENCES "PayoutBatch"(id);
ALTER TABLE "PayoutReversal" ADD FOREIGN KEY ("batchId") REFERENCES "PayoutBatch"(id);
ALTER TABLE "FinanceObject" ADD FOREIGN KEY ("operationId") REFERENCES "FinancialOperation"(id);
ALTER TABLE "FinanceDocument" ADD FOREIGN KEY ("reservationId") REFERENCES "Reservation"(id);
ALTER TABLE "ProviderDispute" ADD FOREIGN KEY ("reservationId") REFERENCES "Reservation"(id);
ALTER TABLE "FinanceAdjustment" ADD FOREIGN KEY ("reservationId") REFERENCES "Reservation"(id);
CREATE UNIQUE INDEX payout_earning_exclusive ON "PayoutItem"("earningId") WHERE active;
ALTER TABLE "LedgerLine" ADD CHECK ("debitCents">=0 AND "creditCents">=0 AND (("debitCents">0)::int+("creditCents">0)::int)=1);
ALTER TABLE "LedgerJournal" ADD CHECK (currency ~ '^[a-z]{3}$');
ALTER TABLE "PayoutBatch" ADD CHECK ("amountCents">0 AND "transferredCents" BETWEEN 0 AND "amountCents" AND "reversedCents">=0 AND "reversalReservedCents">=0 AND "reversedCents"+"reversalReservedCents"<="transferredCents");
ALTER TABLE "PayoutItem" ADD CHECK ("amountCents">0);
ALTER TABLE "PayoutReversal" ADD CHECK ("amountCents">0);
ALTER TABLE "HostEarning" ADD CHECK ("netCents">=0 AND "grossCents">=0 AND "commissionCents">=0 AND "refundedCents">=0);
CREATE FUNCTION finance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Immutable financial evidence: use a reversing entry'; END $$;
CREATE TRIGGER journal_immutable BEFORE UPDATE OR DELETE ON "LedgerJournal" FOR EACH ROW EXECUTE FUNCTION finance_immutable();
CREATE TRIGGER line_immutable BEFORE UPDATE OR DELETE ON "LedgerLine" FOR EACH ROW EXECUTE FUNCTION finance_immutable();
CREATE TRIGGER document_immutable BEFORE UPDATE OR DELETE ON "FinanceDocument" FOR EACH ROW EXECUTE FUNCTION finance_immutable();
CREATE TRIGGER finance_snapshot_immutable BEFORE UPDATE ON "FinanceSnapshot" FOR EACH ROW EXECUTE FUNCTION finance_immutable();
CREATE TRIGGER finance_rule_immutable BEFORE UPDATE OR DELETE ON "FinanceRule" FOR EACH ROW EXECUTE FUNCTION finance_immutable();
CREATE FUNCTION ledger_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE jid text; total bigint; n bigint;
BEGIN
 jid:=CASE WHEN TG_TABLE_NAME='LedgerJournal' THEN NEW.id ELSE NEW."journalId" END;
 SELECT COALESCE(sum("debitCents"::bigint-"creditCents"::bigint),0),count(*) INTO total,n FROM "LedgerLine" WHERE "journalId"=jid;
 IF total<>0 OR n<2 THEN RAISE EXCEPTION 'Journal must balance with at least two entries'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER ledger_journal_balance AFTER INSERT ON "LedgerJournal" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_balanced();
CREATE CONSTRAINT TRIGGER ledger_line_balance AFTER INSERT ON "LedgerLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_balanced();
CREATE FUNCTION finance_host_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v jsonb; hid text;
BEGIN
 FOR v IN SELECT to_jsonb(OLD) WHERE TG_OP<>'INSERT' UNION ALL SELECT to_jsonb(NEW) WHERE TG_OP<>'DELETE' LOOP
  IF TG_TABLE_NAME='HostProfile' THEN hid:=v->>'id';
  ELSIF TG_TABLE_NAME='User' THEN SELECT id INTO hid FROM "HostProfile" WHERE "userId"=v->>'id';
  ELSE hid:=v->>'hostId'; END IF;
  IF hid IS NOT NULL THEN PERFORM financial_guard_try_xact('host-finance:'||hid); END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER finance_host_guard BEFORE UPDATE OR DELETE ON "HostProfile" FOR EACH ROW EXECUTE FUNCTION finance_host_guard();
CREATE TRIGGER finance_host_guard BEFORE UPDATE OR DELETE ON "User" FOR EACH ROW EXECUTE FUNCTION finance_host_guard();
CREATE TRIGGER finance_host_guard BEFORE INSERT OR UPDATE OR DELETE ON "ConnectAccount" FOR EACH ROW EXECUTE FUNCTION finance_host_guard();
CREATE TRIGGER finance_host_guard BEFORE INSERT OR UPDATE OR DELETE ON "PayoutBatch" FOR EACH ROW EXECUTE FUNCTION finance_host_guard();
CREATE TRIGGER aa_financial_guard BEFORE INSERT OR UPDATE OR DELETE ON "ProviderDispute" FOR EACH ROW EXECUTE FUNCTION financial_authority_guard();
CREATE TRIGGER aa_financial_guard BEFORE INSERT OR UPDATE OR DELETE ON "ServiceCase" FOR EACH ROW EXECUTE FUNCTION financial_authority_guard();
CREATE OR REPLACE FUNCTION enforce_provider_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid text;k text;o text;p text;d text;f text;
BEGIN
 IF TG_TABLE_NAME='FinancialOperation' THEN
   IF NEW."kind" LIKE 'FINANCE_%' AND NEW."reservationId" IS NULL THEN
     IF NEW."providerId" IS NOT NULL THEN
       INSERT INTO "FinanceObject" ("providerId","hostId","operationId",kind) VALUES (NEW."providerId",NEW.payload->>'hostId',NEW.id,NEW.kind) ON CONFLICT DO NOTHING;
       IF NOT EXISTS (SELECT 1 FROM "FinanceObject" WHERE "providerId"=NEW."providerId" AND "hostId"=NEW.payload->>'hostId' AND "operationId"=NEW.id AND kind=NEW.kind) THEN RAISE EXCEPTION 'Finance provider ownership mismatch'; END IF;
     END IF;
     RETURN NEW;
   END IF;
   IF NEW."kind"='CUSTOMER' AND NEW."reservationId" IS NULL THEN RETURN NEW; END IF;
   pid:=NEW."providerId";k:=NEW."kind";o:=NEW."id";
   IF k='DEPOSIT_RELEASE' THEN k:='DEPOSIT';o:=NULL; END IF;
 ELSIF TG_TABLE_NAME='Payment' THEN pid:=NEW."stripePaymentIntentId";p:=NEW."id";k:=CASE WHEN NEW."type" IN ('DEPOSIT_AUTH','DEPOSIT_CAPTURE') THEN 'DEPOSIT' ELSE NEW."type"::text END;
 ELSIF TG_TABLE_NAME='SecurityDeposit' THEN pid:=NEW."stripePaymentIntentId";d:=NEW."id";k:='DEPOSIT';
 ELSE pid:=NEW."stripeRefundId";f:=NEW."id";k:='REFUND'; END IF;
 IF pid IS NOT NULL THEN PERFORM claim_provider_object(pid,k,NEW."reservationId",o,p,d,f); END IF;
 RETURN NEW;
END $$;


CREATE TABLE "FinanceQuote" ("reservationId" TEXT PRIMARY KEY REFERENCES "Reservation"(id) ON DELETE CASCADE, terms JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TRIGGER quote_immutable BEFORE UPDATE ON "FinanceQuote" FOR EACH ROW EXECUTE FUNCTION finance_immutable();
CREATE FUNCTION ledger_no_append() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM "LedgerJournal" WHERE id=NEW."journalId" AND xmin::text::bigint=(txid_current()%4294967296)) THEN RAISE EXCEPTION 'Cannot append to an issued journal'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER ledger_no_append BEFORE INSERT ON "LedgerLine" FOR EACH ROW EXECUTE FUNCTION ledger_no_append();
