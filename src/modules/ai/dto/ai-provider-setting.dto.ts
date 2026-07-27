import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  AI_PROVIDER_NAMES,
  AI_PROVIDER_SCOPES,
} from '../../../ai-provider/types/ai-provider.types';

export class AiProviderScopeParamDto extends createZodDto(
  z.object({
    scope: z.enum(AI_PROVIDER_SCOPES),
  }),
) {}

export class UpdateAiProviderSettingDto extends createZodDto(
  z.object({
    provider: z.enum(AI_PROVIDER_NAMES),
    model: z.string().trim().min(1).max(150),
  }),
) {}

export class UpdateMyAdminAiProviderSettingDto extends createZodDto(
  z.object({
    provider: z.enum(AI_PROVIDER_NAMES),
    model: z.string().trim().min(1).max(150),
  }),
) {}

export class AdminMemberIdParamDto extends createZodDto(
  z.object({
    adminMemberId: z.string().uuid(),
  }),
) {}

export class UpdateAdminAiAccessDto extends createZodDto(
  z
    .object({
      enabled: z.boolean().optional(),
      allowedProviders: z.array(z.enum(AI_PROVIDER_NAMES)).min(1).optional(),
    })
    .refine(
      (value) =>
        value.enabled !== undefined || value.allowedProviders !== undefined,
      { message: 'enabled or allowedProviders is required' },
    ),
) {}

export class AdminAiGenerateDto extends createZodDto(
  z.object({
    systemInstruction: z.string().trim().min(1).max(20_000).optional(),
    messages: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          text: z.string().trim().min(1).max(100_000),
        }),
      )
      .min(1),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().positive().max(32_000).optional(),
    provider: z.enum(AI_PROVIDER_NAMES).optional(),
    model: z.string().trim().min(1).max(150).optional(),
  }),
) {}
