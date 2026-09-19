import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

export const aiSkillSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    prompt: z.string().trim().min(1).max(10_000),
  })
  .strict();

export const aiSkillsSchema = z.array(aiSkillSchema).max(50);

export const aiResponseStyleSchema = z
  .object({
    targetLength: z.enum(['short', 'medium', 'adaptive']),
    emojiLevel: z.enum(['none', 'light', 'normal']),
  })
  .strict();

export type AiSkill = z.infer<typeof aiSkillSchema>;
export type AiResponseStyle = z.infer<typeof aiResponseStyleSchema>;

export const DEFAULT_AI_RESPONSE_STYLE: AiResponseStyle = {
  targetLength: 'adaptive',
  emojiLevel: 'light',
};

export function parseAiSkills(value: unknown): AiSkill[] {
  const parsed = aiSkillsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function parseAiResponseStyle(value: unknown): AiResponseStyle {
  const parsed = aiResponseStyleSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_AI_RESPONSE_STYLE;
}

/** Trusted deployment scope. Arbitrary tenant ids never come from API input. */
export function aiSettingTenantId(config: ConfigService): string | null {
  return (
    z
      .uuid()
      .nullable()
      .parse(config.get('AI_SETTING_TENANT_ID') || null)
      ?.toLowerCase() ?? null
  );
}
