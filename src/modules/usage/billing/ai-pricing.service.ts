import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  AiGenerateRequest,
  AiProviderName,
  AiTokenUsage,
} from '../../../ai-provider/types/ai-provider.types';
import { estimateMaxTokenUsage } from '../../../ai-provider/utils/token-usage.utils';
import { AiUsageCost } from './ai-usage.types';

const TOKENS_PER_MILLION = new Prisma.Decimal(1_000_000);
const CREDIT_SCALE = 6;

const ZERO_COST: AiUsageCost = {
  costThb: new Prisma.Decimal(0),
  chargedCredit: new Prisma.Decimal(0),
  pricingId: null,
};

type PricingRow = {
  id: string;
  inputCostThbPerMillTokens: Prisma.Decimal;
  outputCostThbPerMillTokens: Prisma.Decimal;
  cachedInputCostThbPerMillTokens: Prisma.Decimal | null;
  cacheWriteCostThbPerMillTokens: Prisma.Decimal | null;
  inputCreditPerMillTokens: Prisma.Decimal;
  outputCreditPerMillTokens: Prisma.Decimal;
  cachedInputCreditPerMillTokens: Prisma.Decimal | null;
  cacheWriteCreditPerMillTokens: Prisma.Decimal | null;
};

/**
 * Turns actual provider token usage into money (`costThb`, what we pay) and
 * credits (`chargedCredit`, what the customer pays), using the
 * `AiModelPricing` row that is active for that provider/model right now.
 *
 * All arithmetic stays in `Prisma.Decimal` — credits are money and must never
 * pass through a JavaScript float.
 */
@Injectable()
export class AiPricingService {
  private readonly logger = new Logger(AiPricingService.name);

  constructor(private readonly prisma: PrismaService) {}

  async calculate(
    provider: AiProviderName,
    model: string,
    usage: AiTokenUsage,
    at: Date = new Date(),
  ): Promise<AiUsageCost> {
    const pricing = await this.findActivePricing(provider, model, at);

    if (!pricing) {
      // Never block a reply that already cost us a provider call — log the
      // usage at zero credit and let the back office add the missing price.
      this.logger.warn(
        `No active AiModelPricing for ${provider}/${model}; usage recorded uncharged`,
      );
      return ZERO_COST;
    }

    return {
      pricingId: pricing.id,
      costThb: this.total(usage, {
        input: pricing.inputCostThbPerMillTokens,
        output: pricing.outputCostThbPerMillTokens,
        cachedInput: pricing.cachedInputCostThbPerMillTokens,
        cacheWrite: pricing.cacheWriteCostThbPerMillTokens,
      }),
      chargedCredit: this.total(usage, {
        input: pricing.inputCreditPerMillTokens,
        output: pricing.outputCreditPerMillTokens,
        cachedInput: pricing.cachedInputCreditPerMillTokens,
        cacheWrite: pricing.cacheWriteCreditPerMillTokens,
      }),
    };
  }

  /**
   * Maximum customer credit held before a provider call. The input estimate is
   * charged at the most expensive configured input/cache rate so cache bucket
   * selection cannot make the final charge exceed the reservation.
   */
  async estimateReservationCredit(
    provider: AiProviderName,
    model: string,
    request: AiGenerateRequest,
    at: Date = new Date(),
  ): Promise<Prisma.Decimal> {
    const pricing = await this.findActivePricing(provider, model, at);
    if (!pricing) return new Prisma.Decimal(0);

    const normalInput = pricing.inputCreditPerMillTokens;
    const inputRate = [
      normalInput,
      pricing.cachedInputCreditPerMillTokens ?? normalInput,
      pricing.cacheWriteCreditPerMillTokens ?? normalInput,
    ].reduce((highest, rate) => (rate.greaterThan(highest) ? rate : highest));

    const estimate = estimateMaxTokenUsage(request);
    return this.perMillion(estimate.inputTokens, inputRate)
      .plus(
        this.perMillion(
          estimate.outputTokens,
          pricing.outputCreditPerMillTokens,
        ),
      )
      .toDecimalPlaces(CREDIT_SCALE, Prisma.Decimal.ROUND_CEIL);
  }

  findActivePricing(
    provider: AiProviderName,
    model: string,
    at: Date = new Date(),
  ): Promise<PricingRow | null> {
    return this.prisma.aiModelPricing.findFirst({
      where: {
        provider,
        model,
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: { effectiveFrom: 'desc' },
      select: {
        id: true,
        inputCostThbPerMillTokens: true,
        outputCostThbPerMillTokens: true,
        cachedInputCostThbPerMillTokens: true,
        cacheWriteCostThbPerMillTokens: true,
        inputCreditPerMillTokens: true,
        outputCreditPerMillTokens: true,
        cachedInputCreditPerMillTokens: true,
        cacheWriteCreditPerMillTokens: true,
      },
    });
  }

  /**
   * Cache rates are optional. When one is missing the tokens are billed at the
   * normal input rate rather than at zero — an unconfigured cache discount
   * must not silently give the usage away for free.
   */
  private total(
    usage: AiTokenUsage,
    rates: {
      input: Prisma.Decimal;
      output: Prisma.Decimal;
      cachedInput: Prisma.Decimal | null;
      cacheWrite: Prisma.Decimal | null;
    },
  ): Prisma.Decimal {
    return this.perMillion(usage.inputTokens, rates.input)
      .plus(
        this.perMillion(
          usage.cachedInputTokens,
          rates.cachedInput ?? rates.input,
        ),
      )
      .plus(
        this.perMillion(
          usage.cacheWriteTokens,
          rates.cacheWrite ?? rates.input,
        ),
      )
      .plus(this.perMillion(usage.outputTokens, rates.output))
      .toDecimalPlaces(CREDIT_SCALE, Prisma.Decimal.ROUND_HALF_UP);
  }

  private perMillion(tokens: number, rate: Prisma.Decimal): Prisma.Decimal {
    if (tokens <= 0) return new Prisma.Decimal(0);
    return new Prisma.Decimal(tokens).mul(rate).div(TOKENS_PER_MILLION);
  }
}
