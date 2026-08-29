ALTER TABLE "credit_topups"
ADD COLUMN "exchangeRateId" UUID,
ADD COLUMN "paidAmount" DECIMAL(20, 6);

CREATE INDEX "credit_topups_exchangeRateId_idx"
ON "credit_topups"("exchangeRateId");

ALTER TABLE "credit_topups"
ADD CONSTRAINT "credit_topups_exchangeRateId_fkey"
FOREIGN KEY ("exchangeRateId") REFERENCES "credit_exchange_rates"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "credit_topups"
ADD CONSTRAINT "credit_topups_paid_amount_check"
CHECK ("paidAmount" IS NULL OR "paidAmount" > 0);
