-- Old-schema fixture data used ONLY to test that the phase1 migration
-- correctly preserves and maps existing rows. Not part of the applied
-- migration set — run manually against a pre-phase1 database before
-- applying phase1, to prove the migration is safe on populated data.
INSERT INTO "User" ("id", "email", "role", "createdAt", "updatedAt") VALUES
  ('mig_test_user_1', 'mig-test-1@example.com', 'CUSTOMER', now(), now()),
  ('mig_test_user_2', 'mig-test-2@example.com', 'CUSTOMER', now(), now());

INSERT INTO "Vehicle" (
  "id", "slug", "vin", "licensePlate", "year", "make", "model", "category",
  "dailyRateCents", "weeklyRateCents", "monthlyRateCents", "status", "createdAt", "updatedAt"
) VALUES (
  'mig_test_vehicle_1', 'mig-test-vehicle', 'MIGTESTVIN000001', 'MIG-001', 2024, 'TestMake', 'TestModel',
  'SEDAN', 5000, 30000, 90000, 'ACTIVE', now(), now()
);

-- One row per legacy status value this migration must map.
INSERT INTO "Reservation" (
  "id", "confirmationNumber", "customerId", "vehicleId", "pickupAt", "returnAt",
  "pickupLocation", "returnLocation", "rateType", "rateAmountCents", "units",
  "subtotalCents", "taxCents", "feesCents", "discountCents", "extrasCents", "totalCents", "depositCents",
  "status", "driverFirstName", "driverLastName", "driverDob", "driverEmail", "driverPhone",
  "driverAddress", "driverCity", "driverState", "driverZip", "driverCountry",
  "licenseNumber", "licenseState", "licenseExpiration", "createdAt", "updatedAt"
) VALUES
  ('mig_test_res_pending', 'RA4W-MIGP01', 'mig_test_user_1', 'mig_test_vehicle_1',
   '2027-01-10 10:00:00', '2027-01-13 10:00:00', 'Dallas, TX', 'Dallas, TX',
   'DAILY', 5000, 3, 15000, 0, 0, 0, 0, 15000, 0,
   'PENDING', 'Test', 'User', '1990-01-01', 't@example.com', '555-0100',
   '123 St', 'Dallas', 'TX', '75201', 'US', 'TX123', 'TX', '2030-01-01', now(), now()),
  ('mig_test_res_confirmed', 'RA4W-MIGC01', 'mig_test_user_1', 'mig_test_vehicle_1',
   '2027-02-10 10:00:00', '2027-02-13 10:00:00', 'Dallas, TX', 'Dallas, TX',
   'DAILY', 5000, 3, 15000, 0, 0, 0, 0, 15000, 0,
   'CONFIRMED', 'Test', 'User', '1990-01-01', 't@example.com', '555-0100',
   '123 St', 'Dallas', 'TX', '75201', 'US', 'TX123', 'TX', '2030-01-01', now(), now()),
  ('mig_test_res_active', 'RA4W-MIGA01', 'mig_test_user_1', 'mig_test_vehicle_1',
   '2027-03-10 10:00:00', '2027-03-13 10:00:00', 'Dallas, TX', 'Dallas, TX',
   'DAILY', 5000, 3, 15000, 0, 0, 0, 0, 15000, 0,
   'ACTIVE', 'Test', 'User', '1990-01-01', 't@example.com', '555-0100',
   '123 St', 'Dallas', 'TX', '75201', 'US', 'TX123', 'TX', '2030-01-01', now(), now()),
  ('mig_test_res_completed', 'RA4W-MIGD01', 'mig_test_user_1', 'mig_test_vehicle_1',
   '2027-04-10 10:00:00', '2027-04-13 10:00:00', 'Dallas, TX', 'Dallas, TX',
   'DAILY', 5000, 3, 15000, 0, 0, 0, 0, 15000, 0,
   'COMPLETED', 'Test', 'User', '1990-01-01', 't@example.com', '555-0100',
   '123 St', 'Dallas', 'TX', '75201', 'US', 'TX123', 'TX', '2030-01-01', now(), now()),
  ('mig_test_res_cancelled', 'RA4W-MIGX01', 'mig_test_user_2', 'mig_test_vehicle_1',
   '2027-05-10 10:00:00', '2027-05-13 10:00:00', 'Dallas, TX', 'Dallas, TX',
   'DAILY', 5000, 3, 15000, 0, 0, 0, 0, 15000, 0,
   'CANCELLED', 'Test', 'User', '1990-01-01', 't@example.com', '555-0100',
   '123 St', 'Dallas', 'TX', '75201', 'US', 'TX123', 'TX', '2030-01-01', now(), now());

INSERT INTO "DriverDocument" ("id", "userId", "reservationId", "side", "storageKey", "status", "createdAt", "updatedAt") VALUES
  ('mig_test_doc_front', 'mig_test_user_1', 'mig_test_res_confirmed', 'FRONT', 'local:mig-front.jpg', 'PENDING_VERIFICATION', now(), now()),
  ('mig_test_doc_back', 'mig_test_user_1', 'mig_test_res_confirmed', 'BACK', 'local:mig-back.jpg', 'APPROVED', now(), now());

INSERT INTO "LegalDocument" ("id", "type", "version", "title", "content", "needsAttorneyReview", "updatedAt") VALUES
  ('mig_test_legal_1', 'RENTAL_AGREEMENT', 'v1-legacy', 'Rental Agreement', 'Legacy placeholder terms.', true, now());

INSERT INTO "RentalAgreement" ("id", "reservationId", "documentVersion", "acceptedAt", "signerName", "createdAt") VALUES
  ('mig_test_agreement_1', 'mig_test_res_confirmed', 'v1-legacy', now(), 'Test User', now());
