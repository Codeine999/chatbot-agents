/**
 * Publishes the built-in AI model list prices as `AiModelPricing` rows.
 *
 *   npm run seed:ai-pricing              # only models that have no price yet
 *   npm run seed:ai-pricing -- --overwrite   # republish every model
 *
 * A deployment with no rows refuses every AI call ("No active billable AI
 * pricing"), so this is part of install, not an optional extra.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AiPricingCatalogService } from '../modules/admin/pricing/ai-pricing-catalog.service';

async function main(): Promise<void> {
  const overwrite = process.argv.includes('--overwrite');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const { conversion, results } = await app
      .get(AiPricingCatalogService)
      .seedDefaults({ overwrite });

    console.table(results);
    console.log(
      `\n${conversion.usdToThb} THB/USD x ${conversion.creditsPerThb} credit/THB ` +
        `x ${conversion.markup} markup`,
    );
  } finally {
    await app.close();
  }

  // The application context starts BullMQ workers and Redis subscribers that
  // keep the event loop alive after close, so a seed run has to exit itself.
  process.exit(0);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
