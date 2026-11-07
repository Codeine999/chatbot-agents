BEGIN;
-- Additive only: per-turn decision log for explaining and tuning chatbot answers. No backfill.
-- Rollback: DROP TABLE "decisionLogs"; DROP TYPE "MessageChannel";
-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('LINE', 'FACEBOOK', 'INSTAGRAM', 'APPLICATION', 'TIKTOK', 'SHOPEE', 'TELEGRAM', 'ANOTHER');

-- CreateTable
CREATE TABLE "decisionLogs" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "eventId" VARCHAR(255) NOT NULL,
    "userId" VARCHAR(100) NOT NULL,
    "conversationId" UUID,
    "commerceTurnId" UUID,
    "messageType" VARCHAR(20) NOT NULL,
    "inputText" TEXT,
    "retrievalQuery" TEXT,
    "action" VARCHAR(40),
    "intent" VARCHAR(40),
    "routeSource" VARCHAR(20),
    "routeConfidence" DOUBLE PRECISION,
    "routeReason" VARCHAR(500),
    "answerType" VARCHAR(30) NOT NULL,
    "answerMode" VARCHAR(40),
    "retrievalRoute" VARCHAR(20),
    "matchType" VARCHAR(20),
    "retrievalFallbackReason" VARCHAR(50),
    "topScore" DOUBLE PRECISION,
    "topVectorSimilarity" DOUBLE PRECISION,
    "topLexicalScore" DOUBLE PRECISION,
    "scoreGap" DOUBLE PRECISION,
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "candidates" JSONB,
    "isFallback" BOOLEAN NOT NULL DEFAULT false,
    "fallbackReason" VARCHAR(60),
    "handoffRequested" BOOLEAN NOT NULL DEFAULT false,
    "responseSource" VARCHAR(20),
    "contextPolicy" VARCHAR(10),
    "responseText" TEXT,
    "llmCallCount" INTEGER NOT NULL DEFAULT 0,
    "llmInputTokens" INTEGER NOT NULL DEFAULT 0,
    "llmOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "status" VARCHAR(20) NOT NULL DEFAULT 'COMPLETED',
    "errorCode" VARCHAR(100),
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "trace" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "decisionLogs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "decisionLogs_companyId_createdAt_idx" ON "decisionLogs"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "decisionLogs_conversationId_createdAt_idx" ON "decisionLogs"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "decisionLogs_companyId_userId_createdAt_idx" ON "decisionLogs"("companyId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "decisionLogs_companyId_answerType_createdAt_idx" ON "decisionLogs"("companyId", "answerType", "createdAt");

-- CreateIndex
CREATE INDEX "decisionLogs_companyId_isFallback_createdAt_idx" ON "decisionLogs"("companyId", "isFallback", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "decisionLogs_companyId_eventId_key" ON "decisionLogs"("companyId", "eventId");

-- AddForeignKey
ALTER TABLE "decisionLogs" ADD CONSTRAINT "decisionLogs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
