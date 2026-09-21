ALTER TABLE "OperationalEvent" ADD COLUMN "source" TEXT, ADD COLUMN "durationMs" INTEGER;
CREATE FUNCTION private_object_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.key<>OLD.key OR NEW.sha256<>OLD.sha256 OR NEW.size<>OLD.size OR NEW."mimeType"<>OLD."mimeType" OR
 (OLD.state='INFECTED' AND NEW.state NOT IN ('INFECTED','DELETING','DELETED')) OR
 (OLD.state='DELETING' AND NEW.state NOT IN ('DELETING','DELETED')) OR
 (OLD.state='DELETED' AND NEW.state<>'DELETED') OR
 (OLD.state IN ('DELETING','DELETED') AND (NEW.hold IS DISTINCT FROM OLD.hold OR NEW."retainedUntil" IS DISTINCT FROM OLD."retainedUntil"))
 THEN RAISE EXCEPTION 'Immutable private object evidence'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER private_object_identity BEFORE UPDATE OR DELETE ON "PrivateObject" FOR EACH ROW EXECUTE FUNCTION private_object_identity_guard();
CREATE FUNCTION operations_job_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.key<>OLD.key OR NEW.kind<>OLD.kind OR NEW."resourceId" IS DISTINCT FROM OLD."resourceId" THEN RAISE EXCEPTION 'Immutable operational intent'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER operations_job_identity BEFORE UPDATE ON "OperationsJob" FOR EACH ROW EXECUTE FUNCTION operations_job_identity_guard();
CREATE FUNCTION policy_review_required_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."professionalReviewRequired" IS DISTINCT FROM OLD."professionalReviewRequired" THEN RAISE EXCEPTION 'Professional review requirement is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER policy_review_required BEFORE UPDATE ON "PolicyApproval" FOR EACH ROW EXECUTE FUNCTION policy_review_required_guard();
