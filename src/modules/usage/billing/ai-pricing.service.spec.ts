import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AiPricingService } from './ai-pricing.service';

const decimal = (value: string | number) => new Prisma.Decimal(value);

/** 100 credits per million in, 500 per million out; cache reads at a tenth. */
const PRICING_ROW = {
  id: 'pricing-1',
  inputCostThbPerMillTokens: decimal(80),
  outputCostThbPerMillTokens: decimal(400),
  cachedInputCostThbPerMillTokens: decimal(8),
  cacheWriteCostThbPerMillTokens: decimal(100),
  inputCreditPerMillTokens: decimal(100),
  outputCreditPerMillTokens: decimal(500),
  cachedInputCreditPerMillTokens: decimal(10),
  cacheWriteCreditPerMillTokens: decimal(125),
};

type PricingWhere = { where: { effectiveFrom: unknown; OR: unknown } };

function createService(row: unknown = PRICING_ROW) {
  const findFirst = jest
    .fn<Promise<unknown>, [PricingWhere]>()
    .mockResolvedValue(row);
  const prisma = {
    aiModelPricing: { findFirst },
  } as unknown as PrismaService;

  return { service: new AiPricingService(prisma), findFirst };
}

describe('AiPricingService.calculate', () => {
  it('prices every token bucket from the actual provider counters', async () => {
    const { service } = createService();

    const cost = await service.calculate('ANTHROPIC', 'model-a', {
      inputTokens: 10_000,
      cachedInputTokens: 200_000,
      cacheWriteTokens: 8_000,
      outputTokens: 2_000,
    });

    // 10k*100 + 200k*10 + 8k*125 + 2k*500 = 1M + 2M + 1M + 1M per million
    expect(cost.chargedCredit.toString()).toBe('5');
    expect(cost.costThb.toString()).toBe('4');
    expect(cost.pricingId).toBe('pricing-1');
  });

  it('charges the normal input rate when a cache rate is unconfigured', async () => {
    const { service } = createService({
      ...PRICING_ROW,
      cachedInputCreditPerMillTokens: null,
      cacheWriteCreditPerMillTokens: null,
      cachedInputCostThbPerMillTokens: null,
      cacheWriteCostThbPerMillTokens: null,
    });

    const cost = await service.calculate('OPENAI', 'model-b', {
      inputTokens: 0,
      cachedInputTokens: 100_000,
      cacheWriteTokens: 100_000,
      outputTokens: 0,
    });

    // An unconfigured discount must not give the tokens away for free.
    expect(cost.chargedCredit.toString()).toBe('20');
  });

  it('records usage uncharged when the model has no active price', async () => {
    const { service } = createService(null);

    const cost = await service.calculate('GEMINI', 'unpriced-model', {
      inputTokens: 5_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000,
    });

    expect(cost.chargedCredit.toString()).toBe('0');
    expect(cost.pricingId).toBeNull();
  });

  it('keeps credit arithmetic exact instead of drifting through a float', async () => {
    const { service } = createService({
      ...PRICING_ROW,
      inputCreditPerMillTokens: decimal('0.1'),
      outputCreditPerMillTokens: decimal('0.2'),
    });

    const cost = await service.calculate('GEMINI', 'model-c', {
      inputTokens: 1_234_567,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 7_654_321,
    });

    // 1234567*0.1/1e6 + 7654321*0.2/1e6, exact to the last digit.
    expect(cost.chargedCredit.toString()).toBe('1.654321');
  });

  it('settles at the six-decimal scale of the credit column', async () => {
    const { service } = createService({
      ...PRICING_ROW,
      inputCreditPerMillTokens: decimal('0.1'),
      outputCreditPerMillTokens: decimal('0.2'),
    });

    const cost = await service.calculate('GEMINI', 'model-c', {
      inputTokens: 3,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 3,
    });

    // 0.0000009 rounds to the Decimal(20,6) scale the wallet is stored at.
    expect(cost.chargedCredit.toString()).toBe('0.000001');
  });

  it('selects the price active at the moment of the call', async () => {
    const { service, findFirst } = createService();
    const at = new Date('2026-08-23T10:00:00.000Z');

    await service.calculate(
      'GEMINI',
      'model-c',
      {
        inputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      },
      at,
    );

    const { where } = findFirst.mock.calls[0][0];
    expect(where.effectiveFrom).toEqual({ lte: at });
    expect(where.OR).toEqual([
      { effectiveTo: null },
      { effectiveTo: { gt: at } },
    ]);
  });
});

describe('AiPricingService.estimateReservationCredit', () => {
  it('holds at least what the call is later charged', async () => {
    const { service } = createService();
    const request = {
      systemInstruction: 'ตอบคำถามลูกค้าอย่างสุภาพและกระชับ',
      messages: [{ role: 'user' as const, text: 'ค่าสมัครสมาชิกเท่าไหร่ครับ' }],
      maxOutputTokens: 500,
    };

    const reserved = await service.estimateReservationCredit(
      'ANTHROPIC',
      'model-a',
      request,
    );

    // Realistic settlement for that prompt: well under the reservation.
    const actual = await service.calculate('ANTHROPIC', 'model-a', {
      inputTokens: 400,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 200,
    });

    expect(reserved.greaterThanOrEqualTo(actual.chargedCredit)).toBe(true);
  });

  it('holds the most expensive input rate so a cache bucket cannot overrun it', async () => {
    const { service } = createService({
      ...PRICING_ROW,
      inputCreditPerMillTokens: decimal(10),
      cacheWriteCreditPerMillTokens: decimal(1_000),
    });

    const reserved = await service.estimateReservationCredit(
      'ANTHROPIC',
      'model-a',
      { messages: [{ role: 'user', text: 'x' }], maxOutputTokens: 0 },
    );

    // 257 estimated input tokens priced at the 1000/M cache-write rate.
    expect(reserved.greaterThan(decimal('0.25'))).toBe(true);
  });

  it('reserves nothing for a model that has no price to charge against', async () => {
    const { service } = createService(null);

    const reserved = await service.estimateReservationCredit(
      'GEMINI',
      'unpriced-model',
      { messages: [{ role: 'user', text: 'x' }] },
    );

    expect(reserved.toString()).toBe('0');
  });

  it('does not hold megabyte-scale credit for one photo', async () => {
    const { service } = createService();

    const reserved = await service.estimateReservationCredit(
      'ANTHROPIC',
      'model-a',
      {
        messages: [
          {
            role: 'user',
            text: 'นี่รูปอะไร',
            images: [
              { mediaType: 'image/jpeg', data: 'A'.repeat(4 * 1024 * 1024) },
            ],
          },
        ],
        maxOutputTokens: 500,
      },
    );

    // Before the per-image ceiling this reserved hundreds of credits and
    // bounced the message as insufficient credit on a funded wallet.
    expect(reserved.lessThan(decimal(2))).toBe(true);
  });
});
