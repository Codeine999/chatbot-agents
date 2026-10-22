import { normalizeText } from '../../../../utils/text.utils';
import type { AttributeDefinition } from '../types/attribute-definition.types';
import { GENERIC_OPTION_PREFIXES } from './option-matcher.constants';

/**
 * Compares a customer's wording with stored option values: label/kind
 * prefixes, spacing, case, the unit and store-defined aliases are ignored.
 */
export function optionMatcher(
  definition: Pick<AttributeDefinition, 'label' | 'unit' | 'valueAliases'>,
) {
  const prefixes = [
    ...new Set([normalizeText(definition.label), ...GENERIC_OPTION_PREFIXES]),
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const unit = normalizeText(definition.unit ?? '').replace(/\s+/gu, '');
  const base = (value: string) => {
    let text = normalizeText(value);
    for (const prefix of prefixes)
      if (text.startsWith(prefix) && text.length > prefix.length) {
        text = text.slice(prefix.length);
        break;
      }
    text = text.replace(/\s+/gu, '');
    return unit && text.endsWith(unit) && text.length > unit.length
      ? text.slice(0, -unit.length)
      : text;
  };
  const canonical = new Map<string, string>();
  for (const [stored, aliases] of Object.entries(definition.valueAliases))
    for (const alias of [stored, ...aliases])
      canonical.set(base(alias), base(stored));
  const key = (value: string) => canonical.get(base(value)) ?? base(value);
  return {
    key,
    matches: (stored: unknown, asked: string) =>
      typeof stored === 'string' && key(stored) === key(asked),
  };
}
