import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const answerPatternFields = {
  title: z.string().trim().min(1).max(255),
  description: z.string().trim().max(20_000).nullable().optional(),
  category: z.string().trim().max(100).nullable().optional(),
  intentKey: z.string().trim().max(100).nullable().optional(),
  keywords: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  questionExamples: z
    .array(z.string().trim().min(1).max(2_000))
    .max(100)
    .default([]),
  answer: z.string().trim().min(1).max(50_000),
  priority: z.number().int().min(0).max(100).default(0),
  active: z.boolean().default(true),
} as const;

const createAnswerPatternSchema = z.object(answerPatternFields);

export class CreateAdminAnswerPatternDto extends createZodDto(
  createAnswerPatternSchema,
) {}

export class UpdateAdminAnswerPatternDto extends createZodDto(
  createAnswerPatternSchema
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
