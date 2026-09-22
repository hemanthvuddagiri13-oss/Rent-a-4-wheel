CREATE TABLE "ProviderFeeEvidence" (
 "providerId" TEXT PRIMARY KEY,
 "paymentId" TEXT NOT NULL UNIQUE REFERENCES "Payment"(id),
 "reservationId" TEXT NOT NULL REFERENCES "Reservation"(id),
 currency TEXT NOT NULL,
 "amountCents" INTEGER NOT NULL CHECK ("amountCents">=0),
 "feeCents" INTEGER NOT NULL CHECK ("feeCents">=0),
 "netCents" INTEGER NOT NULL,
 evidence JSONB NOT NULL,
 fingerprint TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ("amountCents"-"feeCents"="netCents")
);
CREATE INDEX "ProviderFeeEvidence_reservationId_idx" ON "ProviderFeeEvidence"("reservationId");
CREATE FUNCTION provider_fee_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Provider fee evidence is immutable';
END $$;
CREATE TRIGGER provider_fee_evidence_guard BEFORE UPDATE OR DELETE ON "ProviderFeeEvidence" FOR EACH ROW EXECUTE FUNCTION provider_fee_evidence_immutable();
