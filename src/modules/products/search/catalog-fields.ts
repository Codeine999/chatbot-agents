import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import {
  productCompanyScope,
  type CommerceScope,
} from '../../commerce/types/commerce-scope';
import type { AttributeDefinition } from '../attributes/types/attribute-definition.types';
import { attributeDefinitionSchema } from '../attributes/dto/attribute-definition.dto';
import { BUSINESS_PRESETS } from '../attributes/presets';

/*
 * The only reader of BUSINESS_PRESETS. Forms, validation, indexing, search and
 * prompts get a store's fields from `loadCatalogFields`, so a new business is a
 * new preset entry and no other code.
 */

/** Every business a store can select. */
export const BUSINESS_TYPES = Object.keys(BUSINESS_PRESETS);

export function isBusinessType(type: string): boolean {
  return Object.hasOwn(BUSINESS_PRESETS, type);
}

/** Selectable businesses for the admin preset picker. */
export function businessPresets(): { type: string; label: string }[] {
  return BUSINESS_TYPES.map((type) => ({
    type,
    label: BUSINESS_PRESETS[type].label,
  }));
}

/** The preset's planner/answer wording, or undefined to use the general rules. */
export function businessPromptRules(
  type: string | null | undefined,
  purpose: 'planner' | 'answer',
): string | undefined {
  return type && isBusinessType(type)
    ? BUSINESS_PRESETS[type].prompt[purpose]
    : undefined;
}

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
