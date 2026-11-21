import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { appliesToCategory } from '../attributes/utils/attribute-value.util';
import { optionMatcher } from '../attributes/utils/option-matcher.util';
import type { AttributeDefinition } from '../attributes/types/attribute-definition.types';
import type { ProductPlan } from '../search/product-search.types';

export function fieldOperators(field: AttributeDefinition): string[] {
  return field.type === 'NUMBER'
    ? ['EQ', 'GTE', 'LTE']
    : ['TAGS', 'MULTI_SELECT'].includes(field.type)
      ? ['CONTAINS', 'NOT_CONTAINS']
      : field.type === 'BOOLEAN'
        ? ['EQ']
        : ['EQ', 'CONTAINS'];
}

export function validateBusinessFilters(
  plan: ProductPlan,
  fields: readonly AttributeDefinition[],
) {
  for (const filter of plan.filters) {
    const field = fields.find(
      (candidate) =>
        candidate.key === filter.key &&
        candidate.scope !== 'SLOT' &&
        candidate.status === 'ACTIVE' &&
        candidate.searchable,
    );
    if (!field || !fieldOperators(field).includes(filter.operator))
      throw new BadRequestException('Unsupported business field filter');
    if (field.type === 'NUMBER') {
      if (
        typeof filter.value === 'boolean' ||
        !/^-?\d{1,10}(\.\d{1,4})?$/.test(String(filter.value))
      )
        throw new BadRequestException('Invalid numeric field filter');
    } else if (field.type === 'BOOLEAN') {
      if (typeof filter.value !== 'boolean')
        throw new BadRequestException('Invalid boolean field filter');
    } else if (typeof filter.value !== 'string')
      throw new BadRequestException('Invalid text field filter');
  }
}

/** Every option and field predicate must match this same variant's selected business values. */
export function matchesBusinessFields(
  values: Record<string, unknown>,
  category: string | null,
  plan: ProductPlan,
  fields: readonly AttributeDefinition[],
) {
  const definition = (key: string) =>
    fields.find(
      (field) =>
        field.key === key &&
        field.scope !== 'SLOT' &&
        field.status === 'ACTIVE' &&
        appliesToCategory(field, category),
    );
  if (
    !plan.options.every((option) => {
      const field = definition(option.key);
      return (
        field?.variantOption &&
        optionMatcher(field).matches(values[option.key], option.value)
      );
    })
  )
    return false;
  return plan.filters.every((filter) => {
    const field = definition(filter.key),
      value = values[filter.key];
    if (!field || !field.searchable || value == null) return false;
    if (field.type === 'NUMBER') {
      if (
        typeof value !== 'number' &&
        typeof value !== 'string' &&
        !(value instanceof Prisma.Decimal)
      )
        return false;
      try {
        const comparison = new Prisma.Decimal(value).comparedTo(
          new Prisma.Decimal(String(filter.value)),
        );
        return filter.operator === 'GTE'
          ? comparison >= 0
          : filter.operator === 'LTE'
            ? comparison <= 0
            : comparison === 0;
      } catch {
        return false;
      }
    }
    if (field.type === 'BOOLEAN') return value === filter.value;
    const requested = String(filter.value);
    const matcher = optionMatcher(field);
    // A tag matches when it equals the asked value or contains it after
    // normalizing ("กันน้ำ" is in the tag "กันน้ำ IPX4"), never the reverse.
    const tagMatches = (item: unknown) => {
      if (typeof item !== 'string') return false;
      const stored = matcher.key(item);
      const asked = matcher.key(requested);
      return stored === asked || (asked.length > 0 && stored.includes(asked));
    };
    const matched = Array.isArray(value)
      ? value.some(tagMatches)
      : filter.operator === 'CONTAINS' && typeof value === 'string'
        ? value.toLocaleLowerCase().includes(requested.toLocaleLowerCase())
        : optionMatcher(field).matches(value, requested);
    return filter.operator === 'NOT_CONTAINS'
      ? Array.isArray(value) && !matched
      : matched;
  });
}
