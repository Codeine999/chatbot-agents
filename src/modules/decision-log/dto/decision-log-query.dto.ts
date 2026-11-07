import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { DECISION_ANSWER_TYPES } from '../types/decision-log.types';

/** Empty query-string values mean "not sent". */
const blank = (value: unknown) =>
  value === null || value === '' ? undefined : value;

const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(blank, schema.optional());

/** `z.coerce.boolean()` reads "false" as true, so booleans are parsed explicitly. */
const queryBoolean = optional(
  z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1'),
);

/**
 * Parsed to a Date for the query, but the wire type stays a string: a `Date`
 * in a request DTO cannot be published in the OpenAPI document at boot.
 */
const instant = z
  .string()
  .trim()
  .transform((value) => new Date(value))
  .refine((date) => !Number.isNaN(date.getTime()), 'Invalid date');

const filterShape = {
  from: optional(instant),
  to: optional(instant),
  answerType: optional(z.enum(DECISION_ANSWER_TYPES)),
  isFallback: queryBoolean,
};

export class ListDecisionLogsQueryDto extends createZodDto(
  z.object({
    ...filterShape,
    conversationId: optional(z.string().uuid()),
    eventId: optional(z.string().trim().min(1).max(255)),
    userId: optional(z.string().trim().min(1).max(100)),
    action: optional(z.string().trim().min(1).max(40)),
    fallbackReason: optional(z.string().trim().min(1).max(60)),
    /** Rows strictly older than this row id (keyset pagination). */
    cursor: optional(z.string().uuid()),
    limit: z.preprocess(
      blank,
      z.coerce.number().int().min(1).max(100).default(20),
    ),
  }),
) {}

export class DecisionLogSummaryQueryDto extends createZodDto(
  z.object({
    ...filterShape,
    /** Histogram bucket width for the vector-similarity distribution. */
    bucket: z.preprocess(
      blank,
      z.coerce.number().min(0.01).max(0.25).default(0.05),
    ),
  }),
) {}

export class DecisionLogIdParamDto extends createZodDto(
  z.object({ id: z.string().uuid() }).strict(),
) {}
