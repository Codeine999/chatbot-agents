import { Prisma } from '../../../generated/prisma/client';

export type LineAiUsageContext = Readonly<{
  userId?: string;
  lineMemberId?: string;
  conversationId?: string;
  turnId?: string;
}>;

/** What one AI call costs us (`costThb`) and what the customer pays for it. */
export type AiUsageCost = Readonly<{
  costThb: Prisma.Decimal;
  chargedCredit: Prisma.Decimal;
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

/**
 * Embeddings are budgeted per direction so the two paths cannot starve each
 * other: a bulk knowledge-base reindex draws on `document`, while every
 * customer question embedded before the pgvector search draws on `query`.
 */
export const EMBEDDING_DOCUMENT_SCOPE_KEY = 'document';
export const EMBEDDING_QUERY_SCOPE_KEY = 'query';
