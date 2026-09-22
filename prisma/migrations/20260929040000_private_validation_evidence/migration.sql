CREATE TABLE "PrivateValidation" (
 "sourceKey" TEXT PRIMARY KEY REFERENCES "PrivateObject"(key),
 "targetKey" TEXT NOT NULL UNIQUE,
 "resourceType" TEXT NOT NULL,
 "resourceId" TEXT NOT NULL,
 "sourceSha256" TEXT NOT NULL,
 "targetSha256" TEXT NOT NULL,
 "mimeType" TEXT NOT NULL,
 bytes BYTEA NOT NULL CHECK (octet_length(bytes)>0 AND octet_length(bytes)<=8388608),
 evidence JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION private_validation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Private validation evidence is immutable';
END $$;
CREATE TRIGGER private_validation_guard BEFORE UPDATE OR DELETE ON "PrivateValidation" FOR EACH ROW EXECUTE FUNCTION private_validation_immutable();
-- Previously imported bytes are not retrospectively certified by a hash or scan.
UPDATE "PrivateObject" p SET state='QUARANTINED'
WHERE p.state IN ('UPLOADED','QUARANTINED','SCANNING','CLEAN','SCAN_FAILED')
AND EXISTS(SELECT 1 FROM "OperationsJob" j WHERE j.kind='LEGACY_IMPORT' AND j."resourceId"=p.key);
