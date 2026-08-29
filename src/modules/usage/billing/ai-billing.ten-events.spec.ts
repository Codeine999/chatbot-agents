/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CompanyService } from '../../admin/company/company.service';
import type {
  AiGenerateRequest,
  AiGenerateResponse,
  AiTokenUsage,
} from '../../../ai-provider/types/ai-provider.types';
import { CreditService } from '../credit-point/credit.service';
import { AiBillingService } from './ai-billing.service';
import { AiPricingService } from './ai-pricing.service';

const decimal = (value: string | number) => new Prisma.Decimal(value);

/**
 * End-to-end billing audit over the real service chain:
 *
 *   AiBillingService -> AiPricingService -> CreditService
 *
 * Only the database is faked, statefully: wallet and budget balances move,
 * AiUsageEvent and CreditLedger rows accumulate, the ledger enforces its
 * unique idempotencyKey, and $transaction rolls everything back on failure —
 * so these tests verify the same arithmetic a real Postgres would commit.
 */
function createBillingWorld() {
  const wallet = {
    id: 'wallet-1',
    companyId: 'company-1',
    active: true,
    balanceCredit: decimal(1000),
    reservedCredit: decimal(0),
    lifetimeTopupCredit: decimal(1000),
    lifetimeSpentCredit: decimal(0),
  };
  const budget = {
    id: 'budget-1',
    limitCredit: null as Prisma.Decimal | null,
    usedCredit: decimal(0),
    reservedCredit: decimal(0),
  };
  const pricing = {
    id: 'pricing-1',
    inputCostThbPerMillTokens: decimal(100),
    outputCostThbPerMillTokens: decimal(300),
    cachedInputCostThbPerMillTokens: decimal(25),
    cacheWriteCostThbPerMillTokens: decimal(125),
    inputCreditPerMillTokens: decimal(500),
    outputCreditPerMillTokens: decimal(1500),
    cachedInputCreditPerMillTokens: decimal(125),
    cacheWriteCreditPerMillTokens: decimal(625),
  };
  const aiUsageEvents: any[] = [];
  const ledger: any[] = [];

  const applyUpdate = (
    current: Prisma.Decimal,
    update: { increment?: Prisma.Decimal; decrement?: Prisma.Decimal },
  ) => {
    if (update.increment) return current.plus(update.increment);
    if (update.decrement) return current.minus(update.decrement);
    return current;
  };

  const tx = {
    creditWallet: {
      findUniqueOrThrow: jest.fn().mockImplementation(() => ({ ...wallet })),
      update: jest.fn().mockImplementation(({ data }) => {
        for (const field of [
          'reservedCredit',
          'balanceCredit',
          'lifetimeSpentCredit',
        ] as const) {
          if (data[field])
            wallet[field] = applyUpdate(wallet[field], data[field]);
        }
        return { balanceCredit: wallet.balanceCredit };
      }),
    },
    creditBudget: {
      findUniqueOrThrow: jest.fn().mockImplementation(() => ({ ...budget })),
      update: jest.fn().mockImplementation(({ data }) => {
        for (const field of ['reservedCredit', 'usedCredit'] as const) {
          if (data[field])
            budget[field] = applyUpdate(budget[field], data[field]);
        }
        return { ...budget };
      }),
    },
    aiUsageEvent: {
      create: jest.fn().mockImplementation(({ data }) => {
        aiUsageEvents.push({ ...data });
        return { ...data };
      }),
    },
    creditLedger: {
      create: jest.fn().mockImplementation(({ data }) => {
        if (ledger.some((row) => row.idempotencyKey === data.idempotencyKey)) {
          throw new Prisma.PrismaClientKnownRequestError('duplicate key', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        ledger.push({ ...data });
        return { ...data };
      }),
    },
  };

  const prisma = {
    aiModelPricing: {
      findFirst: jest.fn().mockImplementation(({ where }) => {
        return where.provider === 'GEMINI' && where.model === 'gemini-test'
          ? { ...pricing }
          : null;
      }),
    },
    creditWallet: {
      findUnique: jest.fn().mockImplementation(() => ({ ...wallet })),
      upsert: jest.fn(),
    },
    creditBudget: {
      findUnique: jest.fn().mockImplementation(() => ({ ...budget })),
      upsert: jest.fn(),
    },
    creditLedger: {
      findUnique: jest.fn().mockImplementation(({ where }) => {
        const row = ledger.find(
          (entry) => entry.idempotencyKey === where.idempotencyKey,
        );
        return row ? { ...row } : null;
      }),
    },
    // Postgres-like rollback: balances and rows written inside a failed
    // transaction never become visible.
    $transaction: jest.fn().mockImplementation(async (work) => {
      const walletBefore = { ...wallet };
      const budgetBefore = { ...budget };
      const eventsBefore = aiUsageEvents.length;
      const ledgerBefore = ledger.length;

      try {
        return await work(tx);
      } catch (error) {
        Object.assign(wallet, walletBefore);
        Object.assign(budget, budgetBefore);
        aiUsageEvents.length = eventsBefore;
        ledger.length = ledgerBefore;
        throw error;
      }
    }),
  } as unknown as PrismaService;

  const companyService = {
    getCompanyId: jest.fn().mockResolvedValue('company-1'),
  } as unknown as CompanyService;
  const configService = {
    get: jest.fn().mockReturnValue(undefined),
  } as unknown as ConfigService;

  const creditService = new CreditService(prisma, companyService, configService);
  const pricingService = new AiPricingService(prisma);
  const billingService = new AiBillingService(creditService, pricingService);

  return { billingService, wallet, budget, aiUsageEvents, ledger };
}

const request = (text: string): AiGenerateRequest => ({
  messages: [{ role: 'user', text }],
});

const response = (usage: AiTokenUsage): AiGenerateResponse => ({
  text: 'คำตอบ',
  provider: 'GEMINI',
  model: 'gemini-test',
  usage,
  providerRequestId: 'req-1',
});

const usage = (
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): AiTokenUsage => ({
  inputTokens,
  cachedInputTokens,
  cacheWriteTokens: 0,
  outputTokens,
});

describe('10-event billing audit (reserve -> price -> settle -> ledger)', () => {
  it('charges each of 10 events its exact price and the sums reconcile', async () => {
    const world = createBillingWorld();

    // Pricing: input 500 credit/M tokens, output 1500 credit/M tokens.
    // Event i uses 1000*i input + 200*i output tokens:
    //   charge_i = 1000i*500/1e6 + 200i*1500/1e6 = 0.5i + 0.3i = 0.8i credits
    for (let i = 1; i <= 10; i += 1) {
      await world.billingService.runBilled({
        kind: 'LINE_AI_REPLY',
        scopeKey: '*',
        provider: 'GEMINI',
        model: 'gemini-test',
        request: request(`คำถามที่ ${i}`),
        turnId: `evt-${i}`,
        lineMemberId: 'line-member-1',
        conversationId: 'conversation-1',
        call: () => Promise.resolve(response(usage(1000 * i, 200 * i))),
      });
    }

    // Per-event audit rows carry the exact charge for that event's tokens.
    expect(world.aiUsageEvents).toHaveLength(10);
    for (let i = 1; i <= 10; i += 1) {
      const event = world.aiUsageEvents[i - 1];
      expect(event.inputTokens).toBe(1000 * i);
      expect(event.outputTokens).toBe(200 * i);
      expect(event.chargedCredit.toString()).toBe(
        decimal('0.8').mul(i).toString(),
      );
      // THB cost: 1000i*100/1e6 + 200i*300/1e6 = 0.16i
      expect(event.costThb.toString()).toBe(
        decimal('0.16').mul(i).toString(),
      );
      expect(event.status).toBe('success');
      expect(event.pricingId).toBe('pricing-1');
    }

    // Sum over i=1..10 of 0.8i = 0.8 * 55 = 44 credits.
    expect(world.wallet.balanceCredit.toString()).toBe('956');
    expect(world.wallet.reservedCredit.toString()).toBe('0');
    expect(world.wallet.lifetimeSpentCredit.toString()).toBe('44');
    expect(world.budget.usedCredit.toString()).toBe('44');
    expect(world.budget.reservedCredit.toString()).toBe('0');

    // The ledger is a complete audit trail: one DEBIT per event, keyed by
    // turn, whose amounts sum to exactly the wallet movement.
    expect(world.ledger).toHaveLength(10);
    const ledgerTotal = world.ledger.reduce(
      (total, row) => total.plus(row.amountCredit),
      decimal(0),
    );
    expect(ledgerTotal.toString()).toBe('-44');
    world.ledger.forEach((row, index) => {
      expect(row.idempotencyKey).toContain(`evt-${index + 1}`);
      expect(row.usageEventId).toBe(world.aiUsageEvents[index].id);
    });
    // Running balanceAfterCredit chains correctly event to event.
    let running = decimal(1000);
    world.ledger.forEach((row) => {
      running = running.plus(row.amountCredit);
      expect(row.balanceAfterCredit.toString()).toBe(running.toString());
    });
  });

  it('bills cached tokens at the cached rate, not the full input rate', async () => {
    const world = createBillingWorld();

    // 800k non-cached input + 200k cached reads + 100k output:
    //   800000*500/1e6 + 200000*125/1e6 + 100000*1500/1e6 = 400 + 25 + 150
    await world.billingService.runBilled({
      kind: 'LINE_AI_REPLY',
      scopeKey: '*',
      provider: 'GEMINI',
      model: 'gemini-test',
      request: request('คำถามยาว'),
      turnId: 'evt-cached',
      call: () => Promise.resolve(response(usage(800_000, 100_000, 200_000))),
    });

    expect(world.aiUsageEvents[0].chargedCredit.toString()).toBe('575');
    expect(world.wallet.balanceCredit.toString()).toBe('425');
  });

  it('a provider failure mid-sequence is audited at zero credit and charges nothing', async () => {
    const world = createBillingWorld();

    await world.billingService.runBilled({
      kind: 'LINE_AI_REPLY',
      scopeKey: '*',
      provider: 'GEMINI',
      model: 'gemini-test',
      request: request('คำถามแรก'),
      turnId: 'evt-ok',
      call: () => Promise.resolve(response(usage(10_000, 2_000))),
    });

    await expect(
      world.billingService.runBilled({
        kind: 'LINE_AI_REPLY',
        scopeKey: '*',
        provider: 'GEMINI',
        model: 'gemini-test',
        request: request('คำถามที่พัง'),
        turnId: 'evt-broken',
        call: () => Promise.reject(new Error('provider down')),
      }),
    ).rejects.toThrow('provider down');

    // charge = 10000*500/1e6 + 2000*1500/1e6 = 5 + 3 = 8 credits
    expect(world.aiUsageEvents).toHaveLength(2);
    expect(world.aiUsageEvents[1].status).toBe('failed');
    expect(world.aiUsageEvents[1].chargedCredit.toString()).toBe('0');
    expect(world.ledger).toHaveLength(1);
    expect(world.wallet.balanceCredit.toString()).toBe('992');
    expect(world.wallet.reservedCredit.toString()).toBe('0');
    expect(world.budget.reservedCredit.toString()).toBe('0');
  });

  it('re-processing the same webhook event settles once, never double-charging', async () => {
    const world = createBillingWorld();
    const sameTurn = {
      kind: 'LINE_AI_REPLY' as const,
      scopeKey: '*',
      provider: 'GEMINI' as const,
      model: 'gemini-test',
      request: request('ราคาเท่าไหร่'),
      turnId: 'evt-retried',
      call: () => Promise.resolve(response(usage(10_000, 2_000))),
    };

    await world.billingService.runBilled(sameTurn);
    // BullMQ re-delivers the same webhook event: identical turnId + request
    // derive the same ledger idempotencyKey.
    await world.billingService.runBilled(sameTurn);

    expect(world.aiUsageEvents).toHaveLength(1);
    expect(world.ledger).toHaveLength(1);
    expect(world.wallet.balanceCredit.toString()).toBe('992');
    expect(world.wallet.reservedCredit.toString()).toBe('0');
    expect(world.budget.usedCredit.toString()).toBe('8');
    expect(world.budget.reservedCredit.toString()).toBe('0');
  });
});
