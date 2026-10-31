-- Additive only: self-hosted OpenAI-compatible generation provider. No backfill.
-- Rollback: unused enum values cannot be dropped in Postgres; leave it in place.
ALTER TYPE "AiProviderName" ADD VALUE IF NOT EXISTS 'LOCAL';
