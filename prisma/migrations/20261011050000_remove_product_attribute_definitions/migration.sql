BEGIN;
ALTER TABLE company ADD COLUMN "productPresetCategories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE company c SET "productPresetCategories" = ARRAY(
  SELECT DISTINCT category FROM "productAttributeDefinitions" d, unnest(d.categories) category
  WHERE d."companyId" = c.id AND d."presetManaged" AND d.status = 'ACTIVE'
  ORDER BY category
);
-- Facts remain in products.attributes, productVariants.attributes and typed detail rows.
DROP TABLE "productAttributeDefinitions";
DROP TYPE "ProductAttributeScope";
DROP TYPE "ProductAttributeType";
DROP TYPE "ProductAttributeStatus";
UPDATE products SET "searchRevision" = "searchRevision" + 1;
COMMIT;
