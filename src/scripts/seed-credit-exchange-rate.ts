import { CreditExchangeRateService } from '../modules/admin/dev/credit/credit-exchange-rate.service';
import { PrismaService } from '../prisma/prisma.service';
import { failOnError, runSeed } from './run-seed';

const DEFAULT_CREDITS_PER_THB = '10';

function requestedRate(): string {
  const arg = process.argv.find((value) => value.startsWith('--rate='));
  return (
    arg?.slice('--rate='.length) ??
    process.env.CREDITS_PER_THB ??
    DEFAULT_CREDITS_PER_THB
  ).trim();
}

failOnError(
  runSeed(async (app) => {
    const overwrite = process.argv.includes('--overwrite');
    const creditsPerThb = requestedRate();
    const prisma = app.get(PrismaService);
    const service = app.get(CreditExchangeRateService, { strict: false });

    const existing = await prisma.creditExchangeRate.findFirst({
      select: { creditsPerThb: true },
    });
    if (existing && !overwrite) {
      console.log(
        `Credit exchange rate already set: ${existing.creditsPerThb.toString()} credits/THB (use --overwrite to change)`,
      );
      return;
    }

    // The service validates the value (positive, at most 6 decimals).
    const saved = existing
      ? await service.update({ creditsPerThb })
      : await service.create({ creditsPerThb });
    console.log(
      `${existing ? 'Updated' : 'Created'} credit exchange rate: ${saved.creditsPerThb.toString()} credits/THB`,
    );
  }),
);
