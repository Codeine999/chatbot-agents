CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateTable
CREATE TABLE "answer_patterns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "category" VARCHAR(100),
    "intentKey" VARCHAR(100),
    "keywords" TEXT[] DEFAULT '{}',
    "questionExamples" TEXT[] DEFAULT '{}',
    "answer" TEXT NOT NULL,
    "priority" INTEGER DEFAULT 0,
    "active" BOOLEAN DEFAULT true,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "answer_patterns_pkey" PRIMARY KEY ("id")
);
