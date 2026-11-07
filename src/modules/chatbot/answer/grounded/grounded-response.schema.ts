import { z } from 'zod';

export const groundedResponseSchema = z.discriminatedUnion('decision', [
  z.object({
    askedAbout: z.string().optional(),
    directlyAnswered: z.boolean(),
    decision: z.literal('ANSWER'),
    answer: z.string().trim().min(1),
    evidenceIds: z.array(z.string()).min(1),
  }),
  z.object({
    askedAbout: z.string().optional(),
    directlyAnswered: z.boolean().optional(),
    decision: z.literal('INSUFFICIENT_CONTEXT'),
    answer: z.string().optional(),
    evidenceIds: z.array(z.string()).optional(),
  }),
]);

// Provider syntax enforcement complements the stricter citation checks below.
// askedAbout/directlyAnswered come first so the model judges coverage before
// it writes an answer; a related substitute must not pass as the answer.
export const GROUNDED_JSON_SCHEMA = {
  type: 'object',
  properties: {
    askedAbout: { type: 'string' },
    directlyAnswered: { type: 'boolean' },
    decision: { type: 'string', enum: ['ANSWER', 'INSUFFICIENT_CONTEXT'] },
    answer: { type: 'string' },
    evidenceIds: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'askedAbout',
    'directlyAnswered',
    'decision',
    'answer',
    'evidenceIds',
  ],
  additionalProperties: false,
} as const;

export type GroundedResponse = z.infer<typeof groundedResponseSchema>;
