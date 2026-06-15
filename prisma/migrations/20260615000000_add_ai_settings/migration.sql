-- CreateTable
CREATE TABLE "ai_settings" (
    "id" BIGSERIAL NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "tone" VARCHAR(100),
    "fallbackMessage" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_settings_pkey" PRIMARY KEY ("id")
);
