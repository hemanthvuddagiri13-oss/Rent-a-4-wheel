-- Keep affiliations after revocation: global promotion cannot erase a conflict.
CREATE TABLE "HostAffiliationHistory" (
  "hostId" TEXT NOT NULL REFERENCES "HostProfile"(id) ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "firstRecordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("hostId", "userId")
);
INSERT INTO "HostAffiliationHistory" ("hostId","userId","firstRecordedAt")
SELECT "hostId","userId","createdAt" FROM "HostEmployee";
CREATE FUNCTION preserve_host_affiliation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "HostAffiliationHistory" ("hostId","userId") VALUES (NEW."hostId",NEW."userId") ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_host_affiliation AFTER INSERT OR UPDATE ON "HostEmployee"
FOR EACH ROW EXECUTE FUNCTION preserve_host_affiliation();
CREATE TRIGGER affiliation_history_immutable BEFORE UPDATE ON "HostAffiliationHistory"
FOR EACH ROW EXECUTE FUNCTION collaboration_history_immutable();
