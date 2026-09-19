-- Freeze payout authority independently of application validation. These guards
-- supplement the existing immutable FinancialOperation request fingerprint.
CREATE OR REPLACE FUNCTION ledger_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE jid text; total bigint; n bigint;
BEGIN
 jid:=CASE WHEN TG_TABLE_NAME='LedgerJournal' THEN to_jsonb(NEW)->>'id' ELSE to_jsonb(NEW)->>'journalId' END;
 SELECT COALESCE(sum("debitCents"::bigint-"creditCents"::bigint),0),count(*) INTO total,n FROM "LedgerLine" WHERE "journalId"=jid;
 IF total<>0 OR n<2 THEN RAISE EXCEPTION 'Journal must balance with at least two entries'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION payout_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='PayoutBatch' THEN
  IF (NEW.id,NEW."hostId",NEW."accountId",NEW.currency,NEW."amountCents",NEW."createdAt") IS DISTINCT FROM
     (OLD.id,OLD."hostId",OLD."accountId",OLD.currency,OLD."amountCents",OLD."createdAt") THEN
   RAISE EXCEPTION 'Immutable payout batch intent';
  END IF;
 ELSIF TG_TABLE_NAME='PayoutItem' THEN
  IF TG_OP='INSERT' THEN
   IF NOT EXISTS(SELECT 1 FROM "PayoutBatch" b JOIN "HostEarning" e ON e.id=NEW."earningId"
     WHERE b.id=NEW."batchId" AND e."reservationId"=NEW."reservationId" AND e."hostId"=b."hostId" AND e.currency=b.currency
       AND b.xmin::text::bigint=(txid_current()%4294967296) AND b.state='PLANNED') THEN
     RAISE EXCEPTION 'Payout item must match a newly planned owned batch';
   END IF;
  ELSE
   IF TG_OP='DELETE' OR (NEW.id,NEW."batchId",NEW."earningId",NEW."reservationId",NEW."amountCents",NEW."createdAt") IS DISTINCT FROM
      (OLD.id,OLD."batchId",OLD."earningId",OLD."reservationId",OLD."amountCents",OLD."createdAt") OR NOT OLD.active OR NEW.active
      OR NOT EXISTS(SELECT 1 FROM "PayoutBatch" WHERE id=OLD."batchId" AND state='VOIDED' AND "transferredCents"=0) THEN
    RAISE EXCEPTION 'Immutable payout item; only an undispatched void can release ownership';
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME='PayoutReversal' THEN
  IF (NEW.id,NEW.key,NEW."batchId",NEW."amountCents",NEW.reason) IS DISTINCT FROM (OLD.id,OLD.key,OLD."batchId",OLD."amountCents",OLD.reason) THEN RAISE EXCEPTION 'Immutable reversal intent'; END IF;
 ELSIF TG_TABLE_NAME='ConnectAccount' THEN
  IF NEW."hostId"<>OLD."hostId" OR OLD."accountId" IS NOT NULL AND NEW."accountId" IS DISTINCT FROM OLD."accountId" THEN RAISE EXCEPTION 'Immutable Connect ownership'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payout_intent_guard BEFORE UPDATE ON "PayoutBatch" FOR EACH ROW EXECUTE FUNCTION payout_intent_guard();
CREATE TRIGGER payout_intent_guard BEFORE INSERT OR UPDATE OR DELETE ON "PayoutItem" FOR EACH ROW EXECUTE FUNCTION payout_intent_guard();
CREATE TRIGGER payout_intent_guard BEFORE UPDATE ON "PayoutReversal" FOR EACH ROW EXECUTE FUNCTION payout_intent_guard();
CREATE TRIGGER payout_intent_guard BEFORE UPDATE ON "ConnectAccount" FOR EACH ROW EXECUTE FUNCTION payout_intent_guard();
CREATE TRIGGER finance_object_immutable BEFORE UPDATE OR DELETE ON "FinanceObject" FOR EACH ROW EXECUTE FUNCTION finance_immutable();
CREATE TRIGGER aa_financial_guard BEFORE INSERT OR UPDATE OR DELETE ON "FinanceIssue" FOR EACH ROW EXECUTE FUNCTION financial_authority_guard();
CREATE TRIGGER finance_host_guard BEFORE INSERT OR UPDATE OR DELETE ON "FinanceIssue" FOR EACH ROW EXECUTE FUNCTION finance_host_guard();
CREATE FUNCTION payout_batch_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total bigint; n bigint; expected bigint;
BEGIN
 SELECT sum("amountCents"),count(*) INTO total,n FROM "PayoutItem" WHERE "batchId"=NEW.id;
 SELECT "amountCents" INTO expected FROM "PayoutBatch" WHERE id=NEW.id;
 IF n=0 OR total<>expected THEN RAISE EXCEPTION 'Frozen payout items must equal batch amount'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER payout_batch_balanced AFTER INSERT ON "PayoutBatch" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payout_batch_balanced();
