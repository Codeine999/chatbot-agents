import { createHash } from 'node:crypto';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { UsageKind } from '../../../generated/prisma/client';
import type {
  AiGenerateRequest,
  AiGenerateResponse,
  AiProviderName,
} from '../../../ai-provider/types/ai-provider.types';
import { EMPTY_AI_TOKEN_USAGE } from '../../../ai-provider/types/ai-provider.types';
import type { AiTokenUsage } from '../../../ai-provider/types/ai-provider.types';
import type { EmbeddingResult } from '../../../infra/embedding/embedding-adapter.interface';
import { CreditHold, CreditService } from '../credit-point/credit.service';
import { AiPricingQuote, AiPricingService } from './ai-pricing.service';
import {
  AiUsageCost,
  LINE_AI_BUDGET_SCOPE_KEY,
  LineAiUsageContext,
  ZERO_AI_USAGE_COST,
} from './ai-usage.types';

export type BilledGenerationParams = Readonly<{
  kind: UsageKind;
  scopeKey?: string;
  requireBudgetLimit?: boolean;
  provider: AiProviderName;
  model: string;
  request: AiGenerateRequest;
  adminMemberId?: string;
  idempotencyKey?: string;
  call: () => Promise<AiGenerateResponse>;
}> &
  Pick<LineAiUsageContext, 'lineMemberId' | 'conversationId' | 'turnId'>;

export type BilledEmbeddingParams = Readonly<{
  scopeKey: string;
  provider: AiProviderName;
  model: string;
  /** Measured from the text before the call — see `estimateEmbeddingTokenUsage`. */
  estimatedUsage: AiTokenUsage;
  /**
   * Who caused the spend. Carried for the same reason a generation carries it:
   * an unattributed debit can be seen in the wallet but never explained, so a
   * bill nobody recognises cannot be traced back to a customer thread or to
   * the admin who triggered an indexing run.
   */
  adminMemberId?: string;
  idempotencyKey?: string;
  call: () => Promise<EmbeddingResult>;
}> &
  Pick<LineAiUsageContext, 'lineMemberId' | 'conversationId'>;

type MeteredOutcome = Readonly<{
  usage: AiTokenUsage;
  provider: AiProviderName;
  model: string;
  providerRequestId?: string;
}>;

/** The wallet-facing half of a metered call, shared by both entry points. */
type MeteredCall<T> = Readonly<{
  kind: UsageKind;
  scopeKey: string;
  requireBudgetLimit: boolean;
  provider: AiProviderName;
  model: string;
  quote: AiPricingQuote;
  idempotencyKey?: string;
  adminMemberId?: string;
  lineMemberId?: string;
  conversationId?: string;
  call: () => Promise<T>;
  /** Reads billable usage off the result, rejecting anything unmetered. */
  meter: (result: T) => MeteredOutcome;
}>;

@Injectable()
export class AiBillingService {
  private readonly logger = new Logger(AiBillingService.name);

  constructor(
    private readonly creditService: CreditService,
    private readonly pricingService: AiPricingService,
  ) {}

  /** Meters one text generation as `params.kind`. */
  async runBilled(params: BilledGenerationParams): Promise<AiGenerateResponse> {
    const quote = await this.pricingService.createQuote(
      params.provider,
      params.model,
      params.request,
    );

    return this.runMetered<AiGenerateResponse>({
      kind: params.kind,
      scopeKey: params.scopeKey ?? LINE_AI_BUDGET_SCOPE_KEY,
      requireBudgetLimit: params.requireBudgetLimit ?? false,
      provider: params.provider,
      model: params.model,
      quote,
      idempotencyKey: this.idempotencyKey(params),
      adminMemberId: params.adminMemberId,
      lineMemberId: params.lineMemberId,
      conversationId: params.conversationId,
      call: params.call,
      meter: (response) => {
        this.assertMeteredResponse(params, response);

        return {
          usage: response.usage,
          provider: response.provider,
          model: response.model,
          providerRequestId: response.providerRequestId,
        };
      },
    });
  }

  async runBilledEmbedding(
    params: BilledEmbeddingParams,
  ): Promise<EmbeddingResult> {
    const quote = await this.pricingService.createEmbeddingQuote(
      params.provider,
      params.model,
      params.estimatedUsage,
    );

    return this.runMetered<EmbeddingResult>({
      kind: UsageKind.EMBEDDING,
      scopeKey: params.scopeKey,
      requireBudgetLimit: false,
      provider: params.provider,
      model: params.model,
      quote,
      idempotencyKey: params.idempotencyKey,
      adminMemberId: params.adminMemberId,
      lineMemberId: params.lineMemberId,
      conversationId: params.conversationId,
      call: params.call,
      meter: (result) => {
        // Same guard as a generation: the charge is computed from the quoted
        // model's rate, so a result from any other model must not be billed.
        this.assertQuotedModel(params, {
          provider: params.provider,
          model: result.model,
        });

        if (result.usage.inputTokens <= 0) {
          throw new ServiceUnavailableException(
            `${params.provider}/${result.model} did not return billable token usage`,
          );
        }

        return {
          usage: result.usage,
          provider: params.provider,
          model: result.model,
        };
      },
    });
  }

  private async runMetered<T>(call: MeteredCall<T>): Promise<T> {
    const reservation = await this.creditService.reserveAiCredit(
      call.kind,
      call.scopeKey,
      call.quote.reservedCredit,
      { requireBudgetLimit: call.requireBudgetLimit },
    );

    const startedAt = Date.now();
    let result: T;

    try {
      result = await call.call();
    } catch (error) {
      await this.record(reservation, call, {
        status: 'failed',
        usage: EMPTY_AI_TOKEN_USAGE,
        cost: ZERO_AI_USAGE_COST,
        latencyMs: Date.now() - startedAt,
        errorCode: this.toErrorCode(error),
      });

      throw error;
    }

    const latencyMs = Date.now() - startedAt;
    let outcome: MeteredOutcome;
    let cost: AiUsageCost;

    try {
      outcome = call.meter(result);
      cost = this.pricingService.calculateQuote(call.quote, outcome.usage);
    } catch (error) {
      await this.record(reservation, call, {
        ...this.reportedBy(result),
        status: 'failed',
        cost: ZERO_AI_USAGE_COST,
        latencyMs,
        errorCode: this.toErrorCode(error),
      });
      throw error;
    }

    await this.record(reservation, call, {
      status: 'success',
      usage: outcome.usage,
      cost,
      latencyMs,
      providerRequestId: outcome.providerRequestId,
      provider: outcome.provider,
      model: outcome.model,
    });

    return result;
  }

  private reportedBy(result: unknown): {
    usage: AiTokenUsage;
    provider?: AiProviderName;
    model?: string;
    providerRequestId?: string;
  } {
    const reported = (result ?? {}) as Partial<MeteredOutcome>;

    return {
      usage: reported.usage ?? EMPTY_AI_TOKEN_USAGE,
      provider: reported.provider,
      model: reported.model,
      providerRequestId: reported.providerRequestId,
    };
  }

  private async record<T>(
    reservation: CreditHold,
    call: MeteredCall<T>,
    outcome: {
      status: 'success' | 'failed';
      usage: AiTokenUsage;
      cost: AiUsageCost;
      latencyMs: number;
      providerRequestId?: string;
      errorCode?: string;
      provider?: AiProviderName;
      model?: string;
    },
  ): Promise<void> {
    try {
      await this.creditService.recordAiUsage({
        reservation,
        idempotencyKey: call.idempotencyKey,
        kind: call.kind,
        provider: outcome.provider ?? call.provider,
        model: outcome.model ?? call.model,
        usage: outcome.usage,
        cost: outcome.cost,
        status: outcome.status,
        scopeKey: call.scopeKey,
        adminMemberId: call.adminMemberId,
        lineMemberId: call.lineMemberId,
        conversationId: call.conversationId,
        providerRequestId: outcome.providerRequestId,
        latencyMs: outcome.latencyMs,
        errorCode: outcome.errorCode,
      });
    } catch (error) {
      this.logger.error(
        `Failed to record ${call.kind} usage for ${call.provider}/${call.model}`,
        error instanceof Error ? error.stack : String(error),
      );
      await this.releaseAfterBillingFailure(reservation);
      if (outcome.status === 'success') throw error;
    }
  }

  private async releaseAfterBillingFailure(
    reservation: CreditHold,
  ): Promise<void> {
    try {
      await this.creditService.releaseAiCredit(reservation);
    } catch (releaseError) {
      this.logger.error(
        `Failed to release AI credit reservation ${reservation.id}`,
        releaseError instanceof Error
          ? releaseError.stack
          : String(releaseError),
      );
    }
  }

  private assertQuotedModel(
    quoted: { provider: AiProviderName; model: string },
    answered: { provider: AiProviderName; model: string },
  ): void {
    if (
      answered.provider !== quoted.provider ||
      answered.model !== quoted.model
    ) {
      throw new ServiceUnavailableException(
        'AI provider returned a different provider/model than the reserved pricing quote',
      );
    }
  }

  private assertMeteredResponse(
    params: BilledGenerationParams,
    response: AiGenerateResponse,
  ): void {
    this.assertQuotedModel(params, response);

    const inputTokens =
      response.usage.inputTokens +
      response.usage.cachedInputTokens +
      response.usage.cacheWriteTokens;
    if (
      inputTokens <= 0 ||
      (response.text.trim().length > 0 && response.usage.outputTokens <= 0)
    ) {
      throw new ServiceUnavailableException(
        `${response.provider}/${response.model} did not return billable token usage`,
      );
    }
  }

  private idempotencyKey(params: BilledGenerationParams): string | undefined {
    if (params.idempotencyKey) return params.idempotencyKey;
    if (!params.turnId) return undefined;

    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          params.kind,
          params.provider,
          params.model,
          params.request.systemInstruction ?? '',
          params.request.messages.map((message) => [
            message.role,
            message.text,
            (message.images ?? []).length,
          ]),
        ]),
      )
      .digest('hex')
      .slice(0, 32);

    return `usage:${params.turnId}:${fingerprint}`;
  }

  private toErrorCode(error: unknown): string {
    const name = error instanceof Error ? error.name : 'UnknownError';
    return name.slice(0, 100);
  }
}
