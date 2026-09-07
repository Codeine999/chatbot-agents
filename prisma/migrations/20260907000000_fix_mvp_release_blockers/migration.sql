-- Complete tables that existed in Prisma/application code but were missing
-- from the migration history, and make settled AI operations replayable.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- The original ai_settings migration used BIGSERIAL while Prisma has always
-- exposed this identifier as a UUID. There are no foreign keys to this
-- singleton/settings table, so each legacy row can safely receive a UUID.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'aiSettings'
      AND column_name = 'id'
      AND data_type = 'bigint'
  ) THEN
    ALTER TABLE "aiSettings" ALTER COLUMN "id" DROP DEFAULT;
    ALTER TABLE "aiSettings"
      ALTER COLUMN "id" TYPE UUID USING gen_random_uuid();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "lineFollowerSnapshots" (
  "id" UUID NOT NULL,
  "date" DATE NOT NULL,
  "followerCount" INTEGER NOT NULL,
  "targetedReaches" INTEGER,
  "blockCount" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lineFollowerSnapshots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "lineFollowerSnapshots_date_key"
  ON "lineFollowerSnapshots"("date");

CREATE TABLE IF NOT EXISTS "adminNotifications" (
  "id" UUID NOT NULL,
  "userId" VARCHAR(255),
  "metadata" JSONB,
  "type" VARCHAR(50) NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "message" TEXT,
  "isRead" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "adminNotifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "adminNotifications_isRead_idx"
  ON "adminNotifications"("isRead");
CREATE INDEX IF NOT EXISTS "adminNotifications_createdAt_idx"
  ON "adminNotifications"("createdAt");

ALTER TABLE "creditReservation"
  ADD COLUMN IF NOT EXISTS "result" JSONB;

CREATE TABLE IF NOT EXISTS "adminChatRequests" (
  "id" UUID NOT NULL,
  "clientRequestId" UUID NOT NULL,
  "adminMemberId" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "userMessageId" UUID NOT NULL,
  "assistantMessageId" UUID,
  "text" TEXT NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "adminChatRequests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "adminChatRequests_clientRequestId_key"
  ON "adminChatRequests"("clientRequestId");
CREATE UNIQUE INDEX IF NOT EXISTS "adminChatRequests_userMessageId_key"
  ON "adminChatRequests"("userMessageId");
CREATE UNIQUE INDEX IF NOT EXISTS "adminChatRequests_assistantMessageId_key"
  ON "adminChatRequests"("assistantMessageId");
CREATE INDEX IF NOT EXISTS "adminChatRequests_adminMemberId_createdAt_idx"
  ON "adminChatRequests"("adminMemberId", "createdAt");
CREATE INDEX IF NOT EXISTS "adminChatRequests_roomId_createdAt_idx"
  ON "adminChatRequests"("roomId", "createdAt");
ALTER TABLE "adminChatRequests"
  ADD CONSTRAINT "adminChatRequests_adminMemberId_fkey"
  FOREIGN KEY ("adminMemberId") REFERENCES "adminMember"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "adminChatRequests"
  ADD CONSTRAINT "adminChatRequests_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "adminChatRooms"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "adminChatRequests"
  ADD CONSTRAINT "adminChatRequests_userMessageId_fkey"
  FOREIGN KEY ("userMessageId") REFERENCES "adminChatMessages"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "adminChatRequests"
  ADD CONSTRAINT "adminChatRequests_assistantMessageId_fkey"
  FOREIGN KEY ("assistantMessageId") REFERENCES "adminChatMessages"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
