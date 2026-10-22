import { BadRequestException } from '@nestjs/common';
import { normalizeText, redactPii } from '../../../../utils/text.utils';
import type {
  AttributeDefinition,
  AttributeScope,
} from '../types/attribute-definition.types';

export function appliesToCategory(
  definition: Pick<AttributeDefinition, 'categories'>,
  category: string | null | undefined,
): boolean {
  if (!definition.categories.length) return true;
  const wanted = normalizeText(category ?? '');
  return (
    wanted.length > 0 &&
    definition.categories.some((c) => normalizeText(c) === wanted)
  );
}

/**
 * Validates one product's or variant's field values against the store's
 * definitions. Archived values already stored are preserved untouched; the
 * caller sends only active fields.
 */
export function validateAttributeValues(params: {
  definitions: readonly AttributeDefinition[];
  scope: AttributeScope;
  category: string | null | undefined;
  values: Record<string, unknown>;
  stored?: Record<string, unknown>;
  enforceRequired: boolean;
}): Record<string, unknown> {
  const { definitions, scope, category, values, stored = {} } = params;
  const byKey = new Map(
    definitions.filter((d) => d.scope === scope).map((d) => [d.key, d]),
  );
  const errors: string[] = [];
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!byKey.has(key) || byKey.get(key)?.status === 'ARCHIVED')
      result[key] = value;
  }
  for (const [key, raw] of Object.entries(values)) {
    const definition = byKey.get(key);
    if (!definition) {
      errors.push(`${key}: no such ${scope.toLowerCase()} field`);
      continue;
    }
    if (definition.status !== 'ACTIVE') {
      errors.push(`${key}: field is archived`);
      continue;
    }
    if (!appliesToCategory(definition, category)) {
      errors.push(`${key}: not used for category "${category ?? ''}"`);
      continue;
    }
    const checked = checkValue(definition, raw);
    if (typeof checked === 'string') errors.push(`${key}: ${checked}`);
    else result[key] = checked.value;
  }
  if (params.enforceRequired)
    for (const definition of byKey.values())
      if (
        definition.required &&
        definition.status === 'ACTIVE' &&
        appliesToCategory(definition, category) &&
        result[definition.key] === undefined
      )
        errors.push(`${definition.key}: required`);
  if (errors.length)
    throw new BadRequestException({
      message: 'Invalid product fields',
      errors,
    });
  return result;
}

function checkValue(
  definition: AttributeDefinition,
  raw: unknown,
): { value: unknown } | string {
  const text = (value: unknown, max: number) =>
    typeof value === 'string' && value.trim() && value.trim().length <= max
      ? value.trim()
      : undefined;
  const containsPii = (value: string) => redactPii(value) !== value.trim();
  switch (definition.type) {
    case 'TEXT': {
      const value = text(raw, 500);
      if (!value) return 'expected text';
      return containsPii(value) ? 'must not contain personal data' : { value };
    }
    case 'NUMBER':
      return typeof raw === 'number' && Number.isFinite(raw)
        ? { value: raw }
        : 'expected a number';
    case 'BOOLEAN':
      return typeof raw === 'boolean' ? { value: raw } : 'expected true/false';
    case 'SELECT': {
      const value = text(raw, 100);
      return value && definition.options.includes(value)
        ? { value }
        : `expected one of: ${definition.options.join(', ')}`;
    }
    case 'MULTI_SELECT':
    case 'TAGS': {
      if (!Array.isArray(raw) || raw.length > 30) return 'expected a list';
      const values = raw.map((v) => text(v, 100));
      if (values.some((v) => !v)) return 'expected a list of text';
      const list = [...new Set(values as string[])];
      if (
        definition.type === 'MULTI_SELECT' &&
        list.some((v) => !definition.options.includes(v))
      )
        return `expected values from: ${definition.options.join(', ')}`;
      return list.some(containsPii)
        ? 'must not contain personal data'
        : { value: list };
    }
  }
}

/** Customer-facing text for a stored value: lists joined, booleans in Thai, units appended. */
export function formatAttributeValue(
  definition: Pick<AttributeDefinition, 'type' | 'unit'>,
  value: unknown,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value))
    return value.length ? value.map(String).join(', ') : undefined;
  if (typeof value === 'boolean') return value ? 'มี' : 'ไม่มี';
  if (typeof value === 'number')
    return definition.unit ? `${value} ${definition.unit}` : String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}
