-- Additive Batch 1E repair. Historical fingerprints remain version 1 until
-- their complete unfinished tuple is verified under the application lock.
ALTER TABLE "Reservation" ADD COLUMN "bookingFingerprintVersion" integer NOT NULL DEFAULT 1;
ALTER TABLE "Reservation" ALTER COLUMN "bookingFingerprintVersion" SET DEFAULT 2;
ALTER TABLE "BookingDraft" ADD COLUMN "fingerprintVersion" integer NOT NULL DEFAULT 1;
ALTER TABLE "BookingDraft" ALTER COLUMN "fingerprintVersion" SET DEFAULT 2;
-- Deposits have always been created in USD; retain that original contract.
ALTER TABLE "SecurityDeposit" ADD COLUMN "currency" text NOT NULL DEFAULT 'usd';
ALTER TABLE "FinancialCase" ALTER COLUMN "amountCents" DROP NOT NULL;
ALTER TABLE "FinancialCase" ALTER COLUMN "currency" DROP NOT NULL;

-- Resolve amounts by identity, never by creation order. Conflicting or absent
-- candidates are unknown, not zero. Existing decision/audit evidence is untouched.
WITH candidates AS (
 SELECT c."id", p."amountCents" amount, p."currency" currency FROM "FinancialCase" c
 JOIN "Payment" p ON p."reservationId"=c."reservationId" AND p."type"='RENTAL'
 AND (p."id"=c."paymentId" OR p."idempotencyKey"=c."originalKey" OR p."stripePaymentIntentId"=c."providerId") WHERE c."kind"='RENTAL'
 UNION
 SELECT c."id", f."amountCents", p."currency" FROM "FinancialCase" c JOIN "Refund" f
 ON f."reservationId"=c."reservationId" AND (f."id"=c."refundId" OR f."idempotencyKey"=c."originalKey")
 JOIN "Payment" p ON p."id"=f."paymentId" WHERE c."kind"='REFUND'
 UNION
 SELECT c."id", d."amountCents", d."currency" FROM "FinancialCase" c
 LEFT JOIN "FinancialOperation" o ON o."id"=c."operationId" AND o."reservationId"=c."reservationId"
 JOIN "SecurityDeposit" d ON d."reservationId"=c."reservationId" AND
 ((c."kind"='DEPOSIT' AND (d."operationId"=o."id" OR d."stripePaymentIntentId"=COALESCE(o."providerId",c."providerId")))
 OR (c."kind"='DEPOSIT_RELEASE' AND d."stripePaymentIntentId"=o."payload"->>'intentId'))
 UNION
 SELECT c."id", (a."payload"->>'amount')::integer, a."payload"->>'currency' FROM "FinancialCase" c
 JOIN "FinancialOperation" o ON o."id"=c."operationId" AND o."reservationId"=c."reservationId"
 JOIN "FinancialOperation" a ON a."reservationId"=c."reservationId" AND a."kind"='DEPOSIT'
 AND ((c."kind"='DEPOSIT' AND a."id"=o."id") OR (c."kind"='DEPOSIT_RELEASE' AND a."providerId"=o."payload"->>'intentId'))
 WHERE a."payload"->>'amount' ~ '^[0-9]{1,9}$' AND a."payload"->>'currency' ~ '^[a-z]{3}$'
), basis AS (SELECT "id",min(amount) amount,min(currency) currency FROM candidates WHERE amount>0 AND currency IS NOT NULL GROUP BY "id" HAVING count(*)=1)
UPDATE "FinancialCase" c SET "amountCents"=b.amount,"currency"=b.currency FROM
 (SELECT c2."id",b.amount,b.currency FROM "FinancialCase" c2 LEFT JOIN basis b ON b."id"=c2."id") b
WHERE c."id"=b."id" AND c."status" NOT IN ('VERIFIED','RESOLVED');

UPDATE "FinancialOperation" o SET "state"='OBSERVED',"nextAttemptAt"=NULL,"leaseToken"=NULL,"leaseExpiresAt"=NULL
FROM "Refund" f WHERE o."kind"='REFUND' AND o."key"=f."idempotencyKey" AND o."reservationId"=f."reservationId"
AND f."status"<>'PENDING' AND NOT f."legacyUncertain";

-- A provider identity has one canonical purpose and reservation. Release
-- operations reference a deposit identity but do not acquire its ownership.
CREATE TABLE "ProviderObjectOwnership" (
 "providerId" text PRIMARY KEY, "kind" text NOT NULL, "reservationId" text NOT NULL,
 "operationId" text, "paymentId" text, "depositId" text, "refundId" text
);
CREATE FUNCTION claim_provider_object(pid text,k text,r text,o text,p text,d text,f text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO "ProviderObjectOwnership" VALUES(pid,k,r,o,p,d,f)
 ON CONFLICT ("providerId") DO UPDATE SET
 "operationId"=COALESCE("ProviderObjectOwnership"."operationId",EXCLUDED."operationId"),
 "paymentId"=COALESCE("ProviderObjectOwnership"."paymentId",EXCLUDED."paymentId"),
 "depositId"=COALESCE("ProviderObjectOwnership"."depositId",EXCLUDED."depositId"),
 "refundId"=COALESCE("ProviderObjectOwnership"."refundId",EXCLUDED."refundId")
 WHERE "ProviderObjectOwnership"."kind"=k AND "ProviderObjectOwnership"."reservationId"=r
 AND (o IS NULL OR "ProviderObjectOwnership"."operationId" IS NULL OR "ProviderObjectOwnership"."operationId"=o)
 AND (p IS NULL OR "ProviderObjectOwnership"."paymentId" IS NULL OR "ProviderObjectOwnership"."paymentId"=p)
 AND (d IS NULL OR "ProviderObjectOwnership"."depositId" IS NULL OR "ProviderObjectOwnership"."depositId"=d)
 AND (f IS NULL OR "ProviderObjectOwnership"."refundId" IS NULL OR "ProviderObjectOwnership"."refundId"=f);
 IF NOT FOUND THEN RAISE EXCEPTION 'Conflicting provider object ownership' USING ERRCODE='23514'; END IF;
END $$;
-- Backfill conflict identities as BLOCKED rather than deleting historical data.
DO $$ DECLARE x record; BEGIN
 FOR x IN SELECT "providerId" pid,"kind" k,"reservationId" r,"id" o,NULL::text p,NULL::text d,NULL::text f FROM "FinancialOperation" WHERE "providerId" IS NOT NULL AND "reservationId" IS NOT NULL AND "kind" IN ('RENTAL','DEPOSIT','REFUND')
 UNION ALL SELECT "stripePaymentIntentId",CASE WHEN "type" IN ('DEPOSIT_AUTH','DEPOSIT_CAPTURE') THEN 'DEPOSIT' ELSE "type"::text END,"reservationId",NULL,"id",NULL,NULL FROM "Payment" WHERE "stripePaymentIntentId" IS NOT NULL
 UNION ALL SELECT "stripePaymentIntentId",'DEPOSIT',"reservationId",NULL,NULL,"id",NULL FROM "SecurityDeposit" WHERE "stripePaymentIntentId" IS NOT NULL
 UNION ALL SELECT "stripeRefundId",'REFUND',"reservationId",NULL,NULL,NULL,"id" FROM "Refund" WHERE "stripeRefundId" IS NOT NULL
 LOOP
 BEGIN PERFORM claim_provider_object(x.pid,x.k,x.r,x.o,x.p,x.d,x.f);
 EXCEPTION WHEN check_violation THEN UPDATE "ProviderObjectOwnership" SET "kind"='BLOCKED' WHERE "providerId"=x.pid;
 END;
 END LOOP;
END $$;
CREATE FUNCTION enforce_provider_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid text;k text;o text;p text;d text;f text;
BEGIN
 IF TG_TABLE_NAME='FinancialOperation' THEN
   pid:=NEW."providerId";k:=NEW."kind";o:=NEW."id";
   IF k='DEPOSIT_RELEASE' THEN k:='DEPOSIT';o:=NULL; END IF;
 ELSIF TG_TABLE_NAME='Payment' THEN pid:=NEW."stripePaymentIntentId";p:=NEW."id";k:=CASE WHEN NEW."type" IN ('DEPOSIT_AUTH','DEPOSIT_CAPTURE') THEN 'DEPOSIT' ELSE NEW."type"::text END;
 ELSIF TG_TABLE_NAME='SecurityDeposit' THEN pid:=NEW."stripePaymentIntentId";d:=NEW."id";k:='DEPOSIT';
 ELSE pid:=NEW."stripeRefundId";f:=NEW."id";k:='REFUND'; END IF;
 IF pid IS NOT NULL THEN PERFORM claim_provider_object(pid,k,NEW."reservationId",o,p,d,f); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER provider_owner_operation BEFORE INSERT OR UPDATE OF "providerId","kind","reservationId" ON "FinancialOperation" FOR EACH ROW EXECUTE FUNCTION enforce_provider_ownership();
CREATE TRIGGER provider_owner_payment BEFORE INSERT OR UPDATE OF "stripePaymentIntentId","type","reservationId" ON "Payment" FOR EACH ROW EXECUTE FUNCTION enforce_provider_ownership();
CREATE TRIGGER provider_owner_deposit BEFORE INSERT OR UPDATE OF "stripePaymentIntentId","reservationId" ON "SecurityDeposit" FOR EACH ROW EXECUTE FUNCTION enforce_provider_ownership();
CREATE TRIGGER provider_owner_refund BEFORE INSERT OR UPDATE OF "stripeRefundId","reservationId" ON "Refund" FOR EACH ROW EXECUTE FUNCTION enforce_provider_ownership();

-- Surface pre-existing conflicting mappings without erasing provider evidence.
WITH affected AS (
 SELECT o."providerId",o."reservationId" FROM "FinancialOperation" o JOIN "ProviderObjectOwnership" p ON p."providerId"=o."providerId" AND p."kind"='BLOCKED'
 UNION SELECT o."stripePaymentIntentId",o."reservationId" FROM "Payment" o JOIN "ProviderObjectOwnership" p ON p."providerId"=o."stripePaymentIntentId" AND p."kind"='BLOCKED'
 UNION SELECT o."stripePaymentIntentId",o."reservationId" FROM "SecurityDeposit" o JOIN "ProviderObjectOwnership" p ON p."providerId"=o."stripePaymentIntentId" AND p."kind"='BLOCKED'
 UNION SELECT o."stripeRefundId",o."reservationId" FROM "Refund" o JOIN "ProviderObjectOwnership" p ON p."providerId"=o."stripeRefundId" AND p."kind"='BLOCKED'
)
INSERT INTO "FinancialCase" ("id","sourceKey","reservationId","customerId","kind","amountCents","currency","providerId","reason","updatedAt")
SELECT 'ownership:'||a."providerId"||':'||r."id",'ownership:'||a."providerId"||':'||r."id",r."id",r."customerId",'OWNERSHIP',NULL,NULL,a."providerId",'Conflicting historical provider ownership; investigate before settlement',now()
FROM affected a JOIN "Reservation" r ON r."id"=a."reservationId" ON CONFLICT ("sourceKey") DO NOTHING;
UPDATE "Reservation" r SET "financialDisposition"='REVIEW' WHERE EXISTS (SELECT 1 FROM "FinancialCase" c WHERE c."reservationId"=r."id" AND c."kind"='OWNERSHIP');
UPDATE "FinancialOperation" o SET "state"='REVIEW',"leaseToken"=NULL,"leaseExpiresAt"=NULL WHERE EXISTS (SELECT 1 FROM "ProviderObjectOwnership" p WHERE p."providerId"=o."providerId" AND p."kind"='BLOCKED');
