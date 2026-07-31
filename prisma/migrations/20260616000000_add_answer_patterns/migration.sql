CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateTable
CREATE TABLE "AnswerPattern" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "category" VARCHAR(100),
    "intentKey" VARCHAR(100),
    "keywords" TEXT[] NOT NULL DEFAULT '{}',
    "questionExamples" TEXT[] NOT NULL DEFAULT '{}',
    "answer" TEXT NOT NULL,
    "language" VARCHAR(10) NOT NULL DEFAULT 'th',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnswerPattern_pkey" PRIMARY KEY ("id")
);
