-- Additive: store-defined product/variant fields. No existing column, value,
-- precision, vector dimension or ledger row is changed or removed.
BEGIN;
CREATE TYPE "ProductAttributeScope" AS ENUM ('PRODUCT', 'VARIANT');
CREATE TYPE "ProductAttributeType" AS ENUM ('TEXT', 'NUMBER', 'BOOLEAN', 'SELECT', 'MULTI_SELECT', 'TAGS');
CREATE TYPE "ProductAttributeStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

CREATE TABLE "productAttributeDefinitions" (
  id uuid PRIMARY KEY,
  "companyId" uuid NOT NULL,
  "tenantId" uuid,
  key varchar(50) NOT NULL,
  label varchar(100) NOT NULL,
  scope "ProductAttributeScope" NOT NULL,
  type "ProductAttributeType" NOT NULL,
  options text[] NOT NULL DEFAULT ARRAY[]::text[],
  "valueAliases" jsonb NOT NULL DEFAULT '{}',
  unit varchar(20),
  required boolean NOT NULL DEFAULT false,
  "variantOption" boolean NOT NULL DEFAULT false,
  searchable boolean NOT NULL DEFAULT true,
  "aiVisible" boolean NOT NULL DEFAULT true,
  categories text[] NOT NULL DEFAULT ARRAY[]::text[],
  "sortOrder" integer NOT NULL DEFAULT 0,
  status "ProductAttributeStatus" NOT NULL DEFAULT 'ACTIVE',
  version integer NOT NULL DEFAULT 1,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "productAttributeDefinitions_key_check" CHECK (key ~ '^[a-z][a-z0-9_]{0,49}$'),
  CONSTRAINT "productAttributeDefinitions_variantOption_check" CHECK (NOT "variantOption" OR scope = 'VARIANT'),
  CONSTRAINT "productAttributeDefinitions_options_check" CHECK (type IN ('SELECT', 'MULTI_SELECT') OR cardinality(options) = 0),
  CONSTRAINT "productAttributeDefinitions_aliases_check" CHECK (jsonb_typeof("valueAliases") = 'object'),
  CONSTRAINT "productAttributeDefinitions_version_check" CHECK (version >= 1),
  FOREIGN KEY ("companyId") REFERENCES company(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "productAttributeDefinitions_id_companyId_key" ON "productAttributeDefinitions"(id, "companyId");
CREATE UNIQUE INDEX "productAttributeDefinitions_companyId_key_key" ON "productAttributeDefinitions"("companyId", key);
CREATE INDEX "productAttributeDefinitions_companyId_tenantId_status_sortOrder_idx" ON "productAttributeDefinitions"("companyId", "tenantId", status, "sortOrder");

-- Compatibility backfill: values written under the former fixed schema
-- (material/features on products, color/size on variants) stay valid by
-- registering exactly those keys for each company that already uses them.
INSERT INTO "productAttributeDefinitions"
  (id, "companyId", "tenantId", key, label, scope, type, "valueAliases", "variantOption", "sortOrder", "updatedAt")
SELECT gen_random_uuid(), used."companyId", used."tenantId", legacy.key, legacy.label,
       legacy.scope::"ProductAttributeScope", legacy.type::"ProductAttributeType",
       legacy.aliases::jsonb, legacy.option, legacy.sort, CURRENT_TIMESTAMP
FROM (VALUES
  ('material', 'เนื้อผ้า', 'PRODUCT', 'TEXT', '{}', false, 30),
  ('features', 'จุดเด่น', 'PRODUCT', 'TAGS', '{}', false, 40),
  ('color', 'สี', 'VARIANT', 'TEXT',
   '{"ดำ":["black","สีดำ"],"ขาว":["white","สีขาว"],"แดง":["red","สีแดง"],"เขียว":["green","สีเขียว"],"เหลือง":["yellow","สีเหลือง"],"ชมพู":["pink","สีชมพู"],"เทา":["gray","grey","สีเทา"],"น้ำตาล":["brown","สีน้ำตาล"],"ส้ม":["orange","สีส้ม"],"ม่วง":["purple","สีม่วง"],"ครีม":["cream","สีครีม"],"เบจ":["beige","สีเบจ"]}',
   true, 10),
  ('size', 'ไซส์', 'VARIANT', 'TEXT', '{"Free Size":["ฟรีไซส์","ฟรีไซซ์","freesize"]}', true, 20)
) AS legacy(key, label, scope, type, aliases, option, sort)
JOIN LATERAL (
  SELECT DISTINCT p."companyId", p."tenantId" FROM products p
  WHERE (legacy.scope = 'PRODUCT' AND jsonb_exists(p.attributes, legacy.key))
     OR (legacy.scope = 'VARIANT' AND EXISTS (
          SELECT 1 FROM "productVariants" v
          WHERE v."productId" = p.id AND v."companyId" = p."companyId" AND jsonb_exists(v.attributes, legacy.key)))
) used ON true
ON CONFLICT ("companyId", key) DO NOTHING;
COMMIT;
