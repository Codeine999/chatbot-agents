CREATE TABLE IF NOT EXISTS "packagePrice" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "priceThb" DECIMAL(20, 2) NOT NULL,
    "popular" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "packagePrice_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "packagePrice"
ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'packagePrice_positive_price_check'
    ) THEN
        ALTER TABLE "packagePrice"
        ADD CONSTRAINT "packagePrice_positive_price_check"
        CHECK ("priceThb" > 0);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "packagePrice_active_sortOrder_idx"
ON "packagePrice"("active", "sortOrder");

ALTER TABLE "credit_topups"
ADD COLUMN IF NOT EXISTS "packagePriceId" UUID;

CREATE INDEX IF NOT EXISTS "credit_topups_packagePriceId_idx"
ON "credit_topups"("packagePriceId");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'credit_topups_packagePriceId_fkey'
    ) THEN
        ALTER TABLE "credit_topups"
        ADD CONSTRAINT "credit_topups_packagePriceId_fkey"
        FOREIGN KEY ("packagePriceId") REFERENCES "packagePrice"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;
