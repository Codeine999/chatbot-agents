ALTER TYPE "CreditTopupStatus" ADD VALUE IF NOT EXISTS 'rejected';

ALTER TABLE "credit_topups"
DROP CONSTRAINT "credit_topups_type_check";

ALTER TABLE "credit_topups"
ALTER COLUMN "type" DROP DEFAULT;

ALTER TABLE "credit_topups"
ALTER COLUMN "type" TYPE "PaymentType"
USING (
  CASE "type"
    WHEN 1 THEN 'Slip'::"PaymentType"
    ELSE 'Slip'::"PaymentType"
  END
);

ALTER TABLE "credit_topups"
ALTER COLUMN "type" SET DEFAULT 'Slip';

ALTER TABLE "credit_topups"
ADD COLUMN "rejectedById" UUID,
ADD COLUMN "rejectedAt" TIMESTAMP(3);

ALTER TABLE "credit_topups"
ADD CONSTRAINT "credit_topups_rejectedById_fkey"
FOREIGN KEY ("rejectedById") REFERENCES "AdminMember"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
