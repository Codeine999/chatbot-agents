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
import { CreditHold, CreditService } from '../credit-point/credit.service';
import { AiPricingService } from './ai-pricing.service';
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

@Injectable()
export class AiBillingService {
  private readonly logger = new Logger(AiBillingService.name);

  constructor(
    private readonly creditService: CreditService,
    private readonly pricingService: AiPricingService,
  ) {}

  async runBilled(params: BilledGenerationParams): Promise<AiGenerateResponse> {
    const quote = await this.pricingService.createQuote(
      params.provider,
      params.model,
      params.request,
    );

    const reservation = await this.creditService.reserveAiCredit(
      params.kind,
      params.scopeKey ?? LINE_AI_BUDGET_SCOPE_KEY,
      quote.reservedCredit,
      { requireBudgetLimit: params.requireBudgetLimit ?? false },
    );

    const startedAt = Date.now();
    let response: AiGenerateResponse;

    try {
      response = await params.call();
    } catch (error) {
      await this.record(reservation, params, {
        status: 'failed',
        usage: EMPTY_AI_TOKEN_USAGE,
        cost: ZERO_AI_USAGE_COST,
        latencyMs: Date.now() - startedAt,
        errorCode: this.toErrorCode(error),
      });

      throw error;
    }

    const latencyMs = Date.now() - startedAt;
    let cost: AiUsageCost;
    try {
      this.assertMeteredResponse(params, response);
      cost = this.pricingService.calculateQuote(quote, response.usage);
    } catch (error) {
      await this.record(reservation, params, {
        status: 'failed',
        usage: response.usage,
        cost: ZERO_AI_USAGE_COST,
        latencyMs,
        providerRequestId: response.providerRequestId,
        provider: response.provider,
        model: response.model,
        errorCode: this.toErrorCode(error),
      });
      throw error;
    }

    await this.record(reservation, params, {
      status: 'success',
      usage: response.usage,
      cost,
      latencyMs,
      providerRequestId: response.providerRequestId,
      provider: response.provider,
      model: response.model,
    });

    return response;
  }

  private async record(
    reservation: CreditHold,
    params: BilledGenerationParams,
    outcome: {
      status: 'success' | 'failed';
      usage: AiGenerateResponse['usage'];
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
        idempotencyKey: this.idempotencyKey(params),
        kind: params.kind,
        provider: outcome.provider ?? params.provider,
        model: outcome.model ?? params.model,
        usage: outcome.usage,
        cost: outcome.cost,
        status: outcome.status,
        adminMemberId: params.adminMemberId,
        lineMemberId: params.lineMemberId,
        conversationId: params.conversationId,
        providerRequestId: outcome.providerRequestId,
        latencyMs: outcome.latencyMs,
        errorCode: outcome.errorCode,
      });
    } catch (error) {
      this.logger.error(
        `Failed to record ${params.kind} usage for ${params.provider}/${params.model}`,
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

  private assertMeteredResponse(
    params: BilledGenerationParams,
    response: AiGenerateResponse,
  ): void {
    if (
      response.provider !== params.provider ||
      response.model !== params.model
    ) {
      throw new ServiceUnavailableException(
        'AI provider returned a different provider/model than the reserved pricing quote',
      );
    }

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
