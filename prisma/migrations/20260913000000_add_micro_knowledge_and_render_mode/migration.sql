CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "AnswerPatternRenderMode" AS ENUM ('direct', 'rewrite');

-- AlterTable
-- Existing rows keep today's behaviour: the stored answer is sent verbatim.
ALTER TABLE "answerPattern"
ADD COLUMN "renderMode" "AnswerPatternRenderMode" NOT NULL DEFAULT 'direct';

-- CreateTable
CREATE TABLE "microKnowledge" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "category" VARCHAR(100),
    "intentKey" VARCHAR(100),
    "entityKey" VARCHAR(50),
    "topicKey" VARCHAR(50),
    "keywords" TEXT[] NOT NULL DEFAULT '{}',
    "questionExamples" TEXT[] NOT NULL DEFAULT '{}',
    "answer" TEXT NOT NULL,
    "language" VARCHAR(10) NOT NULL DEFAULT 'th',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "microKnowledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "microKnowledgeVector" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "microKnowledgeId" UUID NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "embeddingModel" VARCHAR(100),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "microKnowledgeVector_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "microKnowledgeVector_microKnowledgeId_key"
ON "microKnowledgeVector"("microKnowledgeId");

-- CreateIndex
CREATE INDEX "microKnowledgeVector_microKnowledgeId_idx"
ON "microKnowledgeVector"("microKnowledgeId");

-- CreateIndex
CREATE INDEX "microKnowledgeVector_active_idx"
ON "microKnowledgeVector"("active");

-- CreateIndex
-- Same operator class as answerPatternVector so both sources can be searched
-- with one query embedding.
CREATE INDEX "microKnowledgeVector_embedding_cosine_idx"
ON "microKnowledgeVector"
USING hnsw ("embedding" vector_cosine_ops);

-- AddForeignKey
ALTER TABLE "microKnowledgeVector"
ADD CONSTRAINT "microKnowledgeVector_microKnowledgeId_fkey"
FOREIGN KEY ("microKnowledgeId") REFERENCES "microKnowledge"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
