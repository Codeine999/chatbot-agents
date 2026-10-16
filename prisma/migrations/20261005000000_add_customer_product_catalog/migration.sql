-- Phase 1: additive identity/catalog only. Do not apply unrelated legacy schema drift.
BEGIN;

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "CommerceChannel" AS ENUM ('LINE', 'FACEBOOK', 'WEB');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "tenantId" UUID,
    "memberId" UUID,
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channelIdentities" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "channel" "CommerceChannel" NOT NULL,
    "connectionKey" VARCHAR(100) NOT NULL,
    "externalUserId" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channelIdentities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accountLinkChallenges" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "redeemedIdentityId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accountLinkChallenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "tenantId" UUID,
    "code" VARCHAR(100) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT NOT NULL DEFAULT '',
    "category" VARCHAR(100),
    "language" VARCHAR(10) NOT NULL DEFAULT 'th',
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "presetVersion" INTEGER NOT NULL DEFAULT 1,
    "basePrice" DECIMAL(12,2),
    "currency" VARCHAR(3) NOT NULL DEFAULT 'THB',
    "trackStock" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "searchRevision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "productVariants" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "sku" VARCHAR(100) NOT NULL,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "priceOverride" DECIMAL(12,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "productVariants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventoryBalances" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventoryBalances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "productCatalogCommands" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "tenantId" UUID,
    "requestId" UUID NOT NULL,
    "actorAdminId" UUID NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "productCatalogCommands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventoryMovements" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "commandId" UUID NOT NULL,
    "actorAdminId" UUID NOT NULL,
    "deltaOnHand" INTEGER NOT NULL,
    "deltaReserved" INTEGER NOT NULL DEFAULT 0,
    "onHandAfter" INTEGER NOT NULL,
    "reservedAfter" INTEGER NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "operationKey" VARCHAR(150) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventoryMovements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_companyId_tenantId_status_idx" ON "customers"("companyId", "tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "customers_id_companyId_key" ON "customers"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "customers_companyId_memberId_key" ON "customers"("companyId", "memberId");

-- CreateIndex
CREATE INDEX "channelIdentities_customerId_companyId_idx" ON "channelIdentities"("customerId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "channelIdentities_id_companyId_key" ON "channelIdentities"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "channelIdentities_namespace_key" ON "channelIdentities"("companyId", "channel", "connectionKey", "externalUserId");

-- CreateIndex
CREATE UNIQUE INDEX "accountLinkChallenges_tokenHash_key" ON "accountLinkChallenges"("tokenHash");

-- CreateIndex
CREATE INDEX "accountLinkChallenges_companyId_expiresAt_idx" ON "accountLinkChallenges"("companyId", "expiresAt");

-- CreateIndex
CREATE INDEX "products_companyId_tenantId_status_createdAt_id_idx" ON "products"("companyId", "tenantId", "status", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "products_id_companyId_key" ON "products"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "products_companyId_code_key" ON "products"("companyId", "code");

-- CreateIndex
CREATE INDEX "productVariants_productId_companyId_active_idx" ON "productVariants"("productId", "companyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "productVariants_id_companyId_key" ON "productVariants"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "productVariants_companyId_sku_key" ON "productVariants"("companyId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "inventoryBalances_variantId_key" ON "inventoryBalances"("variantId");

-- CreateIndex
CREATE INDEX "inventoryBalances_companyId_idx" ON "inventoryBalances"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "inventoryBalances_variantId_companyId_key" ON "inventoryBalances"("variantId", "companyId");

-- CreateIndex
CREATE INDEX "productCatalogCommands_companyId_createdAt_idx" ON "productCatalogCommands"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "productCatalogCommands_id_companyId_key" ON "productCatalogCommands"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "productCatalogCommands_companyId_requestId_key" ON "productCatalogCommands"("companyId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "inventoryMovements_commandId_key" ON "inventoryMovements"("commandId");

-- CreateIndex
CREATE UNIQUE INDEX "inventoryMovements_operationKey_key" ON "inventoryMovements"("operationKey");

-- CreateIndex
CREATE INDEX "inventoryMovements_variantId_companyId_createdAt_idx" ON "inventoryMovements"("variantId", "companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "inventoryMovements_commandId_companyId_key" ON "inventoryMovements"("commandId", "companyId");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "member"("uuid") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channelIdentities" ADD CONSTRAINT "channelIdentities_customerId_companyId_fkey" FOREIGN KEY ("customerId", "companyId") REFERENCES "customers"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accountLinkChallenges" ADD CONSTRAINT "accountLinkChallenges_customerId_companyId_fkey" FOREIGN KEY ("customerId", "companyId") REFERENCES "customers"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accountLinkChallenges" ADD CONSTRAINT "accountLinkChallenges_redeemedIdentityId_companyId_fkey" FOREIGN KEY ("redeemedIdentityId", "companyId") REFERENCES "channelIdentities"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productVariants" ADD CONSTRAINT "productVariants_productId_companyId_fkey" FOREIGN KEY ("productId", "companyId") REFERENCES "products"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventoryBalances" ADD CONSTRAINT "inventoryBalances_variantId_companyId_fkey" FOREIGN KEY ("variantId", "companyId") REFERENCES "productVariants"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productCatalogCommands" ADD CONSTRAINT "productCatalogCommands_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productCatalogCommands" ADD CONSTRAINT "productCatalogCommands_actorAdminId_fkey" FOREIGN KEY ("actorAdminId") REFERENCES "adminMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventoryMovements" ADD CONSTRAINT "inventoryMovements_variantId_companyId_fkey" FOREIGN KEY ("variantId", "companyId") REFERENCES "productVariants"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventoryMovements" ADD CONSTRAINT "inventoryMovements_commandId_companyId_fkey" FOREIGN KEY ("commandId", "companyId") REFERENCES "productCatalogCommands"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventoryMovements" ADD CONSTRAINT "inventoryMovements_actorAdminId_fkey" FOREIGN KEY ("actorAdminId") REFERENCES "adminMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "lineMember" ADD COLUMN "customerId" UUID;
CREATE INDEX "lineMember_customerId_idx" ON "lineMember"("customerId");
ALTER TABLE "lineMember" ADD CONSTRAINT "lineMember_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES customers(id) ON DELETE RESTRICT ON UPDATE CASCADE;

-- The legacy memberId column was added without its schema FK. Preserve all old rows;
-- NOT VALID enforces new writes immediately. Audit orphan mappings before later validation.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"lineMember"'::regclass AND confrelid = 'member'::regclass AND contype = 'f'
      AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = '"lineMember"'::regclass AND attname = 'memberId')]::smallint[]
  ) THEN
    ALTER TABLE "lineMember" ADD CONSTRAINT "lineMember_memberId_fkey"
      FOREIGN KEY ("memberId") REFERENCES member(uuid) ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

ALTER TABLE products
  ADD CONSTRAINT "products_price_check" CHECK ("basePrice" IS NULL OR "basePrice" >= 0),
  ADD CONSTRAINT "products_currency_check" CHECK (currency = 'THB'),
  ADD CONSTRAINT "products_revision_check" CHECK (revision > 0 AND "searchRevision" > 0 AND "presetVersion" = 1),
  ADD CONSTRAINT "products_attributes_check" CHECK (jsonb_typeof(attributes) = 'object');
ALTER TABLE "productVariants"
  ADD CONSTRAINT "productVariants_price_check" CHECK ("priceOverride" IS NULL OR "priceOverride" >= 0),
  ADD CONSTRAINT "productVariants_version_check" CHECK (version > 0),
  ADD CONSTRAINT "productVariants_attributes_check" CHECK (jsonb_typeof(attributes) = 'object');
ALTER TABLE "inventoryBalances"
  ADD CONSTRAINT "inventoryBalances_counters_check" CHECK ("onHand" >= reserved AND reserved >= 0),
  ADD CONSTRAINT "inventoryBalances_version_check" CHECK (version > 0);
ALTER TABLE "inventoryMovements"
  ADD CONSTRAINT "inventoryMovements_counters_check" CHECK ("onHandAfter" >= "reservedAfter" AND "reservedAfter" >= 0),
  ADD CONSTRAINT "inventoryMovements_effect_check" CHECK ("deltaOnHand" <> 0 OR "deltaReserved" <> 0);
ALTER TABLE "accountLinkChallenges"
  ADD CONSTRAINT "accountLinkChallenges_deadline_check" CHECK ("expiresAt" > "createdAt"),
  ADD CONSTRAINT "accountLinkChallenges_consumption_check" CHECK (("consumedAt" IS NULL) = ("redeemedIdentityId" IS NULL));
COMMIT;
