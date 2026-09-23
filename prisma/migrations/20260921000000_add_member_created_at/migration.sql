-- Registered-user listing needs a stable "joined" timestamp to sort and display.
-- Additive column; existing rows fall back to the migration time.
ALTER TABLE "member"
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS "member_createdAt_idx" ON "member" ("createdAt");
