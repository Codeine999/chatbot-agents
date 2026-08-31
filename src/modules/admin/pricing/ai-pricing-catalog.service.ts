import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AI_MODEL_LIST_PRICES,
  AiModelListPrice,
} from '../../usage/billing/ai-model-list-prices';
import { AdminAiPricingService } from './admin-ai-pricing.service';
import type { UpsertAiModelPricingDto } from './dto/admin-ai-pricing.dto';

/** Fallbacks used only when the deployment has configured nothing. */
const DEFAULT_USD_THB_RATE = 33;
const DEFAULT_CREDITS_PER_THB = 10;
const DEFAULT_CREDIT_MARKUP = 1;

const RATE_SCALE = 6;

export type PricingConversion = Readonly<{
  /** THB paid per 1 USD of provider invoice. */
  usdToThb: Prisma.Decimal;
  /** Credits a customer receives per 1 THB topped up. */
  creditsPerThb: Prisma.Decimal;
  /** Business margin applied on top of cost. 1 = sell at cost. */
  markup: Prisma.Decimal;
}>;

export type SeededPricing = Readonly<{
  provider: AiModelListPrice['provider'];
  model: string;
  action: 'created' | 'replaced' | 'skipped';
}>;

/**
 * Turns published provider list prices into `AiModelPricing` rows.
 *
 * This exists because a fresh install has zero pricing rows, and
 * `AiPricingService` refuses to bill a provider/model without one — so an
 * unseeded deployment has every AI path dead with
 * "No active billable AI pricing". Seeding is idempotent and, by default,
 * never overwrites a price an owner has already published.
 *
 *   credit/Mtok = USD/Mtok x THB per USD x credits per THB x markup
 *
 * The per-model credit rate *is* the token→credit conversion: model prices
 * differ by up to 80x (gpt-5-nano at $0.05/Mtok input vs claude-fable-5 at
 * $10), so a flat "1 token = 1 credit" rule would badly undercharge the
 * expensive models. Swapping the selected model therefore changes what a
 * turn costs, with no extra conversion layer needed anywhere else.
 */
@Injectable()
export class AiPricingCatalogService {
  private readonly logger = new Logger(AiPricingCatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: AdminAiPricingService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Publishes the built-in list prices for every model that has no active
   * billable row. With `overwrite`, republishes all of them — used after a
   * provider price change or an exchange-rate move.
   */
  async seedDefaults(
    options: { overwrite?: boolean } = {},
  ): Promise<{ conversion: Record<string, string>; results: SeededPricing[] }> {
    const conversion = await this.resolveConversion();
    const pricedKeys = await this.activeBillableKeys();
    const results: SeededPricing[] = [];

    for (const listPrice of AI_MODEL_LIST_PRICES) {
      const key = `${listPrice.provider}:${listPrice.model}`;
      const alreadyPriced = pricedKeys.has(key);

      if (alreadyPriced && !options.overwrite) {
        results.push({ ...this.identity(listPrice), action: 'skipped' });
        continue;
      }

      await this.pricingService.upsert(
        this.toUpsertBody(listPrice, conversion),
      );
      results.push({
        ...this.identity(listPrice),
        action: alreadyPriced ? 'replaced' : 'created',
      });
    }

    const written = results.filter((row) => row.action !== 'skipped').length;
    this.logger.log(
      `Seeded ${written} AI model price(s) at ` +
        `${conversion.usdToThb.toString()} THB/USD x ` +
        `${conversion.creditsPerThb.toString()} credit/THB x ` +
        `${conversion.markup.toString()} markup`,
    );

    return {
      conversion: {
        usdToThb: conversion.usdToThb.toString(),
        creditsPerThb: conversion.creditsPerThb.toString(),
        markup: conversion.markup.toString(),
      },
      results,
    };
  }

  /**
   * Credits per THB is read from the live `CreditExchangeRate` so a model
   * price and a customer top-up always use the same credit unit. If those two
   * drifted apart, a wallet's credits would buy a different amount of AI than
   * the price list says they should.
   */
  async resolveConversion(at: Date = new Date()): Promise<PricingConversion> {
    const rate = await this.prisma.creditExchangeRate.findFirst({
      where: {
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: { effectiveFrom: 'desc' },
      select: { creditsPerThb: true },
    });

    return {
      usdToThb: this.positiveDecimal(
        this.configService.get('AI_USD_THB_RATE'),
        DEFAULT_USD_THB_RATE,
      ),
      creditsPerThb:
        rate?.creditsPerThb ??
        this.positiveDecimal(
          this.configService.get('CREDITS_PER_THB'),
          DEFAULT_CREDITS_PER_THB,
        ),
      markup: this.positiveDecimal(
        this.configService.get('AI_CREDIT_MARKUP'),
        DEFAULT_CREDIT_MARKUP,
      ),
    };
  }

  /** Pure USD -> THB cost + credit price conversion for one model. */
  toUpsertBody(
    listPrice: AiModelListPrice,
    conversion: PricingConversion,
  ): UpsertAiModelPricingDto {
    const cost = (usd: number | undefined) =>
      usd === undefined
        ? null
        : this.rate(new Prisma.Decimal(usd).mul(conversion.usdToThb));
    const credit = (usd: number | undefined) =>
      usd === undefined
        ? null
        : this.rate(
            new Prisma.Decimal(usd)
              .mul(conversion.usdToThb)
              .mul(conversion.creditsPerThb)
              .mul(conversion.markup),
          );
    const multiplier = (value: number | undefined) =>
      value === undefined ? null : this.rate(new Prisma.Decimal(value));

    return {
      provider: listPrice.provider,
      model: listPrice.model,

      inputCostThbPerMillTokens: cost(listPrice.inputUsdPerMillTokens)!,
      outputCostThbPerMillTokens: cost(listPrice.outputUsdPerMillTokens)!,
      cachedInputCostThbPerMillTokens: cost(
        listPrice.cachedInputUsdPerMillTokens,
      ),
      cacheWriteCostThbPerMillTokens: cost(
        listPrice.cacheWriteUsdPerMillTokens,
      ),

      inputCreditPerMillTokens: credit(listPrice.inputUsdPerMillTokens)!,
      outputCreditPerMillTokens: credit(listPrice.outputUsdPerMillTokens)!,
      cachedInputCreditPerMillTokens: credit(
        listPrice.cachedInputUsdPerMillTokens,
      ),
      cacheWriteCreditPerMillTokens: credit(
        listPrice.cacheWriteUsdPerMillTokens,
      ),

      longContextThresholdTokens:
        listPrice.longContext?.thresholdTokens ?? null,
      longContextInputRateMultiplier: multiplier(
        listPrice.longContext?.inputMultiplier,
      ),
      longContextOutputRateMultiplier: multiplier(
        listPrice.longContext?.outputMultiplier,
      ),
      longContextCachedInputRateMultiplier: multiplier(
        listPrice.longContext?.cachedInputMultiplier,
      ),
      longContextCacheWriteRateMultiplier: multiplier(
        listPrice.longContext?.cacheWriteMultiplier,
      ),
    };
  }

  private async activeBillableKeys(
    at: Date = new Date(),
  ): Promise<Set<string>> {
    const rows = await this.prisma.aiModelPricing.findMany({
      where: {
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      select: {
        provider: true,
        model: true,
        inputCreditPerMillTokens: true,
        outputCreditPerMillTokens: true,
      },
    });

    return new Set(
      rows
        .filter(
          (row) =>
            row.inputCreditPerMillTokens.greaterThan(0) &&
            row.outputCreditPerMillTokens.greaterThan(0),
        )
        .map((row) => `${row.provider}:${row.model}`),
    );
  }

  private identity(listPrice: AiModelListPrice) {
    return { provider: listPrice.provider, model: listPrice.model };
  }

  /**
   * `Decimal(20,6)` is the column type and the DTO only accepts plain decimal
   * notation, so every rate is fixed to six places rather than left to
   * `toString()`, which would emit exponent form for very small numbers.
   */
  private rate(value: Prisma.Decimal): string {
    return value
      .toDecimalPlaces(RATE_SCALE, Prisma.Decimal.ROUND_HALF_UP)
      .toFixed(RATE_SCALE);
  }

  private positiveDecimal(value: unknown, fallback: number): Prisma.Decimal {
    const parsed = Number(value);
    return new Prisma.Decimal(
      Number.isFinite(parsed) && parsed > 0 ? parsed : fallback,
    );
  }
}
