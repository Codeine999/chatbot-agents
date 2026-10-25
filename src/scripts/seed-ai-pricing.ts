/**
 * Publishes the built-in AI model list prices as `AiModelPricing` rows.
 *
 *   bun run seed:ai-pricing                 # only models that have no price yet
 *   bun run seed:ai-pricing -- --overwrite  # republish every model
 *
 * Source: AI_MODEL_LIST_PRICES (usage/billing/ai-model-list-prices.ts), in USD.
 * Each price is converted with  THB/USD (AI_USD_THB_RATE, default 33)
 * x credits/THB (the exchange rate row) x markup (AI_CREDIT_MARKUP, default 1).
 *
 * The credit exchange rate must exist first (`bun run seed:credit-rate`).
 * A deployment with no price rows refuses every AI call ("No active billable
 * AI pricing"), so this is part of install, not an optional extra.
 */
import { AiPricingCatalogService } from '../modules/admin/pricing/ai-pricing-catalog.service';
import { PrismaService } from '../prisma/prisma.service';
import { failOnError, runSeed } from './run-seed';

failOnError(
  runSeed(async (app) => {
    const overwrite = process.argv.includes('--overwrite');

    // Without a rate row the catalog silently falls back to an env/default
    // value, and prices would later disagree with what top-ups give customers.
    const rate = await app
      .get(PrismaService)
      .creditExchangeRate.findFirst({ select: { id: true } });
    if (!rate)
      throw new Error(
        'No credit exchange rate yet. Run `bun run seed:credit-rate` first.',
      );

    const { conversion, results } = await app
      .get(AiPricingCatalogService)
      .seedDefaults({ overwrite });

    console.table(results);
    console.log(
      `\n${conversion.usdToThb} THB/USD x ${conversion.creditsPerThb} credit/THB ` +
        `x ${conversion.markup} markup`,
    );
  }),
);
