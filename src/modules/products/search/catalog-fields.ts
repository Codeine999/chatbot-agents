import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import {
  productCompanyScope,
  type CommerceScope,
} from '../../commerce/types/commerce-scope';
import {
  BUSINESS_PRESETS,
  attributeDefinitionSchema,
  type AttributeDefinition,
} from '../attributes/attribute-definition';

/** Code presets are the only field metadata; unknown stored JSON stays private. */
export function catalogFields(
  type: string | null,
  categories: readonly string[] = [],
): AttributeDefinition[] {
  return (BUSINESS_PRESETS[type ?? '']?.fields ?? [])
    .map((field) => ({
      ...attributeDefinitionSchema.parse(field),
      scope: 'VARIANT' as const,
      categories: [...categories],
      status: 'ACTIVE' as const,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
}
export async function loadCatalogFields(
  db: Prisma.TransactionClient | PrismaService,
  scopeInput: CommerceScope,
) {
  return (await loadCatalogContext(db, scopeInput)).fields;
}

export async function loadCatalogContext(
  db: Prisma.TransactionClient | PrismaService,
  scopeInput: CommerceScope,
) {
  const scope = productCompanyScope(scopeInput);
  const company = await db.company.findUnique({
    where: { id: scope.companyId },
    select: { productBusinessType: true, productPresetCategories: true },
  });
  const businessType = company?.productBusinessType ?? null;
  return {
    businessType,
    fields: catalogFields(businessType, company?.productPresetCategories ?? []),
  };
}
