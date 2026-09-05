import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EMBEDDING_ADAPTER } from '../../../infra/embedding/embedding-adapter.interface';
import type {
  EmbeddingAdapter,
  EmbeddingResult,
} from '../../../infra/embedding/embedding-adapter.interface';
import { estimateEmbeddingTokenUsage } from '../../../ai-provider/utils/token-usage.utils';
import { AiBillingService } from '../../usage/billing/ai-billing.service';
import {
  EMBEDDING_DOCUMENT_SCOPE_KEY,
  EMBEDDING_QUERY_SCOPE_KEY,
} from '../../usage/billing/ai-usage.types';
import { AiBudgetService } from '../../usage/rate-limit/ai-budget.service';
import type { LineAiUsageContext } from '../../usage/billing/ai-usage.types';

/**
 * Who an embedding is spent on behalf of.
 *
 * `userId` only feeds the Redis rate limit. The other three are written onto
 * the `AiUsageEvent`, so a debit in the ledger can be traced back to the LINE
 * thread or the admin action that caused it — a call with none of them still
 * bills, it just cannot be explained afterwards.
 */
export type EmbeddingUsageContext = LineAiUsageContext &
  Readonly<{ adminMemberId?: string }>;

@Injectable()
export class EmbeddingService {
  constructor(
    @Inject(EMBEDDING_ADAPTER)
    private readonly adapter: EmbeddingAdapter,
    private readonly aiBudgetService: AiBudgetService,
    private readonly billingService: AiBillingService,
  ) {}

  embedQuery(
    text: string,
    context: EmbeddingUsageContext = {},
  ): Promise<EmbeddingResult> {
    return this.embed(
      text,
      'RETRIEVAL_QUERY',
      EMBEDDING_QUERY_SCOPE_KEY,
      context,
    );
  }

  /** Embeds an `AnswerPattern` for indexing. Billed to the `document` scope. */
  embedDocument(
    text: string,
    context: EmbeddingUsageContext = {},
  ): Promise<EmbeddingResult> {
    return this.embed(
      text,
      'RETRIEVAL_DOCUMENT',
      EMBEDDING_DOCUMENT_SCOPE_KEY,
      context,
    );
  }

  private async embed(
    text: string,
    task: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT',
    scopeKey: string,
    context: EmbeddingUsageContext,
  ): Promise<EmbeddingResult> {
    const normalized = text.trim();

    if (!normalized) {
      throw new ServiceUnavailableException('Cannot embed empty text');
    }

    if (!(await this.aiBudgetService.tryConsume(context.userId))) {
      throw new ServiceUnavailableException('AI embedding budget exceeded');
    }

    return this.billingService.runBilledEmbedding({
      scopeKey,
      provider: this.adapter.provider,
      model: this.adapter.model,
      estimatedUsage: estimateEmbeddingTokenUsage(normalized),
      idempotencyKey: this.idempotencyKey(context.turnId, task, normalized),
      adminMemberId: context.adminMemberId,
      lineMemberId: context.lineMemberId,
      conversationId: context.conversationId,
      call: () => this.adapter.embed({ text: normalized, task }),
    });
  }

  /**
   * Mirrors `AiBillingService`'s generation key: one turn re-processed after a
   * failure settles once, while the distinct queries a single turn embeds (the
   * original question, then a planner rewrite) each keep their own entry.
   * Hashed here rather than in billing because the text is what identifies the
   * unit of work, and billing never sees it.
   */
  private idempotencyKey(
    turnId: string | undefined,
    task: string,
    text: string,
  ): string | undefined {
    if (!turnId) return undefined;

    const fingerprint = createHash('sha256')
      .update(JSON.stringify([task, this.adapter.model, text]))
      .digest('hex')
      .slice(0, 32);

    return `usage:embed:${turnId}:${fingerprint}`;
  }
}
