-- Price ranges (docs/multiPriceTransport.md). Every column is nullable and
-- existing rows keep their meaning: no maxPrice = an exact price, a slot
-- without a price = the variant's price applies. Nothing to backfill.

-- AlterTable
ALTER TABLE "productVariants" ADD COLUMN "maxPrice" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "productSlots" ADD COLUMN "price" DECIMAL(12,2),
ADD COLUMN "maxPrice" DECIMAL(12,2);

-- Hand-added constraints (not expressible in Prisma). A range needs a lower
-- bound below it; an estimated price cannot also advertise a discount.
ALTER TABLE "productVariants" ADD CONSTRAINT "productVariants_maxPrice_check"
  CHECK ("maxPrice" IS NULL OR ("price" IS NOT NULL AND "maxPrice" > "price"));
ALTER TABLE "productVariants" ADD CONSTRAINT "productVariants_maxPrice_compareAt_check"
  CHECK ("maxPrice" IS NULL OR "compareAtPrice" IS NULL);
ALTER TABLE "productSlots" ADD CONSTRAINT "productSlots_price_check"
  CHECK ("price" IS NULL OR "price" >= 0);
ALTER TABLE "productSlots" ADD CONSTRAINT "productSlots_maxPrice_check"
  CHECK ("maxPrice" IS NULL OR ("price" IS NOT NULL AND "maxPrice" > "price"));
