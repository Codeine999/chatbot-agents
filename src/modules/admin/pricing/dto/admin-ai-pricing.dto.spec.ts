import { z } from 'zod';
import {
  ListAiModelPricingQueryDto,
  UpsertAiModelPricingDto,
} from './admin-ai-pricing.dto';

const BASE_BODY = {
  provider: 'ANTHROPIC',
  model: 'model-a',
  inputCostThbPerMillTokens: '80',
  outputCostThbPerMillTokens: '400',
  inputCreditPerMillTokens: '100',
  outputCreditPerMillTokens: '500',
};

describe('AI pricing DTO schemas', () => {
  it('stays representable in the OpenAPI document the app publishes', () => {
    // Bootstrap runs cleanupOpenApiDoc() over every DTO. `createZodDto` emits
    // request schemas with io: "input", and a `Date` there — from
    // z.coerce.date() — throws "Date cannot be represented in JSON Schema",
    // killing the app before it can listen. Transforms are fine in this mode;
    // only the opt-in `.Output` variant would reject them.
    expect(() =>
      z.toJSONSchema(UpsertAiModelPricingDto.schema, { io: 'input' }),
    ).not.toThrow();
    expect(() =>
      z.toJSONSchema(ListAiModelPricingQueryDto.schema, { io: 'input' }),
    ).not.toThrow();
  });

  it('reads includeExpired=false as false', () => {
    // z.coerce.boolean() runs JS Boolean(), which reads "false" as true.
    expect(
      ListAiModelPricingQueryDto.schema.parse({ includeExpired: 'false' }),
    ).toMatchObject({ includeExpired: false });
    expect(
      ListAiModelPricingQueryDto.schema.parse({ includeExpired: '0' }),
    ).toMatchObject({ includeExpired: false });
    expect(
      ListAiModelPricingQueryDto.schema.parse({ includeExpired: 'true' }),
    ).toMatchObject({ includeExpired: true });
    expect(ListAiModelPricingQueryDto.schema.parse({})).toMatchObject({
      includeExpired: false,
    });
  });

  it('accepts an ISO instant for effectiveFrom and rejects a loose date', () => {
    expect(
      UpsertAiModelPricingDto.schema.parse({
        ...BASE_BODY,
        effectiveFrom: '2026-08-23T00:00:00.000Z',
      }).effectiveFrom,
    ).toBe('2026-08-23T00:00:00.000Z');

    expect(() =>
      UpsertAiModelPricingDto.schema.parse({
        ...BASE_BODY,
        effectiveFrom: '2026-08-23',
      }),
    ).toThrow();
  });

  it('keeps rates as exact strings and rejects a malformed one', () => {
    const parsed = UpsertAiModelPricingDto.schema.parse({
      ...BASE_BODY,
      inputCreditPerMillTokens: 0.1,
    });

    // Rates must reach Prisma.Decimal as text, never as a float.
    expect(parsed.inputCreditPerMillTokens).toBe('0.1');

    expect(() =>
      UpsertAiModelPricingDto.schema.parse({
        ...BASE_BODY,
        inputCreditPerMillTokens: '-5',
      }),
    ).toThrow();
    expect(() =>
      UpsertAiModelPricingDto.schema.parse({
        ...BASE_BODY,
        inputCreditPerMillTokens: '1.1234567',
      }),
    ).toThrow();
  });
});
