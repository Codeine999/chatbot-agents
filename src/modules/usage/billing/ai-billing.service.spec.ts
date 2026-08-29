/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Prisma } from '../../../generated/prisma/client';
import type {
  AiGenerateResponse,
  AiTokenUsage,
} from '../../../ai-provider/types/ai-provider.types';
import type { RecordAiUsageInput } from '../credit-point/credit.service';
import { CreditHold, CreditService } from '../credit-point/credit.service';
import { InsufficientCreditException } from '../credit-point/insufficient-credit.exception';
import { AiBillingService, BilledGenerationParams } from './ai-billing.service';
import { AiPricingService } from './ai-pricing.service';

const decimal = (value: string | number) => new Prisma.Decimal(value);

const HOLD: CreditHold = {
  id: 'hold-1',
  companyId: 'company-1',
  walletId: 'wallet-1',
  budgetId: 'budget-1',
  amountCredit: decimal('1.5'),
};

const USAGE: AiTokenUsage = {
  inputTokens: 400,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 120,
};

function createContext(
  overrides: {
    reserve?: jest.Mock;
    calculate?: jest.Mock;
    recordAiUsage?: jest.Mock;
  } = {},
) {
  const reserveAiCredit =
    overrides.reserve ?? jest.fn().mockResolvedValue(HOLD);
  const recordAiUsage =
    overrides.recordAiUsage ??
    jest.fn().mockResolvedValue({
      usageEventId: 'event-1',
      chargedCredit: decimal('0.3'),
      balanceAfterCredit: decimal('99.7'),
    });
  const releaseAiCredit = jest.fn().mockResolvedValue(undefined);
  const estimateReservationCredit = jest.fn().mockResolvedValue(decimal('1.5'));
  const calculate =
    overrides.calculate ??
    jest.fn().mockResolvedValue({
      costThb: decimal('0.24'),
      chargedCredit: decimal('0.3'),
      pricingId: 'pricing-1',
    });

  const creditService = {
    reserveAiCredit,
    recordAiUsage,
    releaseAiCredit,
  } as unknown as CreditService;
  const pricingService = {
    estimateReservationCredit,
    calculate,
  } as unknown as AiPricingService;

  return {
    service: new AiBillingService(creditService, pricingService),
    reserveAiCredit,
    recordAiUsage,
    releaseAiCredit,
    estimateReservationCredit,
    calculate,
  };
}

function params(
  override: Partial<BilledGenerationParams> = {},
): BilledGenerationParams {
  const response: AiGenerateResponse = {
    text: 'ok',
    provider: 'ANTHROPIC',
    model: 'model-a',
    usage: USAGE,
    providerRequestId: 'req-1',
  };

  return {
    kind: 'LINE_AI_REPLY',
    provider: 'ANTHROPIC',
    model: 'model-a',
    request: { messages: [{ role: 'user', text: 'ราคาเท่าไหร่' }] },
    call: jest.fn().mockResolvedValue(response),
    ...override,
  };
}

describe('AiBillingService.runBilled', () => {
  it('reserves before the provider call and settles the actual counters', async () => {
    const context = createContext();
    const call = jest.fn().mockResolvedValue({
      text: 'ok',
      provider: 'ANTHROPIC',
      model: 'model-a',
      usage: USAGE,
    });

    await context.service.runBilled(params({ call }));

    // The hold must exist before any money is spent at the provider.
    expect(context.reserveAiCredit.mock.invocationCallOrder[0]).toBeLessThan(
      call.mock.invocationCallOrder[0],
    );
    expect(context.calculate).toHaveBeenCalledWith(
      'ANTHROPIC',
      'model-a',
      USAGE,
    );

    const settlement = context.recordAiUsage.mock
      .calls[0][0] as RecordAiUsageInput;
    expect(settlement.status).toBe('success');
    expect(settlement.usage).toEqual(USAGE);
    expect(settlement.cost.chargedCredit.toString()).toBe('0.3');
    expect(settlement.reservation).toBe(HOLD);
  });

  it('bills the provider and model the response actually came back from', async () => {
    const context = createContext();
    const call = jest.fn().mockResolvedValue({
      text: 'ok',
      provider: 'GEMINI',
      model: 'fallback-model',
      usage: USAGE,
    });

    await context.service.runBilled(params({ call }));

    const settlement = context.recordAiUsage.mock
      .calls[0][0] as RecordAiUsageInput;
    expect(settlement.provider).toBe('GEMINI');
    expect(settlement.model).toBe('fallback-model');
  });

  it('records a failed call at zero credit and still frees the hold', async () => {
    const context = createContext();
    const call = jest.fn().mockRejectedValue(new Error('boom'));

    await expect(context.service.runBilled(params({ call }))).rejects.toThrow(
      'boom',
    );

    const settlement = context.recordAiUsage.mock
      .calls[0][0] as RecordAiUsageInput;
    expect(settlement.status).toBe('failed');
    expect(settlement.cost.chargedCredit.toString()).toBe('0');
    expect(settlement.usage).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    });
    expect(settlement.errorCode).toBe('Error');
  });

  it('never calls the provider when the wallet cannot cover the reservation', async () => {
    const context = createContext({
      reserve: jest
        .fn()
        .mockRejectedValue(new InsufficientCreditException('no credit')),
    });
    const call = jest.fn();

    await expect(
      context.service.runBilled(params({ call })),
    ).rejects.toBeInstanceOf(InsufficientCreditException);

    expect(call).not.toHaveBeenCalled();
    expect(context.recordAiUsage).not.toHaveBeenCalled();
  });

  it('releases the hold when settlement itself fails, rather than stranding it', async () => {
    const context = createContext({
      recordAiUsage: jest.fn().mockRejectedValue(new Error('db down')),
    });

    // The answer is already produced and paid for upstream; billing trouble
    // must not lose the reply.
    await expect(context.service.runBilled(params())).resolves.toMatchObject({
      text: 'ok',
    });
    expect(context.releaseAiCredit).toHaveBeenCalledWith(HOLD);
  });

  it('flags a settled call whose model had no price, so free spend is queryable', async () => {
    const context = createContext({
      calculate: jest.fn().mockResolvedValue({
        costThb: decimal(0),
        chargedCredit: decimal(0),
        pricingId: null,
      }),
    });

    await context.service.runBilled(params());

    const settlement = context.recordAiUsage.mock
      .calls[0][0] as RecordAiUsageInput;
    expect(settlement.errorCode).toBe('MISSING_PRICING');
  });
});

describe('AiBillingService ledger idempotency', () => {
  const keyFor = async (override: Partial<BilledGenerationParams>) => {
    const context = createContext();
    await context.service.runBilled(params(override));
    return (context.recordAiUsage.mock.calls[0][0] as RecordAiUsageInput)
      .idempotencyKey;
  };

  it('derives the same key when the same turn is processed again', async () => {
    const first = await keyFor({ turnId: 'event-1' });
    const second = await keyFor({ turnId: 'event-1' });

    expect(first).toBe(second);
    expect(first).toContain('event-1');
  });

  it('separates the sibling calls of one turn', async () => {
    // A single inbound message bills the classifier and the grounded answer.
    const classifier = await keyFor({
      turnId: 'event-1',
      request: { messages: [{ role: 'user', text: 'classify this' }] },
    });
    const answer = await keyFor({
      turnId: 'event-1',
      request: { messages: [{ role: 'user', text: 'answer this' }] },
    });

    expect(classifier).not.toBe(answer);
  });

  it('separates the same prompt sent in two different turns', async () => {
    expect(await keyFor({ turnId: 'event-1' })).not.toBe(
      await keyFor({ turnId: 'event-2' }),
    );
  });

  it('lets an explicit key win over the derived one', async () => {
    expect(await keyFor({ turnId: 'event-1', idempotencyKey: 'manual' })).toBe(
      'manual',
    );
  });

  it('leaves the key unset when there is no turn to key on', async () => {
    expect(await keyFor({})).toBeUndefined();
  });
});
