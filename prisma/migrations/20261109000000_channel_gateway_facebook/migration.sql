-- Channel gateway: Facebook Messenger on the shared channel* tables. Additive only:
-- new enum value, nullable columns, a defaulted counter and two unique indexes
-- (Postgres treats NULLs as distinct, so existing APP rows never collide).

-- AlterEnum
ALTER TYPE "ChatChannel" ADD VALUE 'FACEBOOK';

-- AlterTable
ALTER TABLE "channelContacts" ADD COLUMN     "externalUserId" VARCHAR(255);

-- AlterTable
ALTER TABLE "channelMessages" ADD COLUMN     "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deliveryLeaseUntil" TIMESTAMP(3),
ADD COLUMN     "externalMessageId" VARCHAR(255),
ADD COLUMN     "lastError" VARCHAR(200);

-- CreateIndex
CREATE UNIQUE INDEX "channelContacts_companyId_channel_externalUserId_key" ON "channelContacts"("companyId", "channel", "externalUserId");

-- CreateIndex
CREATE UNIQUE INDEX "channelMessages_conversationId_externalMessageId_key" ON "channelMessages"("conversationId", "externalMessageId");

