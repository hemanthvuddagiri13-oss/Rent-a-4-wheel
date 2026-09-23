-- Additive identity storage. Existing contact phone values are NOT verified or linked.
CREATE TABLE "MobilePhoneIdentity" (
  "userId" TEXT PRIMARY KEY REFERENCES "User"("id") ON DELETE CASCADE,
  "phone" TEXT NOT NULL UNIQUE,
  "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE "MobileLoginChallenge" (
  "id" TEXT PRIMARY KEY, "channel" TEXT NOT NULL, "purpose" TEXT NOT NULL,
  "target" TEXT NOT NULL, "targetHash" TEXT NOT NULL, "deviceId" TEXT NOT NULL, "ipHash" TEXT NOT NULL,
  "userId" TEXT, "sessionId" TEXT, "previousPhone" TEXT, "previousPhoneVersion" INTEGER, "providerSid" TEXT, "codeHash" TEXT,
  "state" TEXT NOT NULL DEFAULT 'CREATED', "attempts" INTEGER NOT NULL DEFAULT 0,
  "claim" TEXT, "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MobileLoginChallenge_channel_check" CHECK ("channel" IN ('PHONE','EMAIL')),
  CONSTRAINT "MobileLoginChallenge_purpose_check" CHECK ("purpose" IN ('SIGN_IN','LINK_PHONE','CURRENT_PHONE','CHANGE_PHONE','RECOVERY','LINK_EMAIL')),
  CONSTRAINT "MobileLoginChallenge_state_check" CHECK ("state" IN ('CREATED','SENT','CHECKING','PROVED','CONSUMED','FAILED','DENIED')),
  CONSTRAINT "MobileLoginChallenge_attempts_check" CHECK ("attempts" BETWEEN 0 AND 5)
);
CREATE INDEX "MobileLoginChallenge_targetHash_createdAt_idx" ON "MobileLoginChallenge"("targetHash","createdAt");
CREATE INDEX "MobileLoginChallenge_ipHash_createdAt_idx" ON "MobileLoginChallenge"("ipHash","createdAt");
CREATE INDEX "MobileLoginChallenge_deviceId_createdAt_idx" ON "MobileLoginChallenge"("deviceId","createdAt");
CREATE INDEX "MobileLoginChallenge_sessionId_purpose_state_idx" ON "MobileLoginChallenge"("sessionId","purpose","state");
CREATE TABLE "MobileVerificationReceipt" (
  "providerSid" TEXT PRIMARY KEY, "challengeId" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "MobileIdentityRecovery" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "sessionId" TEXT NOT NULL,
  "challengeId" TEXT NOT NULL UNIQUE, "previousPhone" TEXT NOT NULL, "requestedPhone" TEXT NOT NULL, "caseId" TEXT UNIQUE,
  "state" TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MobileIdentityRecovery_state_check" CHECK ("state" = 'REVIEW_REQUIRED')
);
CREATE INDEX "MobileIdentityRecovery_userId_state_idx" ON "MobileIdentityRecovery"("userId","state");
