-- Product ownership becomes company-only. Stop old app workers before deployment.
-- Refuse to merge historical tenant partitions without an explicit data mapping.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM products WHERE "tenantId" IS NOT NULL) THEN
    RAISE EXCEPTION 'Company-only products require an explicit backfill for non-null tenantId rows';
  END IF;
END $$;

ALTER TABLE products RENAME COLUMN code TO sku;
ALTER INDEX "products_companyId_code_key" RENAME TO "products_companyId_sku_key";
DROP INDEX "products_companyId_tenantId_status_createdAt_id_idx";
ALTER TABLE products DROP COLUMN "tenantId";
CREATE INDEX "products_companyId_status_createdAt_id_idx"
  ON products ("companyId", status, "createdAt", id);
ALTER TABLE products ADD COLUMN active BOOLEAN NOT NULL DEFAULT true;

-- The searchable document now names its product identifier `sku`.
-- Keep old derived data for audit; revision mismatch prevents stale vector retrieval.
UPDATE products SET "searchRevision" = "searchRevision" + 1;

COMMIT;
