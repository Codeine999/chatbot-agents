import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AiModelCatalogService } from '../../ai/ai-setting/ai-model-catalog.service';
import type { AiProviderName } from '../../../ai-provider/types/ai-provider.types';
import { AI_PROVIDER_NAMES } from '../../../ai-provider/types/ai-provider.types';
import {
  ListAiModelPricingQueryDto,
  UpsertAiModelPricingDto,
} from './dto/admin-ai-pricing.dto';

const PRICING_SELECT = {
  id: true,
  provider: true,
  model: true,
  inputCostThbPerMillTokens: true,
  outputCostThbPerMillTokens: true,
  cachedInputCostThbPerMillTokens: true,
  cacheWriteCostThbPerMillTokens: true,
  inputCreditPerMillTokens: true,
  outputCreditPerMillTokens: true,
  cachedInputCreditPerMillTokens: true,
  cacheWriteCreditPerMillTokens: true,
  effectiveFrom: true,
  effectiveTo: true,
} as const;

/**
 * Back-office CRUD for `AiModelPricing`.
 *
 * Without a row that is active for a provider/model, `AiPricingService` prices
 * the call at zero: the provider bill still arrives but the customer wallet is
 * never debited. This is the only way to put those rows in place, so
 * `unpriced()` exists to make the gap visible before it costs real money.
 */
@Injectable()
export class AdminAiPricingService {
  private readonly logger = new Logger(AdminAiPricingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogService: AiModelCatalogService,
  ) {}

  list(query: ListAiModelPricingQueryDto) {
    const now = new Date();

    return this.prisma.aiModelPricing.findMany({
      where: {
        provider: query.provider,
        model: query.model,
        ...(query.includeExpired
          ? {}
          : { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }),
      },
      orderBy: [
        { provider: 'asc' },
        { model: 'asc' },
        { effectiveFrom: 'desc' },
      ],
      select: PRICING_SELECT,
    });
  }

  /**
   * Opens a new price and closes the one it replaces at the same instant, so
   * `findActivePricing` always resolves exactly one row and historical
   * `AiUsageEvent` rows keep pointing at the price they were billed under.
   */
  async upsert(body: UpsertAiModelPricingDto) {
    const effectiveFrom = body.effectiveFrom
      ? new Date(body.effectiveFrom)
      : new Date();
    const data = {
      inputCostThbPerMillTokens: new Prisma.Decimal(
        body.inputCostThbPerMillTokens,
      ),
      outputCostThbPerMillTokens: new Prisma.Decimal(
        body.outputCostThbPerMillTokens,
      ),
      cachedInputCostThbPerMillTokens: this.optionalDecimal(
        body.cachedInputCostThbPerMillTokens,
      ),
      cacheWriteCostThbPerMillTokens: this.optionalDecimal(
        body.cacheWriteCostThbPerMillTokens,
      ),
      inputCreditPerMillTokens: new Prisma.Decimal(
        body.inputCreditPerMillTokens,
      ),
      outputCreditPerMillTokens: new Prisma.Decimal(
        body.outputCreditPerMillTokens,
      ),
      cachedInputCreditPerMillTokens: this.optionalDecimal(
        body.cachedInputCreditPerMillTokens,
      ),
      cacheWriteCreditPerMillTokens: this.optionalDecimal(
        body.cacheWriteCreditPerMillTokens,
      ),
    };

    return this.prisma.$transaction(async (tx) => {
      await tx.aiModelPricing.updateMany({
        where: {
          provider: body.provider,
          model: body.model,
          effectiveFrom: { lt: effectiveFrom },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: effectiveFrom } }],
        },
        data: { effectiveTo: effectiveFrom },
      });

      return tx.aiModelPricing.upsert({
        where: {
          provider_model_effectiveFrom: {
            provider: body.provider,
            model: body.model,
            effectiveFrom,
          },
        },
        create: {
          provider: body.provider,
          model: body.model,
          effectiveFrom,
          ...data,
        },
        update: { effectiveTo: null, ...data },
        select: PRICING_SELECT,
      });
    });
  }

  async remove(id: string) {
    const deleted = await this.prisma.aiModelPricing.deleteMany({
      where: { id },
    });

    if (deleted.count === 0) {
      throw new NotFoundException('AI model pricing not found');
    }

    return { id, deleted: true };
  }

  /**
   * Every selectable provider/model that has no active price right now.
   * A non-empty list means those calls are running the provider bill up while
   * charging the wallet nothing.
   */
  async unpriced() {
    const now = new Date();
    const priced = await this.prisma.aiModelPricing.findMany({
      where: {
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      select: { provider: true, model: true },
    });

    const pricedKeys = new Set(
      priced.map((row) => `${row.provider}:${row.model}`),
    );

    const missing = AI_PROVIDER_NAMES.flatMap((provider) =>
      this.catalogModels(provider)
        .filter((model) => !pricedKeys.has(`${provider}:${model}`))
        .map((model) => ({ provider, model })),
    );

    if (missing.length > 0) {
      this.logger.warn(
        `${missing.length} configured model(s) have no active pricing and bill at zero credit`,
      );
    }

    return { checkedAt: now.toISOString(), missing };
  }

  private catalogModels(provider: AiProviderName): readonly string[] {
    try {
      return this.catalogService.getModels(provider);
    } catch {
      // A provider with nothing configured has nothing to price.
      return [];
    }
  }

  private optionalDecimal(value: string | null | undefined) {
    return value === null || value === undefined
      ? null
      : new Prisma.Decimal(value);
  }
}
