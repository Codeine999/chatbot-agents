CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "AnswerPatternVector" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "answerPatternId" UUID NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "embeddingModel" VARCHAR(100),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnswerPatternVector_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AnswerPatternVector_answerPatternId_key"
ON "AnswerPatternVector"("answerPatternId");

CREATE INDEX "AnswerPatternVector_answerPatternId_idx"
ON "AnswerPatternVector"("answerPatternId");

CREATE INDEX "AnswerPatternVector_active_idx"
ON "AnswerPatternVector"("active");

CREATE INDEX "AnswerPatternVector_embedding_cosine_idx"
ON "AnswerPatternVector"
USING hnsw ("embedding" vector_cosine_ops);

ALTER TABLE "AnswerPatternVector"
ADD CONSTRAINT "AnswerPatternVector_answerPatternId_fkey"
FOREIGN KEY ("answerPatternId") REFERENCES "AnswerPattern"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
