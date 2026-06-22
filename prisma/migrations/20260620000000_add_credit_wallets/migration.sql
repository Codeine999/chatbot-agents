-- CreateEnum
CREATE TYPE "CreditWalletType" AS ENUM ('LINE_MESSAGE', 'AI_USAGE', 'ADMIN_AI_QUERY');

-- Enable gen_random_uuid() for wallet primary keys.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateTable
CREATE TABLE "credit_wallets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "CreditWalletType" NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "usedTotal" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credit_wallets_type_key" ON "credit_wallets"("type");

-- Seed the global wallets. Only LINE_MESSAGE is consumed by this change.
INSERT INTO "credit_wallets" ("type")
VALUES ('LINE_MESSAGE'), ('AI_USAGE'), ('ADMIN_AI_QUERY');
