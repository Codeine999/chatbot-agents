import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  aiResponseStyleSchema,
  aiSkillsSchema,
} from '../../../ai/ai-setting/ai-setting-config';

const aiSettingFields = {
  tenantId: z.string().uuid().nullable(),
  systemPrompt: z.string().trim().min(1).max(50_000),
  ownerPrompt: z.string().trim().max(50_000).nullable(),
  tone: z.string().trim().max(10_000).nullable(),
  skills: aiSkillsSchema,
  responseStyle: aiResponseStyleSchema,
  promptVersion: z.number().int().min(1).max(2_147_483_647),
  fallbackMessage: z.string().trim().max(50_000).nullable(),
  active: z.boolean(),
} as const;

const createAiSettingSchema = z
  .object({
    tenantId: aiSettingFields.tenantId.optional(),
    systemPrompt: aiSettingFields.systemPrompt.optional(),
    ownerPrompt: aiSettingFields.ownerPrompt.optional(),
    tone: aiSettingFields.tone.optional(),
    skills: aiSettingFields.skills.default([]),
    responseStyle: aiSettingFields.responseStyle.default({
      targetLength: 'adaptive',
      emojiLevel: 'light',
    }),
    promptVersion: aiSettingFields.promptVersion.default(1),
    fallbackMessage: aiSettingFields.fallbackMessage.optional(),
    active: aiSettingFields.active.default(true),
  })
  .strict();

export class CreateAdminAiSettingDto extends createZodDto(
  createAiSettingSchema,
) {}

const updateAiSettingSchema = z
  .object(aiSettingFields)
  .partial()
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value).length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'At least one field is required',
      });
    }
  });

export class UpdateAdminAiSettingDto extends createZodDto(
  updateAiSettingSchema,
) {}

export class AdminAiSettingIdParamDto extends createZodDto(
  z.object({ id: z.string().uuid() }).strict(),
) {}
