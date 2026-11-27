/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const THAI_PHONE = /(?:\+66|0)(?:[\s-]?\d){8,9}/g;

/** `+66 81 234 5678` and `081-234-5678` compare equal. */
function phoneDigits(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.startsWith('66') ? `0${digits.slice(2)}` : digits;
}

type RedactOptions = Readonly<{
  /** Return true to keep this phone number as written. */
  keepPhone?: (phone: string) => boolean;
}>;

/** Strip customer PII that must never reach stored context or logs. */
export function redactPii(text: string, options: RedactOptions = {}): string {
  const { keepPhone } = options;
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[REDACTED_EMAIL]')
    .replace(/(?<!\d)\d(?:[ -]?\d){12}(?!\d)/gu, '[REDACTED_ID]')
    .replace(
      /((?:รหัสผ่าน|password|passcode)\s*[:=]?\s*)\S+/giu,
      '$1[REDACTED_PASSWORD]',
    )
    .replace(
      /((?:เลขบัญชี|บัญชีธนาคาร|bank\s*account|account\s*number)\s*[:=]?\s*)\d(?:[\d -]{7,18}\d)?/giu,
      '$1[REDACTED_ACCOUNT]',
    )
    .replace(THAI_PHONE, (phone) =>
      keepPhone?.(phone) ? phone : '[REDACTED_PHONE]',
    )
    .trim();
}

/**
 * Redaction for the bot's own reply before it becomes chat context. Phone
 * numbers in a reply come from the KB or the catalog (call center, branch
 * lines), so they stay; the model needs them to answer "ขอเบอร์อีกที". A
 * number the customer typed in the same turn is still removed, in case a
 * template or answer echoed it. Other PII is redacted as usual.
 */
export function redactBotReply(reply: string, customerText = ''): string {
  const typed = new Set(
    Array.from(customerText.matchAll(THAI_PHONE), (m) => phoneDigits(m[0])),
  );
  return redactPii(reply, {
    keepPhone: (phone) => !typed.has(phoneDigits(phone)),
  });
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
