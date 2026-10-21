BEGIN;
-- Every business stores its field values in "productVariants".meta, keyed by
-- the preset field keys. For the company's selected business the typed row was
-- the authoritative value, so it overwrites meta. A row of a business the
-- company no longer uses is kept, but never shadows what meta shows today.
UPDATE "productVariants" v
SET meta = CASE WHEN c."productBusinessType" = 'FASHION'
  THEN v.meta || d.attrs ELSE d.attrs || v.meta END
FROM (
  SELECT "variantId", "companyId", jsonb_strip_nulls(jsonb_build_object(
    'color', color, 'size', size, 'condition', condition)) AS attrs
  FROM "fashionVariants"
) d, company c
WHERE d."variantId" = v.id AND d."companyId" = v."companyId" AND c.id = v."companyId";

UPDATE "productVariants" v
SET meta = CASE WHEN c."productBusinessType" = 'RESTAURANT'
  THEN v.meta || d.attrs ELSE d.attrs || v.meta END
FROM (
  SELECT "variantId", "companyId", jsonb_strip_nulls(jsonb_build_object(
    'portion', portion, 'spice_level', "spiceLevel")) AS attrs
  FROM "restaurantVariants"
) d, company c
WHERE d."variantId" = v.id AND d."companyId" = v."companyId" AND c.id = v."companyId";

-- maxGuests/roomArea become JSON numbers, which is what NUMBER fields store.
UPDATE "productVariants" v
SET meta = CASE WHEN c."productBusinessType" = 'HOTEL'
  THEN v.meta || d.attrs ELSE d.attrs || v.meta END
FROM (
  SELECT "variantId", "companyId", jsonb_strip_nulls(jsonb_build_object(
    'bed_type', "bedType", 'max_guests', "maxGuests", 'room_area', "roomArea")) AS attrs
  FROM "hotelVariants"
) d, company c
WHERE d."variantId" = v.id AND d."companyId" = v."companyId" AND c.id = v."companyId";

-- No searchRevision bump: the selected business reads the same values from
-- meta, and other businesses' keys are outside its preset, so every product
-- document (and its embedding) is unchanged.
DROP TABLE "fashionVariants";
DROP TABLE "restaurantVariants";
DROP TABLE "hotelVariants";
COMMIT;
