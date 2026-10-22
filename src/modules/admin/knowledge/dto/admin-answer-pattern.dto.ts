import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const languageSchema = z.preprocess(
  (value) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(1).max(10).default('th'),
);

const answerPatternFields = {
  title: z.string().trim().min(1).max(255),
  description: z.string().trim().max(20_000).nullable().optional(),
  category: z.string().trim().max(100).nullable().optional(),
  intentKey: z.string().trim().max(100).nullable().optional(),
  keywords: z.array(z.string().trim().min(1).max(100)).max(100),
  questionExamples: z.array(z.string().trim().min(1).max(2_000)).max(100),
  answer: z.string().trim().min(1).max(50_000),
  language: languageSchema,
  renderMode: z.enum(['DIRECT', 'REWRITE']),
  priority: z.number().int().min(0).max(100),
  active: z.boolean(),
} as const;

export const createAnswerPatternSchema = z.object({
  ...answerPatternFields,
  keywords: answerPatternFields.keywords.default([]),
  questionExamples: answerPatternFields.questionExamples.default([]),
  renderMode: answerPatternFields.renderMode.default('DIRECT'),
  priority: answerPatternFields.priority.default(0),
  active: answerPatternFields.active.default(true),
});

export class CreateAdminAnswerPatternDto extends createZodDto(
  createAnswerPatternSchema,
) {}

/** Every item is embedded one by one, so the batch stays small. */
export const MAX_BULK_ANSWER_PATTERNS = 100;

export class CreateAdminAnswerPatternBulkDto extends createZodDto(
  z.array(createAnswerPatternSchema).min(1).max(MAX_BULK_ANSWER_PATTERNS),
) {}

const updateAnswerPatternSchema = z
  .object({
    ...answerPatternFields,
    // Unlike creation, a PATCH must not supply the default language when it
    // was omitted; otherwise updating one field would reset it to `th`.
    language: z.string().trim().min(1).max(10).optional(),
    /** Appends values without replacing the current keyword list. */
    addKeywords: answerPatternFields.keywords.optional(),
    /** Removes matching values without replacing the current keyword list. */
    removeKeywords: answerPatternFields.keywords.optional(),
  })
  .partial()
  .superRefine((value, context) => {
    if (Object.keys(value).length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'At least one field is required',
      });
    }

    if (
      value.keywords !== undefined &&
      (value.addKeywords !== undefined || value.removeKeywords !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['keywords'],
        message:
          'Use either keywords to replace the list, or addKeywords/removeKeywords to change individual values',
      });
    }
  });

export class UpdateAdminAnswerPatternDto extends createZodDto(
  updateAnswerPatternSchema,
) {}

export class AdminAnswerPatternIdParamDto extends createZodDto(
  z.object({
    id: z.string().uuid(),
  }),
) {}
