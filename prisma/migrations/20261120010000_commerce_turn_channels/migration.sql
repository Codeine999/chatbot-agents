-- Product RAG for every channel (docs/product-all-channels.md). A commerce turn
-- used to belong to a LINE member and a LINE conversation only; a channel*
-- room (App, Facebook) now owns turns through channelConversationId.
-- Existing rows are all LINE turns and keep satisfying the CHECK below.

-- AlterTable
ALTER TABLE "commerceTurns" ADD COLUMN "channelConversationId" UUID,
ALTER COLUMN "lineMemberId" DROP NOT NULL,
ALTER COLUMN "conversationId" DROP NOT NULL;

-- AddForeignKey
-- RESTRICT like the LINE side: the retention purge removes a room's turns
-- (and their calls) before the room, never the other way around.
ALTER TABLE "commerceTurns" ADD CONSTRAINT "commerceTurns_channelConversationId_fkey" FOREIGN KEY ("channelConversationId") REFERENCES "channelConversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "commerceTurns_channelConversationId_createdAt_idx" ON "commerceTurns"("channelConversationId", "createdAt");

-- Hand-added constraint (not expressible in Prisma): exactly one owner kind.
ALTER TABLE "commerceTurns" ADD CONSTRAINT "commerceTurns_owner_check" CHECK (
  ("lineMemberId" IS NOT NULL AND "conversationId" IS NOT NULL AND "channelConversationId" IS NULL)
  OR ("lineMemberId" IS NULL AND "conversationId" IS NULL AND "channelConversationId" IS NOT NULL)
);
