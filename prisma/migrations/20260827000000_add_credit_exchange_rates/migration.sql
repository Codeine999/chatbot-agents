CREATE TABLE "credit_exchange_rates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "creditsPerThb" DECIMAL(20, 6) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),

    CONSTRAINT "credit_exchange_rates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "credit_exchange_rates_positive_rate_check"
        CHECK ("creditsPerThb" > 0)
);

-- This is a singleton configuration table: the application and database both
-- reject a second row, including concurrent create requests.
CREATE UNIQUE INDEX "credit_exchange_rates_singleton_idx"
ON "credit_exchange_rates" ((true));
