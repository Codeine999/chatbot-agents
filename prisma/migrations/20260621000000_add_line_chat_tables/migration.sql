-- CreateEnum
CREATE TYPE "LineChatSender" AS ENUM ('user', 'admin', 'ai', 'system');

-- CreateEnum
CREATE TYPE "LineChatMessageType" AS ENUM ('text', 'image', 'sticker', 'postback');

-- CreateTable
CREATE TABLE "LineMember" (
    "id" UUID NOT NULL,
    "lineUserId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "pictureUrl" TEXT,
    "statusMessage" TEXT,
    "followStatus" TEXT DEFAULT 'followed',
    "lastActiveAt" TIMESTAMP(3),
    "profileSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LineMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineConversation" (
    "id" UUID NOT NULL,
    "lineMemberId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "lastMessage" TEXT NOT NULL,
    "lastMessageType" "LineChatMessageType" NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LineConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineChatHistory" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "lineMemberId" UUID NOT NULL,
    "sender" "LineChatSender" NOT NULL,
    "messageType" "LineChatMessageType" NOT NULL,
    "text" TEXT,
    "lineMessageId" TEXT,
    "replyToken" TEXT,
    "stickerPackageId" TEXT,
    "stickerId" TEXT,
    "stickerResourceType" TEXT,
    "mediaUrl" TEXT,
    "postbackData" TEXT,
    "rawEvent" JSONB,
    "sentStatus" TEXT NOT NULL DEFAULT 'received',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LineChatHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LineMember_lineUserId_key" ON "LineMember"("lineUserId");

-- CreateIndex
CREATE INDEX "LineMember_lastActiveAt_idx" ON "LineMember"("lastActiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "LineConversation_lineMemberId_key" ON "LineConversation"("lineMemberId");

-- CreateIndex
CREATE INDEX "LineConversation_lastMessageAt_idx" ON "LineConversation"("lastMessageAt");

-- CreateIndex
CREATE INDEX "LineConversation_status_idx" ON "LineConversation"("status");

-- CreateIndex
CREATE INDEX "LineChatHistory_conversationId_createdAt_idx" ON "LineChatHistory"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "LineChatHistory_lineMemberId_idx" ON "LineChatHistory"("lineMemberId");

-- CreateIndex
CREATE INDEX "LineChatHistory_lineMessageId_idx" ON "LineChatHistory"("lineMessageId");

-- AddForeignKey
ALTER TABLE "LineConversation" ADD CONSTRAINT "LineConversation_lineMemberId_fkey" FOREIGN KEY ("lineMemberId") REFERENCES "LineMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineChatHistory" ADD CONSTRAINT "LineChatHistory_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "LineConversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineChatHistory" ADD CONSTRAINT "LineChatHistory_lineMemberId_fkey" FOREIGN KEY ("lineMemberId") REFERENCES "LineMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
