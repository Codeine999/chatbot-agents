import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

export type KnowledgeScope = Readonly<{
  tenantId: string | null;
  language: string;
}>;

/** Trusted deployment configuration, never a tenant supplied by the customer.
 * Legacy standalone records live in the null scope; they are not shared with
 * an explicitly configured tenant.
 */
export function knowledgeScope(config: ConfigService): KnowledgeScope {
  return {
    tenantId:
      z
        .uuid()
        .nullable()
        .parse(config.get('KNOWLEDGE_TENANT_ID') || null)
        ?.toLowerCase() ?? null,
    language: z
      .string()
      .min(1)
      .max(10)
      .parse(config.get('KNOWLEDGE_LANGUAGE') ?? 'th'),
  };
}

export function inKnowledgeScope(
  row: { active: boolean; tenantId: string | null; language: string },
  scope: KnowledgeScope,
): boolean {
  return (
    row.active &&
    row.tenantId === scope.tenantId &&
    row.language === scope.language
  );
}
