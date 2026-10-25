/**
 * Control characters except \n and \t, plus invisible characters that make a
 * message look empty or reorder its text (zero-width, bidi overrides, BOM,
 * line/paragraph separators).
 *
 * Built from a string on purpose: written as a literal, a formatter may
 * rewrite the escapes into the raw characters, and U+2028 inside a regex
 * literal is a syntax error.
 */
const STRIP = new RegExp(
  '[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F' +
    '\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]',
  'g',
);

/** NFC-normalized, invisible characters removed, trimmed. May return ''. */
export function sanitizeText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(STRIP, '')
    .normalize('NFC')
    .trim();
}

/** Single-line variant for names. */
export function sanitizeLine(input: string): string {
  return sanitizeText(input).replace(/\s+/g, ' ');
}
