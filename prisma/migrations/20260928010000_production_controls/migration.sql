ALTER TYPE "AuthCodePurpose" ADD VALUE IF NOT EXISTS 'SECURITY_STEP_UP';
ALTER TABLE "Session" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ADD COLUMN "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ADD COLUMN "revokedAt" TIMESTAMP(3), ADD COLUMN "rotation" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "device" TEXT NOT NULL DEFAULT 'Browser';
-- Legacy adapter sessions never established a device or absolute lifetime. Reauthentication required.
UPDATE "Session" SET "revokedAt"=CURRENT_TIMESTAMP WHERE "revokedAt" IS NULL;
CREATE TABLE "ReleaseFeature" ("key" TEXT PRIMARY KEY,"enabled" BOOLEAN NOT NULL DEFAULT false,"version" INTEGER NOT NULL DEFAULT 1,"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "PolicyApproval" ("id" TEXT PRIMARY KEY,"kind" TEXT NOT NULL,"version" TEXT NOT NULL,"contentHash" TEXT NOT NULL,"status" TEXT NOT NULL DEFAULT 'DRAFT',"jurisdiction" TEXT NOT NULL,"professionalReviewRequired" BOOLEAN NOT NULL DEFAULT true,"professionalReference" TEXT,"approvedById" TEXT REFERENCES "User"("id"),"approvedAt" TIMESTAMP(3),"effectiveAt" TIMESTAMP(3),"supersedesId" TEXT UNIQUE REFERENCES "PolicyApproval"("id"),"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "PolicyApproval_valid" CHECK ("contentHash" ~ '^[a-f0-9]{64}$' AND "status" IN ('DRAFT','APPROVED','REVOKED') AND ("status" <> 'APPROVED' OR ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "effectiveAt" IS NOT NULL AND (NOT "professionalReviewRequired" OR "professionalReference" IS NOT NULL)))));
CREATE UNIQUE INDEX "PolicyApproval_kind_jurisdiction_version_key" ON "PolicyApproval"("kind","jurisdiction","version");
CREATE INDEX "PolicyApproval_kind_jurisdiction_status_effectiveAt_idx" ON "PolicyApproval"("kind","jurisdiction","status","effectiveAt");
CREATE TABLE "OperationalEvent" ("id" TEXT PRIMARY KEY,"category" TEXT NOT NULL,"severity" TEXT NOT NULL,"requestId" TEXT,"count" INTEGER NOT NULL DEFAULT 1,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "OperationalEvent_category_createdAt_idx" ON "OperationalEvent"("category","createdAt");
CREATE TABLE "OperationsJob" ("key" TEXT PRIMARY KEY,"kind" TEXT NOT NULL,"state" TEXT NOT NULL DEFAULT 'PENDING',"resourceId" TEXT,"leaseToken" TEXT,"leaseExpiresAt" TIMESTAMP(3),"attempts" INTEGER NOT NULL DEFAULT 0,"nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"lastErrorCode" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "OperationsJob_valid" CHECK ("state" IN ('PENDING','RUNNING','RETRY','DONE','REVIEW') AND "attempts">=0));
CREATE INDEX "OperationsJob_kind_state_nextAttemptAt_idx" ON "OperationsJob"("kind","state","nextAttemptAt");
CREATE TABLE "PrivateObject" ("key" TEXT PRIMARY KEY,"sha256" TEXT NOT NULL,"size" INTEGER NOT NULL,"mimeType" TEXT NOT NULL,"state" TEXT NOT NULL DEFAULT 'UPLOADED',"scanEngine" TEXT,"scanVersion" TEXT,"scannedAt" TIMESTAMP(3),"retainedUntil" TIMESTAMP(3),"hold" BOOLEAN NOT NULL DEFAULT false,"deletedAt" TIMESTAMP(3),"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "PrivateObject_valid" CHECK ("size">0 AND "sha256" ~ '^[a-f0-9]{64}$' AND "state" IN ('UPLOADED','QUARANTINED','SCANNING','CLEAN','INFECTED','SCAN_FAILED','DELETING','DELETED')));
CREATE INDEX "PrivateObject_state_updatedAt_idx" ON "PrivateObject"("state","updatedAt");
CREATE FUNCTION phase5_immutable_policy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW."kind"<>OLD."kind" OR NEW."version"<>OLD."version" OR NEW."contentHash"<>OLD."contentHash" OR NEW."jurisdiction"<>OLD."jurisdiction" OR NEW."supersedesId" IS DISTINCT FROM OLD."supersedesId" OR (OLD."status"<>'DRAFT' AND (NEW."status" NOT IN (OLD."status",'REVOKED') OR NEW."approvedById" IS DISTINCT FROM OLD."approvedById" OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt" OR NEW."effectiveAt" IS DISTINCT FROM OLD."effectiveAt" OR NEW."professionalReference" IS DISTINCT FROM OLD."professionalReference")) THEN RAISE EXCEPTION 'Immutable policy evidence'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER policy_immutable BEFORE UPDATE OR DELETE ON "PolicyApproval" FOR EACH ROW EXECUTE FUNCTION phase5_immutable_policy();
