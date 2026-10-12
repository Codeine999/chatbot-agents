BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM products p WHERE NOT EXISTS (SELECT 1 FROM "productVariants" v WHERE v."productId"=p.id AND v."companyId"=p."companyId")) THEN
    RAISE EXCEPTION 'Products without variants require a variant before migration';
  END IF;
END $$;
ALTER TABLE "productVariants" RENAME COLUMN attributes TO meta;
ALTER TABLE "productVariants" ADD COLUMN "trackStock" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "productVariants" ADD COLUMN currency VARCHAR(3) NOT NULL DEFAULT 'THB';
UPDATE "productVariants" v SET
  price = COALESCE(v.price, v."priceOverride", p."basePrice"),
  "compareAtPrice" = CASE WHEN COALESCE(v."compareAtPrice", p."compareAtPrice") > COALESCE(v.price, v."priceOverride", p."basePrice") THEN COALESCE(v."compareAtPrice", p."compareAtPrice") ELSE NULL END,
  "trackStock" = p."trackStock", currency = p.currency,
  meta = p.attributes || v.meta
FROM products p WHERE v."productId"=p.id AND v."companyId"=p."companyId";
-- Preserve former catalog identifiers as aliases for existing customer conversations.
UPDATE products SET aliases = CASE WHEN sku = ANY(aliases) THEN aliases ELSE array_append(aliases, sku) END,
  "searchRevision" = "searchRevision" + 1;
ALTER TABLE "productVariants" DROP COLUMN "priceOverride";
ALTER TABLE "productVariants" ADD CONSTRAINT "productVariants_currency_check" CHECK (currency = 'THB');
ALTER TABLE "productVariants" ADD CONSTRAINT "productVariants_compare_check" CHECK ("compareAtPrice" IS NULL OR (price IS NOT NULL AND "compareAtPrice" > price));
ALTER TABLE products DROP COLUMN sku, DROP COLUMN attributes, DROP COLUMN "basePrice", DROP COLUMN "compareAtPrice", DROP COLUMN "trackStock", DROP COLUMN currency;
COMMIT;
