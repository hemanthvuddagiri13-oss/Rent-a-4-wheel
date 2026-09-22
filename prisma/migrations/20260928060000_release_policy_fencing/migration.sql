-- All authority writers use statement-level fencing before row locks.
CREATE TRIGGER release_feature_fence BEFORE INSERT OR UPDATE OR DELETE ON "ReleaseFeature" FOR EACH STATEMENT EXECUTE FUNCTION national_authority_fence();
CREATE TRIGGER policy_approval_fence BEFORE INSERT OR UPDATE OR DELETE ON "PolicyApproval" FOR EACH STATEMENT EXECUTE FUNCTION national_authority_fence();
CREATE TRIGGER legal_document_fence BEFORE INSERT OR UPDATE OR DELETE ON "LegalDocument" FOR EACH STATEMENT EXECUTE FUNCTION national_authority_fence();
