import { Prisma } from '../../../generated/prisma/client';

/**
 * Attribution carried alongside a customer-facing AI call so the resulting
 * `AiUsageEvent` can be traced back to the LINE thread that caused it.
 * `userId` is the LINE user id (rate-limit key), not a database id.
 */
export type LineAiUsageContext = Readonly<{
  userId?: string;
  lineMemberId?: string;
  conversationId?: string;
}>;

/** What one AI call costs us (`costThb`) and what the customer pays for it. */
export type AiUsageCost = Readonly<{
  costThb: Prisma.Decimal;
  chargedCredit: Prisma.Decimal;
  /** The `AiModelPricing` row used, or null when the model has no price yet. */
  pricingId: string | null;
}>;

/** Nothing to charge: a failed call, or a model with no active pricing row. */
export const ZERO_AI_USAGE_COST: AiUsageCost = {
  costThb: new Prisma.Decimal(0),
  chargedCredit: new Prisma.Decimal(0),
  pricingId: null,
};

/** Budget scope for the shared customer-facing LINE reply pool. */
export const LINE_AI_BUDGET_SCOPE_KEY = '*';
