ALTER TYPE "AiProviderName" ADD VALUE IF NOT EXISTS 'MAXPLUS';
ALTER TABLE "ai_usage_events" ADD COLUMN IF NOT EXISTS "scopeKey" VARCHAR(64);
CREATE INDEX IF NOT EXISTS "ai_usage_events_companyId_kind_scopeKey_createdAt_idx"
  ON "ai_usage_events"("companyId", "kind", "scopeKey", "createdAt");
-- Schema had this optional relation before a matching migration existed.
ALTER TABLE "LineMember" ADD COLUMN IF NOT EXISTS "memberId" UUID;
CREATE INDEX IF NOT EXISTS "LineMember_memberId_idx" ON "LineMember"("memberId");
ALTER TABLE "LineChatHistory" ADD COLUMN IF NOT EXISTS "sentByAdminId" UUID;
CREATE INDEX IF NOT EXISTS "LineChatHistory_sentByAdminId_idx" ON "LineChatHistory"("sentByAdminId");

ALTER TABLE "ProcessedLineWebhookEvent"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'COMPLETED',
  ADD COLUMN "event" JSONB,
  ADD COLUMN "leaseOwner" TEXT,
  ADD COLUMN "leaseUntil" TIMESTAMP(3),
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastError" TEXT;
CREATE INDEX "ProcessedLineWebhookEvent_status_leaseUntil_idx"
  ON "ProcessedLineWebhookEvent"("status", "leaseUntil");

CREATE TABLE "LineDelivery" (
  "id" UUID NOT NULL PRIMARY KEY,
  "key" TEXT NOT NULL,
  "lineUserId" TEXT NOT NULL,
  "conversationId" UUID NOT NULL,
  "lineMemberId" UUID NOT NULL,
  "adminMemberId" UUID,
  "text" TEXT NOT NULL,
  "replyToken" TEXT,
  "replyUntil" TIMESTAMP(3),
  "context" JSONB,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "method" TEXT NOT NULL DEFAULT 'REPLY',
  "retryKey" UUID NOT NULL,
  "firstPushAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "lastError" TEXT,
  "acceptedAt" TIMESTAMP(3),
  "finalizedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "LineDelivery_key_key" ON "LineDelivery"("key");
CREATE INDEX "LineDelivery_status_nextAttemptAt_idx" ON "LineDelivery"("status", "nextAttemptAt");
ALTER TABLE "LineChatHistory" ADD COLUMN "deliveryId" UUID;
CREATE UNIQUE INDEX "LineChatHistory_deliveryId_key" ON "LineChatHistory"("deliveryId");

CREATE TABLE "CreditReservation" (
  "id" UUID NOT NULL PRIMARY KEY,
  "operationKey" TEXT NOT NULL,
  "companyId" UUID NOT NULL,
  "walletId" UUID NOT NULL REFERENCES "credit_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "budgetId" UUID NOT NULL REFERENCES "credit_budgets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "amountCredit" DECIMAL(20,6) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'HELD',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "CreditReservation_operationKey_key" ON "CreditReservation"("operationKey");
CREATE INDEX "CreditReservation_status_expiresAt_idx" ON "CreditReservation"("status", "expiresAt");
-- Existing aggregate reservations are deliberately not reset: old calls may still be in flight.

CREATE TABLE "AdminBootstrap" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "AdminBootstrap" ("id") SELECT 'owner' WHERE EXISTS (SELECT 1 FROM "AdminMember");
