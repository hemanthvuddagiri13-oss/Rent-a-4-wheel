ALTER TABLE "Vehicle" ADD COLUMN "listingRevision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_listingRevision_positive" CHECK ("listingRevision" > 0);
