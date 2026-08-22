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
    $transaction: jest.fn().mockImplementation((work) => work(tx)),
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
});
