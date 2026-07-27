CREATE TYPE "AiProviderScope" AS ENUM ('USER', 'ADMIN');

CREATE TYPE "AiProviderName" AS ENUM ('GEMINI', 'OPENAI', 'ANTHROPIC');

CREATE TABLE "ai_provider_settings" (
    "id" UUID NOT NULL,
    "scope" "AiProviderScope" NOT NULL,
    "provider" "AiProviderName" NOT NULL,
    "model" VARCHAR(150) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_provider_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_provider_settings_scope_key"
ON "ai_provider_settings"("scope");
