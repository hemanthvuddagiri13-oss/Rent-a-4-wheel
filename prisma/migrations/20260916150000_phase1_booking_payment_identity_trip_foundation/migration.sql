-- CreateEnum
CREATE TYPE "AuthCodePurpose" AS ENUM ('SIGN_IN');

-- CreateEnum
CREATE TYPE "HostOnboardingStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "StripeConnectStatus" AS ENUM ('NOT_CONNECTED', 'ONBOARDING', 'ACTIVE', 'RESTRICTED', 'DISABLED');

-- CreateEnum
CREATE TYPE "HostEmployeeRole" AS ENUM ('MANAGER', 'STAFF');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('LICENSE_FRONT', 'LICENSE_BACK', 'SELFIE_WITH_LICENSE');

-- CreateEnum
CREATE TYPE "MalwareScanStatus" AS ENUM ('NOT_SCANNED', 'CLEAN', 'INFECTED', 'SCAN_UNAVAILABLE');

-- CreateEnum
CREATE TYPE "ConditionReportPhase" AS ENUM ('PRE_TRIP', 'POST_TRIP');

-- CreateEnum
CREATE TYPE "SubmitterRole" AS ENUM ('CUSTOMER', 'HOST');

-- CreateEnum
CREATE TYPE "ConditionPhotoCategory" AS ENUM ('EXTERIOR', 'INTERIOR', 'ODOMETER', 'FUEL_GAUGE', 'DAMAGE');

-- CreateEnum
CREATE TYPE "TripChecklistPhase" AS ENUM ('PICKUP', 'RETURN');

-- AlterEnum
ALTER TYPE "LegalDocumentType" ADD VALUE 'HOST_AGREEMENT';

-- AlterEnum
BEGIN;
CREATE TYPE "ReservationStatus_new" AS ENUM ('DRAFT', 'CHECKOUT_HOLD', 'AWAITING_PAYMENT', 'CONFIRMED', 'DOCUMENTS_REQUIRED', 'READY_FOR_CHECK_IN', 'CHECK_IN_PROGRESS', 'READY_TO_START', 'ACTIVE', 'RETURN_IN_PROGRESS', 'COMPLETED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_HOST', 'PAYMENT_FAILED', 'EXPIRED', 'DISPUTED', 'UNDER_CLAIM_REVIEW');
ALTER TABLE "public"."Reservation" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Reservation" ALTER COLUMN "status" TYPE "ReservationStatus_new" USING ("status"::text::"ReservationStatus_new");
ALTER TYPE "ReservationStatus" RENAME TO "ReservationStatus_old";
ALTER TYPE "ReservationStatus_new" RENAME TO "ReservationStatus";
DROP TYPE "public"."ReservationStatus_old";
ALTER TABLE "Reservation" ALTER COLUMN "status" SET DEFAULT 'CHECKOUT_HOLD';
COMMIT;

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'HOST';
ALTER TYPE "Role" ADD VALUE 'HOST_EMPLOYEE';

-- DropForeignKey
ALTER TABLE "RentalAgreement" DROP CONSTRAINT "RentalAgreement_reservationId_fkey";

-- AlterTable
ALTER TABLE "DriverDocument" DROP COLUMN "side",
ADD COLUMN     "contentSha256" TEXT NOT NULL,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "fileSizeBytes" INTEGER NOT NULL,
ADD COLUMN     "malwareScanStatus" "MalwareScanStatus" NOT NULL DEFAULT 'NOT_SCANNED',
ADD COLUMN     "mimeType" TEXT NOT NULL,
ADD COLUMN     "retentionExpiresAt" TIMESTAMP(3),
ADD COLUMN     "type" "DocumentType" NOT NULL;

-- AlterTable
ALTER TABLE "Reservation" DROP COLUMN "agreementAcceptedAt",
DROP COLUMN "agreementVersionAccepted",
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ALTER COLUMN "status" SET DEFAULT 'CHECKOUT_HOLD',
ALTER COLUMN "driverFirstName" DROP NOT NULL,
ALTER COLUMN "driverLastName" DROP NOT NULL,
ALTER COLUMN "driverDob" DROP NOT NULL,
ALTER COLUMN "driverEmail" DROP NOT NULL,
ALTER COLUMN "driverPhone" DROP NOT NULL,
ALTER COLUMN "driverAddress" DROP NOT NULL,
ALTER COLUMN "driverCity" DROP NOT NULL,
ALTER COLUMN "driverState" DROP NOT NULL,
ALTER COLUMN "driverZip" DROP NOT NULL,
ALTER COLUMN "licenseNumber" DROP NOT NULL,
ALTER COLUMN "licenseState" DROP NOT NULL,
ALTER COLUMN "licenseExpiration" DROP NOT NULL;

-- AlterTable
ALTER TABLE "SecurityDeposit" ADD COLUMN     "failureReason" TEXT;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "passwordHash",
ADD COLUMN     "stripeCustomerId" TEXT;

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "hostId" TEXT;

-- DropTable
DROP TABLE "RentalAgreement";

-- DropEnum
DROP TYPE "DocumentSide";

-- CreateTable
CREATE TABLE "AuthCode" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" "AuthCodePurpose" NOT NULL DEFAULT 'SIGN_IN',
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "requestIp" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "businessName" TEXT,
    "legalName" TEXT NOT NULL,
    "phone" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "country" TEXT NOT NULL DEFAULT 'US',
    "onboardingStatus" "HostOnboardingStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "stripeConnectAccountId" TEXT,
    "stripeConnectStatus" "StripeConnectStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostEmployee" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "HostEmployeeRole" NOT NULL DEFAULT 'STAFF',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HostEmployee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentAccessLog" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "accessedById" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgreementAcceptance" (
    "id" TEXT NOT NULL,
    "type" "LegalDocumentType" NOT NULL,
    "documentVersion" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "contentSnapshot" TEXT NOT NULL,
    "reservationId" TEXT,
    "vehicleId" TEXT,
    "signedByUserId" TEXT NOT NULL,
    "signerName" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "signedPdfStorageKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgreementAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trip" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "startedByUserId" TEXT,
    "startMileage" INTEGER,
    "startFuelLevel" INTEGER,
    "endedAt" TIMESTAMP(3),
    "endedByUserId" TEXT,
    "endMileage" INTEGER,
    "endFuelLevel" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConditionReport" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "phase" "ConditionReportPhase" NOT NULL,
    "submittedByRole" "SubmitterRole" NOT NULL,
    "submittedById" TEXT NOT NULL,
    "mileage" INTEGER NOT NULL,
    "fuelLevel" INTEGER NOT NULL,
    "damageNotes" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConditionReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConditionPhoto" (
    "id" TEXT NOT NULL,
    "conditionReportId" TEXT NOT NULL,
    "category" "ConditionPhotoCategory" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConditionPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityHandoffVerification" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "verifiedByHostId" TEXT NOT NULL,
    "licenseMatchesUpload" BOOLEAN NOT NULL DEFAULT false,
    "physicalLicenseUnexpired" BOOLEAN NOT NULL DEFAULT false,
    "selfieMatchesCustomer" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "IdentityHandoffVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TripChecklist" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "phase" "TripChecklistPhase" NOT NULL,
    "role" "SubmitterRole" NOT NULL,
    "step" TEXT NOT NULL,
    "completedById" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripChecklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TripEvent" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthCode_email_purpose_createdAt_idx" ON "AuthCode"("email", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "AuthCode_requestIp_createdAt_idx" ON "AuthCode"("requestIp", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "HostProfile_userId_key" ON "HostProfile"("userId");

-- CreateIndex
CREATE INDEX "HostProfile_onboardingStatus_idx" ON "HostProfile"("onboardingStatus");

-- CreateIndex
CREATE INDEX "HostEmployee_userId_idx" ON "HostEmployee"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "HostEmployee_hostId_userId_key" ON "HostEmployee"("hostId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "StripeEvent_stripeEventId_key" ON "StripeEvent"("stripeEventId");

-- CreateIndex
CREATE INDEX "StripeEvent_type_idx" ON "StripeEvent"("type");

-- CreateIndex
CREATE INDEX "DocumentAccessLog_documentId_idx" ON "DocumentAccessLog"("documentId");

-- CreateIndex
CREATE INDEX "DocumentAccessLog_accessedById_idx" ON "DocumentAccessLog"("accessedById");

-- CreateIndex
CREATE INDEX "AgreementAcceptance_reservationId_idx" ON "AgreementAcceptance"("reservationId");

-- CreateIndex
CREATE INDEX "AgreementAcceptance_vehicleId_idx" ON "AgreementAcceptance"("vehicleId");

-- CreateIndex
CREATE INDEX "AgreementAcceptance_signedByUserId_idx" ON "AgreementAcceptance"("signedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Trip_reservationId_key" ON "Trip"("reservationId");

-- CreateIndex
CREATE INDEX "ConditionReport_reservationId_phase_idx" ON "ConditionReport"("reservationId", "phase");

-- CreateIndex
CREATE INDEX "ConditionPhoto_conditionReportId_idx" ON "ConditionPhoto"("conditionReportId");

-- CreateIndex
CREATE UNIQUE INDEX "IdentityHandoffVerification_reservationId_key" ON "IdentityHandoffVerification"("reservationId");

-- CreateIndex
CREATE INDEX "IdentityHandoffVerification_reservationId_idx" ON "IdentityHandoffVerification"("reservationId");

-- CreateIndex
CREATE INDEX "TripChecklist_reservationId_idx" ON "TripChecklist"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "TripChecklist_reservationId_phase_role_step_key" ON "TripChecklist"("reservationId", "phase", "role", "step");

-- CreateIndex
CREATE INDEX "TripEvent_reservationId_createdAt_idx" ON "TripEvent"("reservationId", "createdAt");

-- CreateIndex
CREATE INDEX "DriverDocument_retentionExpiresAt_idx" ON "DriverDocument"("retentionExpiresAt");

-- CreateIndex
CREATE INDEX "Reservation_status_expiresAt_idx" ON "Reservation"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "Vehicle_hostId_idx" ON "Vehicle"("hostId");

-- AddForeignKey
ALTER TABLE "HostProfile" ADD CONSTRAINT "HostProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostEmployee" ADD CONSTRAINT "HostEmployee_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "HostProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostEmployee" ADD CONSTRAINT "HostEmployee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "HostProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentAccessLog" ADD CONSTRAINT "DocumentAccessLog_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "DriverDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentAccessLog" ADD CONSTRAINT "DocumentAccessLog_accessedById_fkey" FOREIGN KEY ("accessedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgreementAcceptance" ADD CONSTRAINT "AgreementAcceptance_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgreementAcceptance" ADD CONSTRAINT "AgreementAcceptance_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgreementAcceptance" ADD CONSTRAINT "AgreementAcceptance_signedByUserId_fkey" FOREIGN KEY ("signedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConditionReport" ADD CONSTRAINT "ConditionReport_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConditionReport" ADD CONSTRAINT "ConditionReport_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConditionPhoto" ADD CONSTRAINT "ConditionPhoto_conditionReportId_fkey" FOREIGN KEY ("conditionReportId") REFERENCES "ConditionReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityHandoffVerification" ADD CONSTRAINT "IdentityHandoffVerification_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityHandoffVerification" ADD CONSTRAINT "IdentityHandoffVerification_verifiedByHostId_fkey" FOREIGN KEY ("verifiedByHostId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripChecklist" ADD CONSTRAINT "TripChecklist_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripChecklist" ADD CONSTRAINT "TripChecklist_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripEvent" ADD CONSTRAINT "TripEvent_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripEvent" ADD CONSTRAINT "TripEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Database-level overlap protection for confirmed/blocking reservation
-- ranges (task: "Add database-level overlap protection ... using PostgreSQL
-- range/exclusion constraints"). This is a hard guarantee independent of
-- application code: even a bug in the API layer cannot create two
-- confirmed-or-later reservations for the same vehicle with overlapping
-- [pickupAt, returnAt) ranges.
--
-- Scope: intentionally limited to statuses with NO expiry (CONFIRMED and
-- every state after it — the vehicle is durably committed). CHECKOUT_HOLD
-- and AWAITING_PAYMENT are short-lived (`expiresAt`-bounded) and are
-- protected instead by the SERIALIZABLE transaction in the hold/checkout
-- API routes plus real-time `expiresAt` filtering in isVehicleAvailable().
-- A hard exclusion constraint can't reference `now()` (not IMMUTABLE), so it
-- cannot itself distinguish a live hold from one that merely hasn't been
-- swept yet — applying it to hold states would make an expired-but-not-yet-
-- cleaned-up hold wrongly block a legitimate new attempt at the database
-- layer even after the application layer correctly considers it free.
--
-- Requires btree_gist for the GiST equality operator class on the text
-- `vehicleId` column. Most managed Postgres providers (Neon, Supabase, RDS)
-- allow `CREATE EXTENSION IF NOT EXISTS` for this extension out of the box;
-- see README "Database Setup" for provider-specific notes if it's blocked.
-- Note: `pickupAt`/`returnAt` are Prisma `DateTime` columns, which map to
-- Postgres `timestamp without time zone` (the app treats/stores everything
-- in UTC itself — see the "Store all timestamps in UTC" convention used
-- throughout). The generated column below therefore uses `tsrange`, not
-- `tstzrange`: casting a naive `timestamp` to `timestamptz` depends on the
-- session's `TimeZone` setting and is only STABLE, not IMMUTABLE, which
-- Postgres requires for a generated-column expression.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Reservation"
  ADD COLUMN "duringRange" tsrange GENERATED ALWAYS AS (tsrange("pickupAt", "returnAt", '[)')) STORED;

ALTER TABLE "Reservation"
  ADD CONSTRAINT "reservation_no_overlap_when_blocking"
  EXCLUDE USING gist (
    "vehicleId" WITH =,
    "duringRange" WITH &&
  )
  WHERE (
    "status" IN (
      'CONFIRMED',
      'DOCUMENTS_REQUIRED',
      'READY_FOR_CHECK_IN',
      'CHECK_IN_PROGRESS',
      'READY_TO_START',
      'ACTIVE',
      'RETURN_IN_PROGRESS',
      'DISPUTED',
      'UNDER_CLAIM_REVIEW'
    )
  );
