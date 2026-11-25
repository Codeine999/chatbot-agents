-- LINE OA chat history import (docs/line-chat-import-plan.md).
-- Additive only: new enums/tables, nullable or defaulted columns. Existing rows
-- become source='live' / 'webhook' through the column defaults (no backfill).
-- Rollback: drop the two tables, the new columns and the three enums.

-- CreateEnum
CREATE TYPE "LineChatImportStatus" AS ENUM ('UPLOADED', 'SYNCING_FOLLOWERS', 'PARSING', 'MATCHING', 'MATERIALIZING', 'COMPLETED', 'FAILED', 'CANCELLED', 'DELETING', 'EXPIRED');

-- CreateEnum
CREATE TYPE "LineChatImportThreadStatus" AS ENUM ('PENDING', 'MATCHED_PENDING_WRITE', 'MATERIALIZED', 'UNMATCHED', 'AMBIGUOUS', 'SKIPPED');

-- CreateEnum
CREATE TYPE "LineChatHistorySource" AS ENUM ('live', 'import');

-- AlterTable
ALTER TABLE "lineMember" ADD COLUMN     "source" VARCHAR(20) NOT NULL DEFAULT 'webhook';

-- AlterTable
ALTER TABLE "lineConversation" ADD COLUMN     "importedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "lineChatHistory" ADD COLUMN     "importBatchId" UUID,
ADD COLUMN     "importKey" VARCHAR(32),
ADD COLUMN     "importThreadId" UUID,
ADD COLUMN     "source" "LineChatHistorySource" NOT NULL DEFAULT 'live';

-- CreateTable
CREATE TABLE "lineChatImportBatch" (
    "id" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "uploadKey" VARCHAR(200) NOT NULL,
    "multipartUploadId" VARCHAR(1024),
    "fileName" VARCHAR(255) NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "status" "LineChatImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "options" JSONB,
    "cursor" JSONB,
    "totalEntries" INTEGER NOT NULL DEFAULT 0,
    "parsedEntries" INTEGER NOT NULL DEFAULT 0,
    "totalMessages" INTEGER NOT NULL DEFAULT 0,
    "skippedByDate" INTEGER NOT NULL DEFAULT 0,
    "skippedOverlap" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "syncedFollowers" INTEGER NOT NULL DEFAULT 0,
    "linkedThreads" INTEGER NOT NULL DEFAULT 0,
    "unmatchedThreads" INTEGER NOT NULL DEFAULT 0,
    "ambiguousThreads" INTEGER NOT NULL DEFAULT 0,
    "errorSamples" JSONB,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lineChatImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lineChatImportThread" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "entryIndex" INTEGER NOT NULL,
    "entryName" VARCHAR(512) NOT NULL,
    "rawName" VARCHAR(255) NOT NULL,
    "normalizedName" VARCHAR(255) NOT NULL,
    "status" "LineChatImportThreadStatus" NOT NULL DEFAULT 'PENDING',
    "lineMemberId" UUID,
    "conversationId" UUID,
    "createdConversation" BOOLEAN NOT NULL DEFAULT false,
    "matchMethod" VARCHAR(32),
    "linkedById" UUID,
    "linkedAt" TIMESTAMP(3),
    "messageCount" INTEGER NOT NULL,
    "firstAt" TIMESTAMP(3) NOT NULL,
    "lastAt" TIMESTAMP(3) NOT NULL,
    "lastText" VARCHAR(200),
    "messages" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lineChatImportThread_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lineChatImportBatch_status_idx" ON "lineChatImportBatch"("status");

-- CreateIndex
CREATE INDEX "lineChatImportBatch_expiresAt_idx" ON "lineChatImportBatch"("expiresAt");

-- CreateIndex
CREATE INDEX "lineChatImportThread_normalizedName_status_idx" ON "lineChatImportThread"("normalizedName", "status");

-- CreateIndex
CREATE INDEX "lineChatImportThread_batchId_status_idx" ON "lineChatImportThread"("batchId", "status");

-- CreateIndex
CREATE INDEX "lineChatImportThread_lineMemberId_idx" ON "lineChatImportThread"("lineMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "lineChatImportThread_batchId_entryIndex_key" ON "lineChatImportThread"("batchId", "entryIndex");

-- CreateIndex
CREATE INDEX "lineChatHistory_lineMemberId_sender_idx" ON "lineChatHistory"("lineMemberId", "sender");

-- CreateIndex
CREATE INDEX "lineChatHistory_importThreadId_idx" ON "lineChatHistory"("importThreadId");

-- AddForeignKey
ALTER TABLE "lineChatImportThread" ADD CONSTRAINT "lineChatImportThread_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "lineChatImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- importKey is unique only where it is set, so the millions of LIVE rows
-- (importKey NULL) stay out of the index. createMany(skipDuplicates) uses
-- ON CONFLICT DO NOTHING, which a partial unique index satisfies.
CREATE UNIQUE INDEX "lineChatHistory_importKey_key"
  ON "lineChatHistory" ("importKey") WHERE "importKey" IS NOT NULL;
