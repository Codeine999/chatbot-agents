/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { ConfigService } from '@nestjs/config';
import { Prisma, UsageKind } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CompanyService } from '../../admin/company/company.service';
import { ZERO_AI_USAGE_COST } from '../billing/ai-usage.types';
import { CreditService } from './credit.service';
import { InsufficientCreditException } from './insufficient-credit.exception';

const decimal = (value: string | number) => new Prisma.Decimal(value);

function createContext() {
  const wallet = {
    id: '00000000-0000-0000-0000-000000000001',
    active: true,
    balanceCredit: decimal(100),
    reservedCredit: decimal(0),
    lifetimeTopupCredit: decimal(100),
    lifetimeSpentCredit: decimal(0),
  };
  const budget = {
    id: '00000000-0000-0000-0000-000000000002',
    limitCredit: null as Prisma.Decimal | null,
    usedCredit: decimal(0),
    reservedCredit: decimal(0),
  };
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
      findUniqueOrThrow: jest.fn().mockImplementation(() => wallet),
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
      findUniqueOrThrow: jest.fn().mockImplementation(() => budget),
      update: jest.fn().mockImplementation(({ data }) => {
        for (const field of ['reservedCredit', 'usedCredit'] as const) {
          if (data[field])
            budget[field] = applyUpdate(budget[field], data[field]);
        }
        return budget;
      }),
    },
    aiUsageEvent: { create: jest.fn() },
    creditLedger: { create: jest.fn() },
  };
  const prisma = {
    creditWallet: {
      findUnique: jest.fn().mockImplementation(() => wallet),
      upsert: jest.fn(),
    },
    creditBudget: {
      findUnique: jest.fn().mockImplementation(() => budget),
      upsert: jest.fn(),
    },
    // Roll back on failure the way Postgres does, so a test can tell a
    // committed settlement apart from one that threw halfway through.
    $transaction: jest.fn().mockImplementation(async (work) => {
      const walletBefore = { ...wallet };
      const budgetBefore = { ...budget };

      try {
        return await work(tx);
      } catch (error) {
        Object.assign(wallet, walletBefore);
        Object.assign(budget, budgetBefore);
        throw error;
      }
    }),
  } as unknown as PrismaService;
  const companyService = {
    getCompanyId: jest
      .fn()
      .mockResolvedValue('00000000-0000-0000-0000-000000000003'),
  } as unknown as CompanyService;
  const configService = {
    get: jest.fn().mockReturnValue(undefined),
  } as unknown as ConfigService;

  return {
    service: new CreditService(prisma, companyService, configService),
    prisma,
    tx,
    wallet,
    budget,
  };
}

describe('CreditService credit gate', () => {
  it('prevents a second request from reserving the same available credit', async () => {
    const context = createContext();
    for (let index = 0; index < 8; index += 1) {
      await context.service.reserveAiCredit(
        UsageKind.LINE_AI_REPLY,
        '*',
        decimal(10),
      );
    }

    await expect(
      context.service.reserveAiCredit(
        UsageKind.LINE_AI_REPLY,
        '*',
        decimal(10),
      ),
    ).rejects.toBeInstanceOf(InsufficientCreditException);
    expect(context.wallet.reservedCredit.toString()).toBe('80');
    expect(context.budget.reservedCredit.toString()).toBe('80');
  });

  it('settles actual usage and releases the full hold', async () => {
    const context = createContext();
    const reservation = await context.service.reserveAiCredit(
      UsageKind.LINE_AI_REPLY,
      '*',
      decimal(15),
    );
    await context.service.recordAiUsage({
      reservation,
      kind: UsageKind.LINE_AI_REPLY,
      provider: 'OPENAI',
      model: 'gpt-test',
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 10,
      },
      cost: {
        pricingId: null,
        costThb: decimal(1),
        chargedCredit: decimal(12),
      },
      status: 'success',
    });

    expect(context.wallet.balanceCredit.toString()).toBe('88');
    expect(context.wallet.reservedCredit.toString()).toBe('0');
    expect(context.budget.usedCredit.toString()).toBe('12');
    expect(context.budget.reservedCredit.toString()).toBe('0');
  });

  it('releases the hold without charging after a provider failure', async () => {
    const context = createContext();
    const reservation = await context.service.reserveAiCredit(
      UsageKind.LINE_AI_REPLY,
      '*',
      decimal(15),
    );
    await context.service.recordAiUsage({
      reservation,
      kind: UsageKind.LINE_AI_REPLY,
      provider: 'OPENAI',
      model: 'gpt-test',
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      },
      cost: ZERO_AI_USAGE_COST,
      status: 'failed',
    });

    expect(context.wallet.balanceCredit.toString()).toBe('100');
    expect(context.wallet.reservedCredit.toString()).toBe('0');
    expect(context.budget.usedCredit.toString()).toBe('0');
    expect(context.budget.reservedCredit.toString()).toBe('0');
  });

  it('debits once and frees the hold when the same usage settles twice', async () => {
    const context = createContext();
    const settled = {
      usageEventId: '00000000-0000-0000-0000-0000000000ee',
      amountCredit: decimal(-12),
      balanceAfterCredit: decimal(88),
    };

    // First settlement: the real debit.
    const first = await context.service.reserveAiCredit(
      UsageKind.LINE_AI_REPLY,
      '*',
      decimal(15),
    );
    await context.service.recordAiUsage({
      reservation: first,
      kind: UsageKind.LINE_AI_REPLY,
      provider: 'OPENAI',
      model: 'gpt-test',
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 10,
      },
      cost: {
        pricingId: null,
        costThb: decimal(1),
        chargedCredit: decimal(12),
      },
      status: 'success',
      idempotencyKey: 'usage:event-1:abc',
    });

    // Replay: the unique ledger key rejects the second write, and the
    // transaction that would have released the hold rolls back with it.
    const duplicate = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test',
    });
    context.tx.creditLedger.create.mockRejectedValueOnce(duplicate);
    (context.prisma as any).creditLedger = {
      findUnique: jest.fn().mockResolvedValue(settled),
    };

    const second = await context.service.reserveAiCredit(
      UsageKind.LINE_AI_REPLY,
      '*',
      decimal(15),
    );

    const replay = await context.service.recordAiUsage({
      reservation: second,
      kind: UsageKind.LINE_AI_REPLY,
      provider: 'OPENAI',
      model: 'gpt-test',
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 10,
      },
      cost: {
        pricingId: null,
        costThb: decimal(1),
        chargedCredit: decimal(12),
      },
      status: 'success',
      idempotencyKey: 'usage:event-1:abc',
    });

    expect(replay.usageEventId).toBe(settled.usageEventId);
    expect(replay.chargedCredit.toString()).toBe('12');

    // Charged once, and the replay's hold is handed back instead of being
    // stranded on the wallet by the rolled-back transaction.
    expect(context.wallet.balanceCredit.toString()).toBe('88');
    expect(context.wallet.reservedCredit.toString()).toBe('0');
    expect(context.budget.reservedCredit.toString()).toBe('0');
  });
});
