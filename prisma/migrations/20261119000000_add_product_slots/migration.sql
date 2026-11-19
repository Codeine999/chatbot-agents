-- CreateEnum
CREATE TYPE "ProductSlotStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');
-- CreateTable
CREATE TABLE "productSlots" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "status" "ProductSlotStatus" NOT NULL DEFAULT 'OPEN',
    "capacity" INTEGER,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "availabilityAt" TIMESTAMP(3),
    "meta" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "productSlots_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "productSlots_companyId_startsAt_idx" ON "productSlots"("companyId", "startsAt");
-- CreateIndex
CREATE UNIQUE INDEX "productSlots_id_companyId_key" ON "productSlots"("id", "companyId");
-- CreateIndex
CREATE UNIQUE INDEX "productSlots_variantId_startsAt_key" ON "productSlots"("variantId", "startsAt");
-- AddForeignKey
ALTER TABLE "productSlots" ADD CONSTRAINT "productSlots_variantId_companyId_fkey" FOREIGN KEY ("variantId", "companyId") REFERENCES "productVariants"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-added constraints (not expressible in Prisma). reserved <= capacity is
-- deliberately NOT enforced: synced external data may overbook, availability
-- is computed with max(0, capacity - reserved).
ALTER TABLE "productSlots" ADD CONSTRAINT "productSlots_capacity_nonnegative" CHECK ("capacity" IS NULL OR "capacity" >= 0);
ALTER TABLE "productSlots" ADD CONSTRAINT "productSlots_reserved_nonnegative" CHECK ("reserved" >= 0);
