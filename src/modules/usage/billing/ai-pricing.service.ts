import { Injectable, ServiceUnavailableException } from '@nestjs/common';
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
const ONE_RATE_MULTIPLIER = new Prisma.Decimal(1);
const CREDIT_SCALE = 6;

type RateMultipliers = Readonly<{
  input: Prisma.Decimal;
  output: Prisma.Decimal;
  cachedInput: Prisma.Decimal;
  cacheWrite: Prisma.Decimal;
}>;

export type PricingRow = {
  id: string;
  inputCostThbPerMillTokens: Prisma.Decimal;
  outputCostThbPerMillTokens: Prisma.Decimal;
  cachedInputCostThbPerMillTokens: Prisma.Decimal | null;
  cacheWriteCostThbPerMillTokens: Prisma.Decimal | null;
  inputCreditPerMillTokens: Prisma.Decimal;
  outputCreditPerMillTokens: Prisma.Decimal;
  cachedInputCreditPerMillTokens: Prisma.Decimal | null;
  cacheWriteCreditPerMillTokens: Prisma.Decimal | null;
  longContextThresholdTokens: number | null;
  longContextInputRateMultiplier: Prisma.Decimal | null;
  longContextOutputRateMultiplier: Prisma.Decimal | null;
  longContextCachedInputRateMultiplier: Prisma.Decimal | null;
  longContextCacheWriteRateMultiplier: Prisma.Decimal | null;
};

export type AiPricingQuote = Readonly<{
  provider: AiProviderName;
  model: string;
  pricing: PricingRow;
  reservedCredit: Prisma.Decimal;
}>;

@Injectable()
export class AiPricingService {
  constructor(private readonly prisma: PrismaService) {}

  async calculate(
    provider: AiProviderName,
    model: string,
    usage: AiTokenUsage,
    at: Date = new Date(),
  ): Promise<AiUsageCost> {
    const pricing = await this.requireActivePricing(provider, model, at);

    return this.calculateWithPricing(pricing, usage);
  }

  async createQuote(
    provider: AiProviderName,
    model: string,
    request: AiGenerateRequest,
    at: Date = new Date(),
  ): Promise<AiPricingQuote> {
    const pricing = await this.requireActivePricing(provider, model, at);

    return {
      provider,
      model,
      pricing,
      reservedCredit: this.reservationCredit(pricing, request),
    };
  }

  calculateQuote(quote: AiPricingQuote, usage: AiTokenUsage): AiUsageCost {
    return this.calculateWithPricing(quote.pricing, usage);
  }

  private calculateWithPricing(
    pricing: PricingRow,
    usage: AiTokenUsage,
  ): AiUsageCost {
    const multipliers = this.rateMultipliers(
      pricing,
      this.totalInputTokens(usage),
    );

    return {
      pricingId: pricing.id,
      costThb: this.total(
        usage,
        {
          input: pricing.inputCostThbPerMillTokens,
          output: pricing.outputCostThbPerMillTokens,
          cachedInput: pricing.cachedInputCostThbPerMillTokens,
          cacheWrite: pricing.cacheWriteCostThbPerMillTokens,
        },
        multipliers,
      ),
      chargedCredit: this.total(
        usage,
        {
          input: pricing.inputCreditPerMillTokens,
          output: pricing.outputCreditPerMillTokens,
          cachedInput: pricing.cachedInputCreditPerMillTokens,
          cacheWrite: pricing.cacheWriteCreditPerMillTokens,
        },
        multipliers,
      ),
    };
  }

  async estimateReservationCredit(
    provider: AiProviderName,
    model: string,
    request: AiGenerateRequest,
    at: Date = new Date(),
  ): Promise<Prisma.Decimal> {
    return (await this.createQuote(provider, model, request, at))
      .reservedCredit;
  }

  private reservationCredit(
    pricing: PricingRow,
    request: AiGenerateRequest,
  ): Prisma.Decimal {
    const estimate = estimateMaxTokenUsage(request);
    const multipliers = this.rateMultipliers(
      pricing,
      this.totalInputTokens(estimate),
    );
    const normalInput = pricing.inputCreditPerMillTokens;
    const inputRate = [
      normalInput.mul(multipliers.input),
      (pricing.cachedInputCreditPerMillTokens ?? normalInput).mul(
        multipliers.cachedInput,
      ),
      (pricing.cacheWriteCreditPerMillTokens ?? normalInput).mul(
        multipliers.cacheWrite,
      ),
    ].reduce((highest, rate) => (rate.greaterThan(highest) ? rate : highest));

    return this.perMillion(estimate.inputTokens, inputRate)
      .plus(
        this.perMillion(
          estimate.outputTokens,
          pricing.outputCreditPerMillTokens.mul(multipliers.output),
        ),
      )
      .toDecimalPlaces(CREDIT_SCALE, Prisma.Decimal.ROUND_CEIL);
  }

  private async requireActivePricing(
    provider: AiProviderName,
    model: string,
    at: Date,
  ): Promise<PricingRow> {
    const pricing = await this.findActivePricing(provider, model, at);

    if (
      !pricing ||
      !pricing.inputCreditPerMillTokens.greaterThan(0) ||
      !pricing.outputCreditPerMillTokens.greaterThan(0)
    ) {
      throw new ServiceUnavailableException(
        `No active billable AI pricing for ${provider}/${model}`,
      );
    }

    return pricing;
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
        longContextThresholdTokens: true,
        longContextInputRateMultiplier: true,
        longContextOutputRateMultiplier: true,
        longContextCachedInputRateMultiplier: true,
        longContextCacheWriteRateMultiplier: true,
      },
    });
  }

  private total(
    usage: AiTokenUsage,
    rates: {
      input: Prisma.Decimal;
      output: Prisma.Decimal;
      cachedInput: Prisma.Decimal | null;
      cacheWrite: Prisma.Decimal | null;
    },
    multipliers: RateMultipliers,
  ): Prisma.Decimal {
    return this.perMillion(
      usage.inputTokens,
      rates.input.mul(multipliers.input),
    )
      .plus(
        this.perMillion(
          usage.cachedInputTokens,
          (rates.cachedInput ?? rates.input).mul(multipliers.cachedInput),
        ),
      )
      .plus(
        this.perMillion(
          usage.cacheWriteTokens,
          (rates.cacheWrite ?? rates.input).mul(multipliers.cacheWrite),
        ),
      )
      .plus(
        this.perMillion(
          usage.outputTokens,
          rates.output.mul(multipliers.output),
        ),
      )
      .toDecimalPlaces(CREDIT_SCALE, Prisma.Decimal.ROUND_HALF_UP);
  }

  /**
   * Long-context pricing is selected from all disjoint input buckets. Output
   * tokens never decide the tier, but the selected output multiplier applies
   * to the whole request once the input threshold is exceeded.
   */
  private rateMultipliers(
    pricing: PricingRow,
    totalInputTokens: number,
  ): RateMultipliers {
    if (
      pricing.longContextThresholdTokens === null ||
      totalInputTokens <= pricing.longContextThresholdTokens
    ) {
      return {
        input: ONE_RATE_MULTIPLIER,
        output: ONE_RATE_MULTIPLIER,
        cachedInput: ONE_RATE_MULTIPLIER,
        cacheWrite: ONE_RATE_MULTIPLIER,
      };
    }

    return {
      input: pricing.longContextInputRateMultiplier ?? ONE_RATE_MULTIPLIER,
      output: pricing.longContextOutputRateMultiplier ?? ONE_RATE_MULTIPLIER,
      cachedInput:
        pricing.longContextCachedInputRateMultiplier ?? ONE_RATE_MULTIPLIER,
      cacheWrite:
        pricing.longContextCacheWriteRateMultiplier ?? ONE_RATE_MULTIPLIER,
    };
  }

  private totalInputTokens(usage: AiTokenUsage): number {
    return usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens;
  }

  private perMillion(tokens: number, rate: Prisma.Decimal): Prisma.Decimal {
    if (tokens <= 0) return new Prisma.Decimal(0);
    return new Prisma.Decimal(tokens).mul(rate).div(TOKENS_PER_MILLION);
  }
}
