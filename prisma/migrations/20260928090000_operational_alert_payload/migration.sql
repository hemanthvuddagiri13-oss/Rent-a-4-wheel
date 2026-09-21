ALTER TABLE "OperationsJob" ADD COLUMN payload JSONB;
CREATE FUNCTION operational_payload_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.payload IS DISTINCT FROM OLD.payload THEN RAISE EXCEPTION 'Operational payload is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER operational_payload_guard BEFORE UPDATE ON "OperationsJob" FOR EACH ROW EXECUTE FUNCTION operational_payload_immutable();
-- An old alert has no persisted request body. Never invent one on recovery.
UPDATE "OperationsJob" SET state='REVIEW',"lastErrorCode"='MISSING_IMMUTABLE_PAYLOAD',"leaseToken"=NULL,"leaseExpiresAt"=NULL
WHERE kind='ALERT' AND state<>'DONE' AND payload IS NULL;
