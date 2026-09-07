-- Rename application tables only. PostgreSQL preserves rows, foreign keys,
-- indexes, and sequences when a table is renamed. `_prisma_migrations` is
-- intentionally excluded because Prisma owns that internal table name.

ALTER TABLE IF EXISTS "Member" RENAME TO "member";
ALTER TABLE IF EXISTS "Payment" RENAME TO "payment";
ALTER TABLE IF EXISTS "UserPayment" RENAME TO "payment";
ALTER TABLE IF EXISTS "ai_settings" RENAME TO "aiSettings";
ALTER TABLE IF EXISTS "AiSetting" RENAME TO "aiSettings";
ALTER TABLE IF EXISTS "AnswerPattern" RENAME TO "answerPattern";
ALTER TABLE IF EXISTS "LineMember" RENAME TO "lineMember";
ALTER TABLE IF EXISTS "LineConversation" RENAME TO "lineConversation";
ALTER TABLE IF EXISTS "LineChatHistory" RENAME TO "lineChatHistory";
ALTER TABLE IF EXISTS "ProcessedLineWebhookEvent" RENAME TO "processedLineWebhookEvent";
ALTER TABLE IF EXISTS "AdminMember" RENAME TO "adminMember";
ALTER TABLE IF EXISTS "admin_ai_provider_settings" RENAME TO "adminAiProviderSettings";
ALTER TABLE IF EXISTS "AnswerPatternVector" RENAME TO "answerPatternVector";

ALTER TABLE IF EXISTS "credit_wallets" RENAME TO "creditWallets";
ALTER TABLE IF EXISTS "ai_model_pricing" RENAME TO "aiModelPricing";
ALTER TABLE IF EXISTS "ai_usage_events" RENAME TO "aiUsageEvents";
ALTER TABLE IF EXISTS "credit_budgets" RENAME TO "creditBudgets";
ALTER TABLE IF EXISTS "credit_ledger" RENAME TO "creditLedger";
ALTER TABLE IF EXISTS "credit_topups" RENAME TO "creditTopups";
ALTER TABLE IF EXISTS "credit_exchange_rates" RENAME TO "creditExchangeRates";
ALTER TABLE IF EXISTS "sys_categories" RENAME TO "sysCategories";
ALTER TABLE IF EXISTS "admin_chat_rooms" RENAME TO "adminChatRooms";
ALTER TABLE IF EXISTS "admin_chat_messages" RENAME TO "adminChatMessages";
-- These two predate the migration history and may not exist on every
-- installation. Rename them when present, without blocking deployment.
ALTER TABLE IF EXISTS "line_follower_snapshots" RENAME TO "lineFollowerSnapshots";
ALTER TABLE IF EXISTS "admin_notifications" RENAME TO "adminNotifications";
ALTER TABLE IF EXISTS "ai_provider_settings" RENAME TO "aiProviderSettings";

ALTER TABLE IF EXISTS "LineDelivery" RENAME TO "lineDelivery";
ALTER TABLE IF EXISTS "CreditReservation" RENAME TO "creditReservation";
ALTER TABLE IF EXISTS "AdminBootstrap" RENAME TO "adminBootstrap";

-- This table exists only when an installation had the pre-company wallet.
DO $$
BEGIN
  IF to_regclass('public.legacy_credit_wallets') IS NOT NULL THEN
    ALTER TABLE "legacy_credit_wallets" RENAME TO "legacyCreditWallets";
  END IF;
END $$;
