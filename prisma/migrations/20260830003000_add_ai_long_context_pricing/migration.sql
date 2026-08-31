ALTER TABLE "ai_model_pricing"
ADD COLUMN "longContextThresholdTokens" INTEGER,
ADD COLUMN "longContextInputRateMultiplier" DECIMAL(10, 6),
ADD COLUMN "longContextOutputRateMultiplier" DECIMAL(10, 6),
ADD COLUMN "longContextCachedInputRateMultiplier" DECIMAL(10, 6),
ADD COLUMN "longContextCacheWriteRateMultiplier" DECIMAL(10, 6);

ALTER TABLE "ai_model_pricing"
ADD CONSTRAINT "ai_model_pricing_long_context_threshold_check"
CHECK (
  "longContextThresholdTokens" IS NULL
  OR "longContextThresholdTokens" > 0
),
ADD CONSTRAINT "ai_model_pricing_long_context_input_multiplier_check"
CHECK (
  "longContextInputRateMultiplier" IS NULL
  OR "longContextInputRateMultiplier" > 0
),
ADD CONSTRAINT "ai_model_pricing_long_context_output_multiplier_check"
CHECK (
  "longContextOutputRateMultiplier" IS NULL
  OR "longContextOutputRateMultiplier" > 0
),
ADD CONSTRAINT "ai_model_pricing_long_context_cached_input_multiplier_check"
CHECK (
  "longContextCachedInputRateMultiplier" IS NULL
  OR "longContextCachedInputRateMultiplier" > 0
),
ADD CONSTRAINT "ai_model_pricing_long_context_cache_write_multiplier_check"
CHECK (
  "longContextCacheWriteRateMultiplier" IS NULL
  OR "longContextCacheWriteRateMultiplier" > 0
),
ADD CONSTRAINT "ai_model_pricing_long_context_configuration_check"
CHECK (
  "longContextThresholdTokens" IS NOT NULL
  OR (
    "longContextInputRateMultiplier" IS NULL
    AND "longContextOutputRateMultiplier" IS NULL
    AND "longContextCachedInputRateMultiplier" IS NULL
    AND "longContextCacheWriteRateMultiplier" IS NULL
  )
);
