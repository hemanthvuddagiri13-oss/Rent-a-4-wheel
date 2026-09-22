CREATE TABLE "AgreementArtifact" (
 "acceptanceId" TEXT PRIMARY KEY REFERENCES "AgreementAcceptance"(id) ON DELETE CASCADE,
 "storageId" TEXT NOT NULL UNIQUE,
 sha256 TEXT NOT NULL,
 pdf BYTEA NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION agreement_artifact_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Agreement artifact bytes and identity are immutable';
END $$;
CREATE TRIGGER agreement_artifact_guard BEFORE UPDATE ON "AgreementArtifact" FOR EACH ROW EXECUTE FUNCTION agreement_artifact_immutable();
-- Existing complete PDFs are not regenerated. Missing artifacts with frozen
-- subject evidence become resumable without another signature or new acceptance.
INSERT INTO "OperationsJob" (key,kind,"resourceId",state,attempts,"nextAttemptAt","createdAt","updatedAt")
SELECT 'agreement:'||id,'AGREEMENT',id,'PENDING',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM "AgreementAcceptance" WHERE "signedPdfStorageKey" IS NULL AND "subjectSnapshot" IS NOT NULL
ON CONFLICT (key) DO NOTHING;
