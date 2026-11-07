import { redactPii } from '../../../utils/text.utils';

const MAX_STRING = 500;
const MAX_ARRAY = 10;
const MAX_DEPTH = 4;

/**
 * Text Postgres can store: no NUL (rejected by text and jsonb) and no lone
 * surrogate (rejected by jsonb). A rejected value would lose the whole row, and
 * hostile or truncated input is exactly what a decision log must survive.
 */
export function cleanText(value: string): string {
  return value
    .split('\u0000')
    .join('')
    .replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '\uFFFD',
    );
}

/** Clips to `max` characters (code points, never half an emoji); null stays null. */
export function fit(
  value: string | null | undefined,
  max: number,
): string | null {
  if (value == null) return null;
  const chars = Array.from(cleanText(value));
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

/** Redacted, cleaned, truncated text for a log column; undefined stays undefined. */
export function logText(
  value: string | null | undefined,
  max: number,
): string | undefined {
  if (value == null) return undefined;
  // Bound the work first: a huge message must not be scanned in full.
  const head = value.length > max * 4 ? value.slice(0, max * 4) : value;
  const chars = Array.from(cleanText(redactPii(head)));
  return chars.length > max
    ? `${chars.slice(0, max).join('')}…`
    : chars.join('');
}

/**
 * JSON-safe, bounded copy of trace data: every string is PII-redacted and
 * truncated, arrays and nesting are capped, and non-finite numbers, functions
 * and class instances are dropped. A log must never store secrets or blow up.
 */
export function sanitizeTraceData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return sanitize(data, 0) as Record<string, unknown>;
}

function sanitize(value: unknown, depth: number): unknown {
  if (value == null) return value ?? null;
  if (typeof value === 'string') return logText(value, MAX_STRING);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY)
      .map((item) => sanitize(item, depth + 1));
    return value.length > MAX_ARRAY
      ? [...items, `+${value.length - MAX_ARRAY} more`]
      : items;
  }
  if (typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === 'function') continue;
      out[key] = sanitize(item, depth + 1);
    }
    return out;
  }
  return undefined;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}
