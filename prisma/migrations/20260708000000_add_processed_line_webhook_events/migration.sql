-- CreateTable
CREATE TABLE "ProcessedLineWebhookEvent" (
    "id" UUID NOT NULL,
    "webhookEventId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedLineWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedLineWebhookEvent_webhookEventId_key" ON "ProcessedLineWebhookEvent"("webhookEventId");

-- CreateIndex
CREATE INDEX "ProcessedLineWebhookEvent_processedAt_idx" ON "ProcessedLineWebhookEvent"("processedAt");
