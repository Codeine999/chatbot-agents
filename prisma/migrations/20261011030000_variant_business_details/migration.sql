BEGIN;
ALTER TABLE "productVariants" ADD CONSTRAINT "productVariants_own_price_check"
  CHECK (price IS NULL OR price >= 0);
CREATE TABLE "fashionVariants" (
  "variantId" UUID PRIMARY KEY, "companyId" UUID NOT NULL,
  color VARCHAR(100), size VARCHAR(100), condition VARCHAR(100),
  UNIQUE ("variantId", "companyId"),
  FOREIGN KEY ("variantId", "companyId") REFERENCES "productVariants"(id, "companyId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "fashionVariants_companyId_idx" ON "fashionVariants"("companyId");
CREATE TABLE "restaurantVariants" (
  "variantId" UUID PRIMARY KEY, "companyId" UUID NOT NULL,
  portion VARCHAR(100), "spiceLevel" VARCHAR(100),
  UNIQUE ("variantId", "companyId"),
  FOREIGN KEY ("variantId", "companyId") REFERENCES "productVariants"(id, "companyId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "restaurantVariants_companyId_idx" ON "restaurantVariants"("companyId");
CREATE TABLE "hotelVariants" (
  "variantId" UUID PRIMARY KEY, "companyId" UUID NOT NULL,
  "bedType" VARCHAR(100), "maxGuests" INT, "roomArea" DECIMAL(10,2),
  CHECK ("maxGuests" IS NULL OR "maxGuests" > 0), CHECK ("roomArea" IS NULL OR "roomArea" > 0),
  UNIQUE ("variantId", "companyId"),
  FOREIGN KEY ("variantId", "companyId") REFERENCES "productVariants"(id, "companyId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "hotelVariants_companyId_idx" ON "hotelVariants"("companyId");
-- Copy old string fields without deleting JSON or guessing incompatible numeric values.
INSERT INTO "fashionVariants" ("variantId", "companyId", color, size, condition)
SELECT id, "companyId",
  CASE WHEN jsonb_typeof(attributes->'color')='string' AND length(attributes->>'color') <= 100 THEN attributes->>'color' END,
  CASE WHEN jsonb_typeof(attributes->'size')='string' AND length(attributes->>'size') <= 100 THEN attributes->>'size' END,
  CASE WHEN jsonb_typeof(attributes->'condition')='string' AND length(attributes->>'condition') <= 100 THEN attributes->>'condition' END
FROM "productVariants" WHERE attributes ?| ARRAY['color','size','condition'];
INSERT INTO "restaurantVariants" ("variantId", "companyId", portion, "spiceLevel")
SELECT id, "companyId",
  CASE WHEN jsonb_typeof(attributes->'portion')='string' AND length(attributes->>'portion') <= 100 THEN attributes->>'portion' END,
  CASE WHEN jsonb_typeof(attributes->'spice_level')='string' AND length(attributes->>'spice_level') <= 100 THEN attributes->>'spice_level' END
FROM "productVariants" WHERE attributes ?| ARRAY['portion','spice_level'];
INSERT INTO "hotelVariants" ("variantId", "companyId", "bedType")
SELECT id, "companyId", CASE WHEN jsonb_typeof(attributes->'bed_type')='string' AND length(attributes->>'bed_type') <= 100 THEN attributes->>'bed_type' END
FROM "productVariants" WHERE attributes ?| ARRAY['bed_type','max_guests','room_area'];
UPDATE "hotelVariants" h SET
  "maxGuests" = CASE WHEN jsonb_typeof(v.attributes->'max_guests')='number' THEN CASE
    WHEN (v.attributes->>'max_guests')::numeric > 0 AND (v.attributes->>'max_guests')::numeric <= 2147483647
    AND trunc((v.attributes->>'max_guests')::numeric) = (v.attributes->>'max_guests')::numeric
    THEN (v.attributes->>'max_guests')::numeric::int END END,
  "roomArea" = CASE WHEN jsonb_typeof(v.attributes->'room_area')='number' THEN CASE
    WHEN (v.attributes->>'room_area')::numeric > 0 AND (v.attributes->>'room_area')::numeric < 100000000
    AND round((v.attributes->>'room_area')::numeric,2) = (v.attributes->>'room_area')::numeric
    THEN (v.attributes->>'room_area')::numeric END END
FROM "productVariants" v WHERE v.id=h."variantId" AND v."companyId"=h."companyId";
INSERT INTO "productAttributeDefinitions" (id,"companyId",key,label,scope,type,"variantOption","presetManaged","sortOrder",categories,"updatedAt")
SELECT gen_random_uuid(), c.id, 'condition', 'สภาพสินค้า', 'VARIANT', 'TEXT', true, true, 12,
  COALESCE((SELECT d.categories FROM "productAttributeDefinitions" d WHERE d."companyId"=c.id AND d.key='size' AND d."tenantId" IS NULL), ARRAY[]::text[]), now()
FROM company c WHERE c."productBusinessType"='FASHION'
ON CONFLICT ("companyId",key) DO NOTHING;
-- Invalid/out-of-range legacy numeric values remain in JSON; they are not rounded or discarded.
COMMIT;
