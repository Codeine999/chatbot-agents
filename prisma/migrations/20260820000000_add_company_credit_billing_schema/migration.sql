-- Preserve the legacy per-type wallet rows before replacing them with the
-- company-wide decimal credit wallet used by the billing system.
DO $$
BEGIN
  IF to_regclass('public.credit_wallets') IS NOT NULL THEN
    ALTER TABLE "credit_wallets" RENAME TO "legacy_credit_wallets";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.legacy_credit_wallets'::regclass
      AND conname = 'credit_wallets_pkey'
  ) THEN
    ALTER TABLE "legacy_credit_wallets"
    RENAME CONSTRAINT "credit_wallets_pkey" TO "legacy_credit_wallets_pkey";
  END IF;
END $$;

DO $$
BEGIN
  CREATE TYPE "UsageKind" AS ENUM (
    'LINE_AI_REPLY',
    'ADMIN_AI_QUERY',
    'EMBEDDING',
    'LINE_PUSH_MESSAGE'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "LedgerType" AS ENUM (
    'TOPUP',
    'DEBIT',
    'REFUND',
    'ADJUSTMENT',
    'EXPIRE'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- A fresh database may not have a company row yet. Create the singleton
-- before moving the legacy wallet balance into the new company wallet.
INSERT INTO "company" (
  "id",
  "name",
  "messagesSentPeriod",
  "messagesSentCount",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid(),
  'My Company',
  '',
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "company");

CREATE TABLE "credit_wallets" (
  "id" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "balanceCredit" DECIMAL(20, 6) NOT NULL DEFAULT 0,
  "lifetimeTopupCredit" DECIMAL(20, 6) NOT NULL DEFAULT 0,
  "lifetimeSpentCredit" DECIMAL(20, 6) NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "credit_wallets_pkey" PRIMARY KEY ("id")
);

-- Keep existing credit available. The legacy usedTotal becomes lifetime spend,
-- and balance + spent becomes lifetime top-up for the unified company wallet.
INSERT INTO "credit_wallets" (
  "id",
  "companyId",
  "balanceCredit",
  "lifetimeTopupCredit",
  "lifetimeSpentCredit",
  "active",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid(),
  company."id",
  COALESCE((SELECT SUM("balance") FROM "legacy_credit_wallets"), 0),
  COALESCE(
    (
      SELECT SUM("balance") + SUM("usedTotal")
      FROM "legacy_credit_wallets"
    ),
    0
  ),
  COALESCE((SELECT SUM("usedTotal") FROM "legacy_credit_wallets"), 0),
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM (
  SELECT "id"
  FROM "company"
  ORDER BY "createdAt", "id"
  LIMIT 1
) AS company;

CREATE TABLE "ai_model_pricing" (
  "id" UUID NOT NULL,
  "provider" "AiProviderName" NOT NULL,
  "model" VARCHAR(150) NOT NULL,
  "inputCostThbPerMillTokens" DECIMAL(20, 6) NOT NULL DEFAULT 0,
  "outputCostThbPerMillTokens" DECIMAL(20, 6) NOT NULL DEFAULT 0,
  "cachedInputCostThbPerMillTokens" DECIMAL(20, 6),
  "cacheWriteCostThbPerMillTokens" DECIMAL(20, 6),
  "inputCreditPerMillTokens" DECIMAL(20, 6) NOT NULL DEFAULT 0,
  "outputCreditPerMillTokens" DECIMAL(20, 6) NOT NULL DEFAULT 0,
  "cachedInputCreditPerMillTokens" DECIMAL(20, 6),
  "cacheWriteCreditPerMillTokens" DECIMAL(20, 6),
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),

  CONSTRAINT "ai_model_pricing_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_usage_events" (
  "id" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "kind" "UsageKind" NOT NULL,
  "provider" "AiProviderName" NOT NULL,
  "model" VARCHAR(150) NOT NULL,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
  "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "costThb" DECIMAL(20, 6) NOT NULL DEFAULT 0,
  "chargedCredit" DECIMAL(20, 6) NOT NULL DEFAULT 0,
  "pricingId" UUID,
  "adminMemberId" UUID,
  "lineMemberId" UUID,
  "conversationId" UUID,
  "status" VARCHAR(20) NOT NULL DEFAULT 'success',
  "errorCode" VARCHAR(100),
  "latencyMs" INTEGER,
  "providerRequestId" VARCHAR(255),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_usage_events_pkey" PRIMARY KEY ("id")
);

-- `period` is removed by the following persistent-budget migration.
CREATE TABLE "credit_budgets" (
  "id" UUID NOT NULL,
  "walletId" UUID NOT NULL,
  "kind" "UsageKind" NOT NULL,
  "scopeKey" VARCHAR(64) NOT NULL DEFAULT '*',
  "period" VARCHAR(7) NOT NULL DEFAULT '',
  "limitCredit" DECIMAL(20, 6),
  "usedCredit" DECIMAL(20, 6) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "credit_budgets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "credit_ledger" (
  "id" UUID NOT NULL,
  "walletId" UUID NOT NULL,
  "type" "LedgerType" NOT NULL,
  "amountCredit" DECIMAL(20, 6) NOT NULL DEFAULT 0,
  "balanceAfterCredit" DECIMAL(20, 6) NOT NULL DEFAULT 0,
  "kind" "UsageKind",
  "usageEventId" UUID,
  "idempotencyKey" VARCHAR(255) NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "credit_wallets_companyId_key"
ON "credit_wallets"("companyId");

CREATE UNIQUE INDEX "credit_wallets_id_companyId_key"
ON "credit_wallets"("id", "companyId");

CREATE UNIQUE INDEX "credit_budgets_walletId_kind_scopeKey_period_key"
ON "credit_budgets"("walletId", "kind", "scopeKey", "period");

CREATE INDEX "ai_model_pricing_provider_model_effectiveFrom_effectiveTo_idx"
ON "ai_model_pricing"("provider", "model", "effectiveFrom", "effectiveTo");

CREATE UNIQUE INDEX "ai_model_pricing_provider_model_effectiveFrom_key"
ON "ai_model_pricing"("provider", "model", "effectiveFrom");

CREATE INDEX "ai_usage_events_companyId_createdAt_idx"
ON "ai_usage_events"("companyId", "createdAt");

CREATE INDEX "ai_usage_events_companyId_kind_createdAt_idx"
ON "ai_usage_events"("companyId", "kind", "createdAt");

CREATE INDEX "ai_usage_events_adminMemberId_createdAt_idx"
ON "ai_usage_events"("adminMemberId", "createdAt");

CREATE INDEX "ai_usage_events_provider_model_createdAt_idx"
ON "ai_usage_events"("provider", "model", "createdAt");

CREATE UNIQUE INDEX "credit_ledger_usageEventId_key"
ON "credit_ledger"("usageEventId");

CREATE UNIQUE INDEX "credit_ledger_idempotencyKey_key"
ON "credit_ledger"("idempotencyKey");

CREATE INDEX "credit_ledger_walletId_createdAt_idx"
ON "credit_ledger"("walletId", "createdAt");

CREATE INDEX "credit_ledger_walletId_kind_createdAt_idx"
ON "credit_ledger"("walletId", "kind", "createdAt");

ALTER TABLE "credit_wallets"
ADD CONSTRAINT "credit_wallets_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "company"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ai_usage_events"
ADD CONSTRAINT "ai_usage_events_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "company"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ai_usage_events"
ADD CONSTRAINT "ai_usage_events_pricingId_fkey"
FOREIGN KEY ("pricingId") REFERENCES "ai_model_pricing"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ai_usage_events"
ADD CONSTRAINT "ai_usage_events_adminMemberId_fkey"
FOREIGN KEY ("adminMemberId") REFERENCES "AdminMember"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "credit_budgets"
ADD CONSTRAINT "credit_budgets_walletId_fkey"
FOREIGN KEY ("walletId") REFERENCES "credit_wallets"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "credit_ledger"
ADD CONSTRAINT "credit_ledger_walletId_fkey"
FOREIGN KEY ("walletId") REFERENCES "credit_wallets"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "credit_ledger"
ADD CONSTRAINT "credit_ledger_usageEventId_fkey"
FOREIGN KEY ("usageEventId") REFERENCES "ai_usage_events"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
