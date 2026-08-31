-- Backfill the persisted admin AI chat structure that already exists in the
-- Prisma schema. IF NOT EXISTS keeps this safe for databases previously
-- bootstrapped with `prisma db push`.
DO $$
BEGIN
  CREATE TYPE "AdminChatRole" AS ENUM ('USER', 'ASSISTANT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "AdminMember"
ADD COLUMN IF NOT EXISTS "aiEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS "admin_chat_rooms" (
  "id" UUID NOT NULL,
  "adminMemberId" UUID NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "admin_chat_rooms_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_chat_rooms_adminMemberId_fkey"
    FOREIGN KEY ("adminMemberId") REFERENCES "AdminMember"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "admin_chat_messages" (
  "id" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "role" "AdminChatRole" NOT NULL,
  "content" TEXT NOT NULL,
  "provider" "AiProviderName",
  "model" VARCHAR(150),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "admin_chat_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_chat_messages_roomId_fkey"
    FOREIGN KEY ("roomId") REFERENCES "admin_chat_rooms"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "admin_chat_rooms_adminMemberId_lastMessageAt_idx"
ON "admin_chat_rooms"("adminMemberId", "lastMessageAt");

CREATE INDEX IF NOT EXISTS "admin_chat_messages_roomId_createdAt_idx"
ON "admin_chat_messages"("roomId", "createdAt");
