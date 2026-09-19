-- Extend the existing prompt configuration without replacing or rewriting
-- the platform-owned systemPrompt and fallbackMessage values.
ALTER TABLE "aiSettings"
  ADD COLUMN "tenantId" UUID,
  ADD COLUMN "ownerPrompt" TEXT,
  ADD COLUMN "skills" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "responseStyle" JSONB NOT NULL DEFAULT '{"targetLength":"adaptive","emojiLevel":"light"}'::jsonb,
  ADD COLUMN "promptVersion" INTEGER NOT NULL DEFAULT 1;

-- The original 100-character limit is too small for a useful tone profile.
ALTER TABLE "aiSettings"
  ALTER COLUMN "tone" TYPE TEXT;

CREATE INDEX "aiSettings_tenantId_active_updatedAt_idx"
  ON "aiSettings"("tenantId", "active", "updatedAt");
