/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip customer PII that must never reach stored context or logs. */
export function redactPii(text: string): string {
  return text
    .replace(
      /((?:รหัสผ่าน|password|passcode)\s*[:=]?\s*)\S+/giu,
      '$1[REDACTED_PASSWORD]',
    )
    .replace(
      /((?:เลขบัญชี|บัญชีธนาคาร|bank\s*account|account\s*number)\s*[:=]?\s*)\d(?:[\d -]{7,18}\d)?/giu,
      '$1[REDACTED_ACCOUNT]',
    )
    .replace(/(?:\+66|0)(?:[\s-]?\d){8,9}/g, '[REDACTED_PHONE]')
    .trim();
}

const MAX_LOGGED_TEXT_CHARACTERS = 160;

/** Redacted, length-capped text for a diagnostic log line. Quote at the call
 * site (JSON.stringify) so the value stays composable inside JSON payloads. */
export function logSafeText(
  text: string,
  max: number = MAX_LOGGED_TEXT_CHARACTERS,
): string {
  const characters = Array.from(redactPii(text));
  return characters.length > max
    ? `${characters.slice(0, max).join('')}…`
    : characters.join('');
}

/** Render one diagnostic event as an indented block so a long line never has
 * to be read sideways. Blank/undefined rows are dropped. */
export function logBlock(
  tag: string,
  lines: readonly (string | null | undefined)[],
): string {
  const rows = lines.filter((line): line is string => Boolean(line?.trim()));
  return [`[${tag}]`, ...rows.map((line) => `  ${line}`)].join('\n');
}
