import { z } from 'zod';

export const commerceScopeSchema = z
  .object({
    companyId: z.string().uuid(),
  })
  .strict();

export type CommerceScope = Readonly<z.infer<typeof commerceScopeSchema>>;

/** Public commerce scope is company-only. */
export function scoped(scope: CommerceScope): CommerceScope {
  return commerceScopeSchema.parse(scope);
}

/** Preserve the standalone partition for DB tables that still contain tenantId. */
export function commerceDbScope(
  scopeInput: CommerceScope,
): CommerceScope & { tenantId: null } {
  return { ...scoped(scopeInput), tenantId: null };
}

/** Products belong to a company. */
export function productCompanyScope(scopeInput: CommerceScope): CommerceScope {
  const scope = scoped(scopeInput);
  return scope;
}

export function productWhere(scopeInput: CommerceScope): { companyId: string } {
  return { companyId: productCompanyScope(scopeInput).companyId };
}
