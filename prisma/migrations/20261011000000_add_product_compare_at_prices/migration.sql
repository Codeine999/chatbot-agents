-- Additive: existing selling prices and historical snapshots remain unchanged.
BEGIN;
ALTER TABLE products ADD COLUMN "compareAtPrice" DECIMAL(12,2);
ALTER TABLE "productVariants" ADD COLUMN "compareAtPrice" DECIMAL(12,2);
ALTER TABLE products ADD CONSTRAINT "products_compareAtPrice_check"
  CHECK ("compareAtPrice" IS NULL OR ("basePrice" IS NOT NULL AND "compareAtPrice" > "basePrice"));
-- Inherited base prices are validated by the catalog service under the parent lock.
ALTER TABLE "productVariants" ADD CONSTRAINT "productVariants_compareAtPrice_check"
  CHECK ("compareAtPrice" IS NULL OR ("compareAtPrice" > 0 AND
    ("priceOverride" IS NULL OR "compareAtPrice" > "priceOverride")));
COMMIT;
