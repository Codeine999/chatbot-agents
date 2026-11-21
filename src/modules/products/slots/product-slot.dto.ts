import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { attributePatchValuesSchema } from '../attributes/dto/attribute-definition.dto';
import { daysBetween, isValidLocalDate, parseLocalDate } from './slot-time';

export const MAX_SLOTS_PER_COMMAND = 1000;

const localDate = z
  .string()
  .refine(isValidLocalDate, 'Use a real calendar date as YYYY-MM-DD');
const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm (24-hour, Asia/Bangkok)');
const instant = z.string().datetime({ offset: true });
const seats = z.number().int().min(0).max(1_000_000);
// Decimal strings, like variant prices: no floating point reaches the DB.
const money = z.string().regex(/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/);
/**
 * A round's own fare is written as a pair: price alone = exact, price with
 * maxPrice = an estimate within the two, price null = the variant's fare.
 */
function checkPricePair(
  row: { price?: string | null; maxPrice?: string | null },
  context: z.RefinementCtx,
) {
  if (row.maxPrice === undefined || row.maxPrice === null) return;
  if (row.price == null || Number(row.maxPrice) <= Number(row.price))
    context.addIssue({
      code: 'custom',
      path: ['maxPrice'],
      message: 'maxPrice requires price and must be greater than it',
    });
}
const version = z.number().int().min(1).max(2147483646);
const slotStatus = z.enum(['OPEN', 'CLOSED', 'CANCELLED']);

export const slotParamSchema = z
  .object({ id: z.string().uuid(), variantId: z.string().uuid() })
  .strict();
export class ProductSlotParamDto extends createZodDto(slotParamSchema) {}
export class ProductSlotIdParamDto extends createZodDto(
  slotParamSchema.extend({ slotId: z.string().uuid() }).strict(),
) {}

/** Weekly pattern expanded into real rows at write time. */
export const generateSlotsSchema = z
  .object({
    requestId: z.string().uuid(),
    /** ISO weekdays, 1 = Monday ... 7 = Sunday. */
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    /** Departure times in Asia/Bangkok. */
    times: z.array(timeOfDay).min(1).max(48),
    from: localDate,
    to: localDate,
    durationMin: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60)
      .nullable()
      .default(null),
    capacity: seats.nullable().default(null),
    /** Fare of every generated round; null = the variant's price applies. */
    price: money.nullable().default(null),
    maxPrice: money.nullable().default(null),
    meta: attributePatchValuesSchema.default({}),
  })
  .strict()
  .superRefine((data, context) => {
    checkPricePair(data, context);
    if (new Set(data.days).size !== data.days.length)
      context.addIssue({
        code: 'custom',
        path: ['days'],
        message: 'Duplicate day',
      });
    if (new Set(data.times).size !== data.times.length)
      context.addIssue({
        code: 'custom',
        path: ['times'],
        message: 'Duplicate time',
      });
    if (isValidLocalDate(data.from) && isValidLocalDate(data.to)) {
      const span = daysBetween(
        parseLocalDate(data.from),
        parseLocalDate(data.to),
      );
      if (span < 0)
        context.addIssue({
          code: 'custom',
          path: ['to'],
          message: 'to is before from',
        });
      if (span > 400)
        context.addIssue({
          code: 'custom',
          path: ['to'],
          message: 'At most 400 days',
        });
    }
  });
export class GenerateSlotsDto extends createZodDto(generateSlotsSchema) {}

const slotRow = z
  .object({
    startsAt: instant,
    endsAt: instant.nullable().optional(),
    capacity: seats.nullable().optional(),
    reserved: seats.optional(),
    status: slotStatus.optional(),
    /** Sent = the round's fare pair is replaced (maxPrice left out = exact). */
    price: money.nullable().optional(),
    maxPrice: money.nullable().optional(),
    meta: attributePatchValuesSchema.optional(),
  })
  .strict()
  .superRefine((row, context) => {
    checkPricePair(row, context);
    if (row.endsAt && Date.parse(row.endsAt) <= Date.parse(row.startsAt))
      context.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'endsAt must be after startsAt',
      });
  });
export const bulkSlotsSchema = z
  .object({
    requestId: z.string().uuid(),
    rows: z.array(slotRow).min(1).max(MAX_SLOTS_PER_COMMAND),
  })
  .strict()
  .superRefine((data, context) => {
    const keys = data.rows.map((row) => new Date(row.startsAt).getTime());
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: 'custom',
        path: ['rows'],
        message: 'Duplicate startsAt',
      });
  });
export class BulkSlotsDto extends createZodDto(bulkSlotsSchema) {}

export const patchSlotSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedVersion: version,
    status: slotStatus.optional(),
    capacity: seats.nullable().optional(),
    reserved: seats.optional(),
    endsAt: instant.nullable().optional(),
    /** Sent = the round's fare pair is replaced (maxPrice left out = exact). */
    price: money.nullable().optional(),
    maxPrice: money.nullable().optional(),
    meta: attributePatchValuesSchema.optional(),
  })
  .strict()
  .superRefine((data, context) => checkPricePair(data, context))
  .refine(
    (data) =>
      ['status', 'capacity', 'reserved', 'endsAt', 'price', 'meta'].some(
        (key) => (data as Record<string, unknown>)[key] !== undefined,
      ),
    'Nothing to change',
  );
export class PatchSlotDto extends createZodDto(patchSlotSchema) {}

export class ListSlotsQueryDto extends createZodDto(
  z
    .object({
      from: localDate.optional(),
      to: localDate.optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_SLOTS_PER_COMMAND)
        .default(200),
    })
    .strict(),
) {}
