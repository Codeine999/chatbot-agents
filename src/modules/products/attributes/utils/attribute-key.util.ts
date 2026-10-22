import { BadRequestException } from '@nestjs/common';
import {
  ATTRIBUTE_KEY_PATTERN,
  RESERVED_KEYS,
  SENSITIVE_KEY_WORDS,
  SENSITIVE_LABEL,
} from './attribute-key.constants';

/** False for built-in column names and money/stock/personal-data words. */
export function isSafeAttributeKey(key: string): boolean {
  return (
    ATTRIBUTE_KEY_PATTERN.test(key) &&
    !RESERVED_KEYS.has(key) &&
    !key.split('_').some((word) => SENSITIVE_KEY_WORDS.has(word))
  );
}

/** Rejects keys/labels that would turn a custom field into a money, stock or PII column. */
export function assertSafeDefinition(key: string, label: string): void {
  if (!ATTRIBUTE_KEY_PATTERN.test(key))
    throw new BadRequestException(
      'Field key must be lowercase letters, digits or _ and start with a letter',
    );
  if (RESERVED_KEYS.has(key))
    throw new BadRequestException(`"${key}" is a built-in product field`);
  if (key.split('_').some((word) => SENSITIVE_KEY_WORDS.has(word)))
    throw new BadRequestException(
      'Price, stock and personal data cannot be custom fields',
    );
  if (SENSITIVE_LABEL.test(label))
    throw new BadRequestException(
      'Price, stock and personal data cannot be custom fields',
    );
}
