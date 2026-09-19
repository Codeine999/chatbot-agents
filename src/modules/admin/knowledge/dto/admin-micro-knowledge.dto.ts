import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const languageSchema = z.preprocess(
  (value) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(1).max(10).default('th'),
);

const microKnowledgeFields = {
  title: z.string().trim().min(1).max(255),
  description: z.string().trim().max(20_000).nullable().optional(),
  category: z.string().trim().max(100).nullable().optional(),
  intentKey: z.string().trim().max(100).nullable().optional(),
  entityKey: z.string().trim().max(50).nullable().optional(),
  topicKey: z.string().trim().max(50).nullable().optional(),
  keywords: z.array(z.string().trim().min(1).max(100)).max(100),
  questionExamples: z.array(z.string().trim().min(1).max(2_000)).max(100),
  answer: z.string().trim().min(1).max(50_000),
  language: languageSchema,
  priority: z.number().int().min(0).max(100),
  active: z.boolean(),
} as const;

const createMicroKnowledgeSchema = z.object({
  ...microKnowledgeFields,
  keywords: microKnowledgeFields.keywords.default([]),
  questionExamples: microKnowledgeFields.questionExamples.default([]),
  priority: microKnowledgeFields.priority.default(0),
  active: microKnowledgeFields.active.default(true),
});

export class CreateAdminMicroKnowledgeDto extends createZodDto(
  createMicroKnowledgeSchema,
) {}

const updateMicroKnowledgeSchema = z
  .object({
    ...microKnowledgeFields,
    language: z.string().trim().min(1).max(10).optional(),
    addKeywords: microKnowledgeFields.keywords.optional(),
    removeKeywords: microKnowledgeFields.keywords.optional(),
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

export class UpdateAdminMicroKnowledgeDto extends createZodDto(
  updateMicroKnowledgeSchema,
) {}

export class AdminMicroKnowledgeIdParamDto extends createZodDto(
  z.object({
    id: z.string().uuid(),
  }),
) {}
