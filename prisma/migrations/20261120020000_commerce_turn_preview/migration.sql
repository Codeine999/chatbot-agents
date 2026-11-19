-- Product RAG for the back-office preview (docs/product-all-channels.md). A
-- preview session has no durable conversation, so its turns carry the session
-- key "<adminMemberId>:<sessionId>" instead; they are purged by age.

-- AlterTable
ALTER TABLE "commerceTurns" ADD COLUMN "previewSessionKey" VARCHAR(80);

-- CreateIndex
CREATE INDEX "commerceTurns_previewSessionKey_createdAt_idx" ON "commerceTurns"("previewSessionKey", "createdAt");

-- Exactly one owner kind: LINE thread, channel room or preview session.
ALTER TABLE "commerceTurns" DROP CONSTRAINT "commerceTurns_owner_check";
ALTER TABLE "commerceTurns" ADD CONSTRAINT "commerceTurns_owner_check" CHECK (
  ("lineMemberId" IS NOT NULL AND "conversationId" IS NOT NULL AND "channelConversationId" IS NULL AND "previewSessionKey" IS NULL)
  OR ("lineMemberId" IS NULL AND "conversationId" IS NULL AND "channelConversationId" IS NOT NULL AND "previewSessionKey" IS NULL)
  OR ("lineMemberId" IS NULL AND "conversationId" IS NULL AND "channelConversationId" IS NULL AND "previewSessionKey" IS NOT NULL)
);
