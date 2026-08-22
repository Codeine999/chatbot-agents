import { Injectable, Logger } from '@nestjs/common';
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
  /** `*` for the shared LINE pool, the admin id for a per-admin budget. */
  scopeKey?: string;
  provider: AiProviderName;
  model: string;
  request: AiGenerateRequest;
  adminMemberId?: string;
  /** Stable across BullMQ attempts so a retried request cannot debit twice. */
  idempotencyKey?: string;
  call: () => Promise<AiGenerateResponse>;
}> &
  Pick<LineAiUsageContext, 'lineMemberId' | 'conversationId'>;

/**
 * One billed AI call:
 *
 *   reserve credit -> call provider -> read actual usage -> price it ->
 *   settle wallet + budget + ledger.
 *
 * A provider failure releases the reservation and is logged without touching
 * the customer's actual balance.
 */
@Injectable()
export class AiBillingService {
  private readonly logger = new Logger(AiBillingService.name);

  constructor(
    private readonly creditService: CreditService,
    private readonly pricingService: AiPricingService,
  ) {}

  async runBilled(params: BilledGenerationParams): Promise<AiGenerateResponse> {
    const reservedCredit = await this.pricingService.estimateReservationCredit(
      params.provider,
      params.model,
      params.request,
    );
    const reservation = await this.creditService.reserveAiCredit(
      params.kind,
      params.scopeKey ?? LINE_AI_BUDGET_SCOPE_KEY,
      reservedCredit,
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
      cost = await this.pricingService.calculate(
        response.provider,
        response.model,
        response.usage,
      );
    } catch (error) {
      await this.releaseAfterBillingFailure(reservation);
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

  /**
   * Settlement never fails the caller: the provider answer has already been
   * produced and paid for upstream, so a billing write error is logged for
   * reconciliation instead of losing the reply.
   */
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
        idempotencyKey: params.idempotencyKey,
      });
    } catch (error) {
      this.logger.error(
        `Failed to record ${params.kind} usage for ${params.provider}/${params.model}`,
        error instanceof Error ? error.stack : String(error),
      );
      await this.releaseAfterBillingFailure(reservation);
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

  private toErrorCode(error: unknown): string {
    const name = error instanceof Error ? error.name : 'UnknownError';
    return name.slice(0, 100);
  }
}
