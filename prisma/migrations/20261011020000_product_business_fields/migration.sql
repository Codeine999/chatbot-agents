BEGIN;
ALTER TABLE company ADD COLUMN "productBusinessType" VARCHAR(30);
-- Preserve the draft variant price field; existing priceOverride behavior is unchanged.
ALTER TABLE "productVariants" ADD COLUMN price DECIMAL(12,2);
ALTER TABLE "productAttributeDefinitions" ADD COLUMN "presetManaged" BOOLEAN NOT NULL DEFAULT false;

-- Only records demonstrably created by a preset are managed automatically.
-- Hand-created fields and ambiguous legacy definitions remain custom.
UPDATE "productAttributeDefinitions" d SET "presetManaged" = true
WHERE EXISTS (
  SELECT 1 FROM "productCatalogCommands" c
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(c.result->'created') = 'array'
      THEN c.result->'created' ELSE '[]'::jsonb END
  ) f
  WHERE c.action = 'APPLY_ATTRIBUTE_PRESET' AND c."companyId" = d."companyId"
    AND f->>'id' = d.id::text
);
-- Do not guess a selected business from a history of additive preset commands.
COMMIT;
