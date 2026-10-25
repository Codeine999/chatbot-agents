BEGIN;
-- Additive only: new tables for the App Message API (guest chat over REST). No backfill.
-- Rollback: DROP the 4 tables (appGuestSessions, channelMessages, channelConversations,
-- channelContacts) and the types ChannelMessageSender, ChatChannel.
-- CreateEnum
CREATE TYPE "ChatChannel" AS ENUM ('APP');

-- CreateEnum
CREATE TYPE "ChannelMessageSender" AS ENUM ('user', 'admin', 'ai', 'system');

-- CreateTable
CREATE TABLE "channelContacts" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "channel" "ChatChannel" NOT NULL,
    "displayName" VARCHAR(100),
    "metadata" JSONB,
    "customerId" UUID,
    "lastActiveAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channelContacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appGuestSessions" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "ipHash" VARCHAR(32) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appGuestSessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channelConversations" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "channel" "ChatChannel" NOT NULL,
    "contactId" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "lastMessage" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "activeTurnId" UUID,
    "activeUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channelConversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channelMessages" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "sender" "ChannelMessageSender" NOT NULL,
    "messageType" VARCHAR(20) NOT NULL DEFAULT 'TEXT',
    "text" TEXT,
    "clientMessageId" VARCHAR(64),
    "replyToId" UUID,
    "status" VARCHAR(20) NOT NULL,
    "source" VARCHAR(20),
    "sentByAdminId" UUID,
    "turnContext" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channelMessages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channelContacts_customerId_idx" ON "channelContacts"("customerId");

-- CreateIndex
CREATE INDEX "channelContacts_createdAt_idx" ON "channelContacts"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "appGuestSessions_tokenHash_key" ON "appGuestSessions"("tokenHash");

-- CreateIndex
CREATE INDEX "appGuestSessions_contactId_idx" ON "appGuestSessions"("contactId");

-- CreateIndex
CREATE INDEX "appGuestSessions_expiresAt_idx" ON "appGuestSessions"("expiresAt");

-- CreateIndex
CREATE INDEX "appGuestSessions_ipHash_expiresAt_idx" ON "appGuestSessions"("ipHash", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "channelConversations_contactId_key" ON "channelConversations"("contactId");

-- CreateIndex
CREATE INDEX "channelConversations_companyId_channel_lastMessageAt_idx" ON "channelConversations"("companyId", "channel", "lastMessageAt");

-- CreateIndex
CREATE INDEX "channelConversations_channel_lastMessageAt_idx" ON "channelConversations"("channel", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "channelMessages_replyToId_key" ON "channelMessages"("replyToId");

-- CreateIndex
CREATE INDEX "channelMessages_conversationId_createdAt_id_idx" ON "channelMessages"("conversationId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "channelMessages_createdAt_idx" ON "channelMessages"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "channelMessages_conversationId_clientMessageId_key" ON "channelMessages"("conversationId", "clientMessageId");

-- AddForeignKey
ALTER TABLE "channelContacts" ADD CONSTRAINT "channelContacts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channelContacts" ADD CONSTRAINT "channelContacts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appGuestSessions" ADD CONSTRAINT "appGuestSessions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appGuestSessions" ADD CONSTRAINT "appGuestSessions_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "channelContacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channelConversations" ADD CONSTRAINT "channelConversations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channelConversations" ADD CONSTRAINT "channelConversations_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "channelContacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channelMessages" ADD CONSTRAINT "channelMessages_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channelMessages" ADD CONSTRAINT "channelMessages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "channelConversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channelMessages" ADD CONSTRAINT "channelMessages_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "channelContacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channelMessages" ADD CONSTRAINT "channelMessages_sentByAdminId_fkey" FOREIGN KEY ("sentByAdminId") REFERENCES "adminMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;


COMMIT;
