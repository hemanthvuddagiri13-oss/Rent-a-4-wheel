-- Freeze the original earning allocation. Corrections remain signed ledger
-- consequences, and all projection writers share the provider dispatch guard.
CREATE TRIGGER aa_financial_guard BEFORE INSERT OR UPDATE OR DELETE ON "HostEarning"
 FOR EACH ROW EXECUTE FUNCTION financial_authority_guard();
CREATE FUNCTION protect_earning_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW."reservationId",NEW."hostId",NEW.currency,NEW."grossCents",NEW."commissionCents",NEW."hostDiscountCents",NEW."netCents",NEW."createdAt") IS DISTINCT FROM
    (OLD.id,OLD."reservationId",OLD."hostId",OLD.currency,OLD."grossCents",OLD."commissionCents",OLD."hostDiscountCents",OLD."netCents",OLD."createdAt") THEN
  RAISE EXCEPTION 'Immutable earning origin; use an approved accounting adjustment';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER earning_origin_immutable BEFORE UPDATE ON "HostEarning"
 FOR EACH ROW EXECUTE FUNCTION protect_earning_origin();
ALTER TABLE "HostEarning" ADD CONSTRAINT earning_amounts_nonnegative CHECK
 ("grossCents">=0 AND "commissionCents">=0 AND "hostDiscountCents">=0 AND "netCents">=0 AND "refundedCents">=0 AND "netCents"::bigint-"refundedCents"+"adjustmentCents">=0);
CREATE INDEX earning_deferred_balance ON "HostEarning" ("hostId","createdAt",id)
 WHERE "holdReason" IS NULL AND "checkedAt" IS NOT NULL;
