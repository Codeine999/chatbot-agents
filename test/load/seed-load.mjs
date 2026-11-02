// Prepares the load database and snapshots billing totals before a run.
// Usage: LOAD_DIST=... node test/load/seed-load.mjs <outDir> [topupCredit]
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadPrisma } from './lib.mjs';

const [outDir, topup = '1000000'] = process.argv.slice(2);
if (!outDir) throw new Error('usage: seed-load.mjs <outDir> [topupCredit]');
mkdirSync(outDir, { recursive: true });

const { prisma, Prisma } = await loadPrisma();
try {
  // LINE credentials come from the dummy env values, never a stored channel.
  await prisma.lineChannel.deleteMany({});

  const wallet = await prisma.creditWallet.findFirstOrThrow();
  const amount = new Prisma.Decimal(topup);
  if (amount.greaterThan(0)) {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.creditWallet.update({
        where: { id: wallet.id },
        data: {
          balanceCredit: { increment: amount },
          lifetimeTopupCredit: { increment: amount },
        },
      });
      await tx.creditLedger.create({
        data: {
          walletId: wallet.id,
          type: 'TOPUP',
          amountCredit: amount,
          balanceAfterCredit: updated.balanceCredit,
          idempotencyKey: `load-topup-${Date.now()}`,
          note: 'internal load test top-up',
        },
      });
    });
  }

  const snapshot = {
    takenAt: new Date().toISOString(),
    wallet: await prisma.creditWallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    budgets: await prisma.creditBudget.findMany({ where: { walletId: wallet.id } }),
    ledgerCount: await prisma.creditLedger.count(),
    usageCount: await prisma.aiUsageEvent.count(),
  };
  writeFileSync(`${outDir}/before.json`, JSON.stringify(snapshot, null, 2));
  console.log(
    `seeded: balance=${snapshot.wallet.balanceCredit} reserved=${snapshot.wallet.reservedCredit}`,
  );
} finally {
  await prisma.$disconnect();
}
