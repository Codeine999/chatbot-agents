import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AI_PROVIDER_NAMES } from '../../../../ai-provider/types/ai-provider.types';

/**
 * Rates are per one million tokens, matching how every provider publishes
 * them, and are parsed as strings so a price never round-trips through a
 * JavaScript float on its way to a `Decimal(20,6)` column.
 */
const rate = z
  .union([z.string().trim(), z.number()])
  .transform((value) => String(value))
  .refine((value) => /^\d+(\.\d{1,6})?$/.test(value), {
    message: 'Rate must be a non-negative number with at most 6 decimals',
  });

const optionalRate = rate.nullable().optional();

const upsertPricingSchema = z.object({
  provider: z.enum(AI_PROVIDER_NAMES),
  model: z.string().trim().min(1).max(150),

  /** What the provider charges us, in THB. */
  inputCostThbPerMillTokens: rate,
  outputCostThbPerMillTokens: rate,
  cachedInputCostThbPerMillTokens: optionalRate,
  cacheWriteCostThbPerMillTokens: optionalRate,

  /** What the customer's wallet is charged. */
  inputCreditPerMillTokens: rate,
  outputCreditPerMillTokens: rate,
  cachedInputCreditPerMillTokens: optionalRate,
  cacheWriteCreditPerMillTokens: optionalRate,

  /**
   * ISO-8601 instant this price starts at; defaults to now, so a new price
   * takes effect immediately. Kept as a string rather than `z.coerce.date()`
   * because a `Date` (and any transform producing one) cannot be expressed in
   * the OpenAPI schema this DTO is published into.
   */
  effectiveFrom: z.iso.datetime({ offset: true }).optional(),
});

export class UpsertAiModelPricingDto extends createZodDto(
  upsertPricingSchema,
) {}

export class AiModelPricingIdParamDto extends createZodDto(
  z.object({ id: z.string().uuid() }),
) {}

export class ListAiModelPricingQueryDto extends createZodDto(
  z.object({
    provider: z.enum(AI_PROVIDER_NAMES).optional(),
    model: z.string().trim().min(1).max(150).optional(),
    /**
     * Include prices that have already been superseded. Parsed explicitly:
     * `z.coerce.boolean()` runs JS `Boolean()`, which turns the string
     * `"false"` into `true`.
     */
    includeExpired: z
      .enum(['true', 'false', '1', '0'])
      .default('false')
      .transform((value) => value === 'true' || value === '1'),
  }),
) {}
