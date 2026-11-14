import { z } from 'zod';

const declined = {
  askedAbout: z.string().optional(),
  directlyAnswered: z.boolean().optional(),
  answer: z.string().optional(),
  evidenceIds: z.array(z.string()).optional(),
  unanswered: z.array(z.string()).optional(),
};

export const groundedResponseSchema = z.discriminatedUnion('decision', [
  z.object({
    askedAbout: z.string().optional(),
    directlyAnswered: z.boolean(),
    decision: z.literal('ANSWER'),
    answer: z.string().trim().min(1),
    evidenceIds: z.array(z.string()).min(1),
    /** Questions in the message that the evidence does not answer. */
    unanswered: z.array(z.string()).optional(),
  }),
  z.object({ ...declined, decision: z.literal('INSUFFICIENT_CONTEXT') }),
  // Small talk that reached grounding on a chance vector hit.
  z.object({ ...declined, decision: z.literal('NOT_BUSINESS') }),
]);

// Provider syntax enforcement complements the stricter citation checks below.
// askedAbout/directlyAnswered come first so the model judges coverage before
// it writes an answer; a related substitute must not pass as the answer.
// Strict mode needs every property listed in `required`.
export const GROUNDED_JSON_SCHEMA = {
  type: 'object',
  properties: {
    askedAbout: { type: 'string' },
    directlyAnswered: { type: 'boolean' },
    decision: {
      type: 'string',
      enum: ['ANSWER', 'INSUFFICIENT_CONTEXT', 'NOT_BUSINESS'],
    },
    answer: { type: 'string' },
    evidenceIds: { type: 'array', items: { type: 'string' } },
    unanswered: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'askedAbout',
    'directlyAnswered',
    'decision',
    'answer',
    'evidenceIds',
    'unanswered',
  ],
  additionalProperties: false,
} as const;

export type GroundedResponse = z.infer<typeof groundedResponseSchema>;
