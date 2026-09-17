-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'SUPPORT_AGENT';
ALTER TYPE "Role" ADD VALUE 'CLAIMS_AGENT';

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "retainUntil" TIMESTAMP(3) NOT NULL,
    "legalHold" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ConversationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageRevision" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationRead" (
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationRead_pkey" PRIMARY KEY ("conversationId","userId")
);

-- CreateTable
CREATE TABLE "CommunityReport" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunityReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxNotice" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboxNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoticePreference" (
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "email" BOOLEAN NOT NULL DEFAULT true,
    "sms" BOOLEAN NOT NULL DEFAULT false,
    "push" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "NoticePreference_pkey" PRIMARY KEY ("userId","category")
);

-- CreateTable
CREATE TABLE "SmsConsent" (
    "userId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "stoppedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL,

    CONSTRAINT "SmsConsent_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "TripReview" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "categories" JSONB NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishAfter" TIMESTAMP(3) NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "retainUntil" TIMESTAMP(3) NOT NULL,
    "legalHold" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TripReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewHistory" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceCase" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reservationId" TEXT,
    "vehicleId" TEXT,
    "openedById" TEXT NOT NULL,
    "assignedToId" TEXT,
    "linkedCaseId" TEXT,
    "damageKey" TEXT,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'REPORTED',
    "version" INTEGER NOT NULL DEFAULT 0,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "retainUntil" TIMESTAMP(3) NOT NULL,
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "securityHold" BOOLEAN NOT NULL DEFAULT false,
    "safetyBlock" BOOLEAN NOT NULL DEFAULT false,
    "satisfaction" INTEGER,

    CONSTRAINT "ServiceCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceCaseEvent" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromState" TEXT NOT NULL,
    "toState" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceCaseEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollaborationFile" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT,
    "caseId" TEXT,
    "uploadedById" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "scanStatus" TEXT NOT NULL,
    "originalPhotoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retainUntil" TIMESTAMP(3) NOT NULL,
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CollaborationFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivacyDeletion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'REQUESTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "PrivacyDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageDeletionJob" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "StorageDeletionJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_reservationId_key" ON "Conversation"("reservationId");

-- CreateIndex
CREATE INDEX "Conversation_customerId_updatedAt_idx" ON "Conversation"("customerId", "updatedAt");

-- CreateIndex
CREATE INDEX "Conversation_vehicleId_idx" ON "Conversation"("vehicleId");

-- CreateIndex
CREATE INDEX "ConversationMessage_conversationId_createdAt_id_idx" ON "ConversationMessage"("conversationId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MessageRevision_messageId_version_key" ON "MessageRevision"("messageId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "CommunityReport_actorId_entityType_entityId_key" ON "CommunityReport"("actorId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "InboxNotice_userId_createdAt_idx" ON "InboxNotice"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboxNotice_eventKey_userId_key" ON "InboxNotice"("eventKey", "userId");

-- CreateIndex
CREATE INDEX "TripReview_subjectId_subject_hidden_idx" ON "TripReview"("subjectId", "subject", "hidden");

-- CreateIndex
CREATE UNIQUE INDEX "TripReview_reservationId_reviewerId_subject_key" ON "TripReview"("reservationId", "reviewerId", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCase_damageKey_key" ON "ServiceCase"("damageKey");

-- CreateIndex
CREATE INDEX "ServiceCase_reservationId_state_idx" ON "ServiceCase"("reservationId", "state");

-- CreateIndex
CREATE INDEX "ServiceCase_kind_state_dueAt_idx" ON "ServiceCase"("kind", "state", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCaseEvent_caseId_version_key" ON "ServiceCaseEvent"("caseId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "CollaborationFile_storageKey_key" ON "CollaborationFile"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "StorageDeletionJob_fileId_key" ON "StorageDeletionJob"("fileId");

-- AddForeignKey
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageRevision" ADD CONSTRAINT "MessageRevision_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ConversationMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationRead" ADD CONSTRAINT "ConversationRead_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCaseEvent" ADD CONSTRAINT "ServiceCaseEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ServiceCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- History is append-only; retention deletion remains an explicit privileged job.
CREATE FUNCTION collaboration_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Collaboration history is immutable'; END $$;
CREATE TRIGGER message_history_immutable BEFORE UPDATE ON "MessageRevision" FOR EACH ROW EXECUTE FUNCTION collaboration_history_immutable();
CREATE TRIGGER case_history_immutable BEFORE UPDATE ON "ServiceCaseEvent" FOR EACH ROW EXECUTE FUNCTION collaboration_history_immutable();
CREATE TRIGGER review_history_immutable BEFORE UPDATE ON "ReviewHistory" FOR EACH ROW EXECUTE FUNCTION collaboration_history_immutable();
ALTER TABLE "Conversation" ADD CONSTRAINT "conversation_reservation_fk" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id");
ALTER TABLE "Conversation" ADD CONSTRAINT "conversation_vehicle_fk" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id");
ALTER TABLE "Conversation" ADD CONSTRAINT "conversation_customer_fk" FOREIGN KEY ("customerId") REFERENCES "User"("id");
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "message_sender_fk" FOREIGN KEY ("senderId") REFERENCES "User"("id");
ALTER TABLE "ServiceCase" ADD CONSTRAINT "case_reservation_fk" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id");
ALTER TABLE "ServiceCase" ADD CONSTRAINT "case_vehicle_fk" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id");
ALTER TABLE "ServiceCase" ADD CONSTRAINT "case_opener_fk" FOREIGN KEY ("openedById") REFERENCES "User"("id");
ALTER TABLE "ServiceCase" ADD CONSTRAINT "case_link_fk" FOREIGN KEY ("linkedCaseId") REFERENCES "ServiceCase"("id");
ALTER TABLE "TripReview" ADD CONSTRAINT "review_reservation_fk" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id");
ALTER TABLE "TripReview" ADD CONSTRAINT "review_reviewer_fk" FOREIGN KEY ("reviewerId") REFERENCES "User"("id");
ALTER TABLE "TripReview" ADD CONSTRAINT "review_rating_check" CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "CollaborationFile" ADD CONSTRAINT "file_scope_check" CHECK (("conversationId" IS NULL) <> ("caseId" IS NULL));
ALTER TABLE "CollaborationFile" ADD CONSTRAINT "file_conversation_fk" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id");
ALTER TABLE "CollaborationFile" ADD CONSTRAINT "file_case_fk" FOREIGN KEY ("caseId") REFERENCES "ServiceCase"("id");
ALTER TABLE "CollaborationFile" ADD CONSTRAINT "file_original_photo_fk" FOREIGN KEY ("originalPhotoId") REFERENCES "ConditionPhoto"("id");
ALTER TABLE "ServiceCase" ADD CONSTRAINT "case_kind_check" CHECK ("kind" IN ('CLAIM','DISPUTE','INCIDENT','TICKET'));

ALTER TYPE "NotificationType" ADD VALUE 'COMMUNITY_UPDATE';
CREATE TABLE "ChannelDelivery" (
 "id" TEXT PRIMARY KEY, "noticeId" TEXT NOT NULL REFERENCES "InboxNotice"("id"), "userId" TEXT NOT NULL REFERENCES "User"("id"),
 "channel" TEXT NOT NULL CHECK ("channel" IN ('SMS','PUSH')), "state" TEXT NOT NULL DEFAULT 'READY', "attempts" INTEGER NOT NULL DEFAULT 0,
 "leaseToken" TEXT, "leaseUntil" TIMESTAMP(3), "providerId" TEXT, "errorCode" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "acceptedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "ChannelDelivery_noticeId_channel_key" ON "ChannelDelivery"("noticeId","channel");
-- In-app projection is in the same transaction as its authoritative event.
-- No provider request or financial operation is created by these triggers.
CREATE FUNCTION community_reservation_notice(rid TEXT, event_key TEXT, title_text TEXT, category_text TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE recipient TEXT;
BEGIN
 FOR recipient IN SELECT r."customerId" FROM "Reservation" r WHERE r.id=rid UNION SELECT h."userId" FROM "Reservation" r JOIN "Vehicle" v ON v.id=r."vehicleId" JOIN "HostProfile" h ON h.id=v."hostId" WHERE r.id=rid LOOP
  INSERT INTO "InboxNotice" (id,"eventKey","userId",category,"resourceType","resourceId",title,required)
  VALUES ('notice_'||md5(event_key||':'||recipient),event_key,recipient,category_text,'RESERVATION',rid,title_text,true)
  ON CONFLICT ("eventKey","userId") DO NOTHING;
 END LOOP;
END $$;
CREATE FUNCTION community_trip_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM community_reservation_notice(NEW."reservationId",'trip-event:'||NEW.id,'Trip update: '||replace(NEW.type,'_',' '),'TRIP'); RETURN NEW; END $$;
CREATE TRIGGER community_trip_notice AFTER INSERT ON "TripEvent" FOR EACH ROW EXECUTE FUNCTION community_trip_notice();
CREATE FUNCTION community_document_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."reservationId" IS NOT NULL THEN
  PERFORM community_reservation_notice(NEW."reservationId",'document:'||NEW.id||':'||NEW.status::text||':'||NEW."malwareScanStatus"::text,'Driver document status updated','DOCUMENT');
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER community_document_notice AFTER INSERT OR UPDATE OF status,"malwareScanStatus","reservationId" ON "DriverDocument" FOR EACH ROW EXECUTE FUNCTION community_document_notice();
CREATE FUNCTION community_agreement_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."reservationId" IS NOT NULL THEN PERFORM community_reservation_notice(NEW."reservationId",'agreement:'||NEW.id,'Signed agreement available in your trip','AGREEMENT'); END IF; RETURN NEW;
END $$;
CREATE TRIGGER community_agreement_notice AFTER INSERT ON "AgreementAcceptance" FOR EACH ROW EXECUTE FUNCTION community_agreement_notice();
CREATE FUNCTION community_money_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM community_reservation_notice(NEW."reservationId",TG_TABLE_NAME||':'||NEW.id||':'||NEW.status::text,'Payment account status updated','PAYMENT'); RETURN NEW;
END $$;
CREATE TRIGGER community_payment_notice AFTER INSERT OR UPDATE OF status ON "Payment" FOR EACH ROW EXECUTE FUNCTION community_money_notice();
CREATE TRIGGER community_refund_notice AFTER INSERT OR UPDATE OF status ON "Refund" FOR EACH ROW EXECUTE FUNCTION community_money_notice();
CREATE TRIGGER community_deposit_notice AFTER INSERT OR UPDATE OF status ON "SecurityDeposit" FOR EACH ROW EXECUTE FUNCTION community_money_notice();

