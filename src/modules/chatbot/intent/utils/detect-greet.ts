// Polite particles: ครับ / ค่ะ / จ้า ...
const POLITE = '(?:ครับผม|ครับ|คับ|ค่ะ|คะ|ค่า|จ้า)';

// Optional greeting: "สวัสดีครับ", "แอดมินค่ะ"
const GREETING = `(?:(?:สวัสดี|หวัดดี|แอดมิน)${POLITE}?)?`;

// Ask verb: "รบกวนขอสอบถามข้อมูล", "อยากปรึกษา", or "มีคำถาม"
const ASK =
  '(?:' +
  '(?:รบกวน|ขอ|อยาก|จะ|มีเรื่อง){0,4}' +
  '(?:สอบถาม|ถาม|ปรึกษา)' +
  '(?:ข้อมูล|เพิ่มเติม)?' +
  '|มีคำถาม' +
  ')';

// Softener: "หน่อย", "ด้วย", "นิดนึง", then optional "นะ"
const SOFTENER = '(?:หน่อย|ด้วย|นิดนึง|นิดหน่อย)?(?:นะ)?';

// Trailing punctuation, symbols, and emoji joiners/variation selectors
const TRAILING = '(?:[\\p{P}\\p{S}]|\\u200d|\\ufe0f)*';

/**
 * Whole-message inquiry opener without a topic, e.g. "ขอสอบถามหน่อยครับ".
 * Test against whitespace-stripped input; "สอบถามห้องว่าง" must not match.
 */
export const DETECT_GREET = new RegExp(
  `^${GREETING}${ASK}${SOFTENER}${POLITE}?${TRAILING}$`,
  'u',
);
