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
  priority: z.number().int().min(0).max(100),
  active: z.boolean(),
} as const;

const createAnswerPatternSchema = z.object({
  ...answerPatternFields,
  keywords: answerPatternFields.keywords.default([]),
  questionExamples: answerPatternFields.questionExamples.default([]),
  priority: answerPatternFields.priority.default(0),
  active: answerPatternFields.active.default(true),
});

export class CreateAdminAnswerPatternDto extends createZodDto(
  createAnswerPatternSchema,
) {}

export class UpdateAdminAnswerPatternDto extends createZodDto(
  z
    .object(answerPatternFields)
    .partial()
    .refine((value) => Object.keys(value).length > 0, {
      message: 'At least one field is required',
    }),
) {}

export class AdminAnswerPatternIdParamDto extends createZodDto(
  z.object({
    id: z.string().uuid(),
  }),
) {}
