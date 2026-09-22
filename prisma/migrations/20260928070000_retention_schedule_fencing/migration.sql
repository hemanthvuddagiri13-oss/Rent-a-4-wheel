-- The configured schedule is included in professional approval hashes.
-- Fence changes before rows are modified, using the same order as release controls.
CREATE TRIGGER retention_schedule_authority BEFORE INSERT OR UPDATE OR DELETE ON "SiteSetting"
FOR EACH STATEMENT EXECUTE FUNCTION national_authority_fence();
