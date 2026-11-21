const FOLLOW_UP_THAI = [
  'อันนี้',
  'อันนั้น',
  'ตัวนี้',
  'ตัวนั้น',
  'เมื่อกี้',
  'อันเดิม',
  'เหมือนเดิม',
  'เหมือนก่อน',
  'โรงแรมนี้',
  'โปรโมชันนี้',
  'โปรโมชั่นนี้',
  'โปรนี้',
  'สินค้านี้',
  'บริการนี้',
  // Transport Business
  // 'รอบรถ',
  // 'ตาราง',
  // 'เวลารถ'
];

// English words need word boundaries so "it" does not match inside "item".
const FOLLOW_UP_ENGLISH = ['it', 'this one', 'that one', 'same one'];

const AMBIGUOUS_WORDS = ['กับ', 'หรือ', 'ระหว่าง', 'เทียบ', 'เปรียบเทียบ'];

const PRIVATE_MARKERS = ['@', '\\[REDACTED_'];
const PRIVATE_WORDS = [
  'ชื่อ',
  'นามสกุล',
  'ที่อยู่',
  'เลขบัญชี',
  'บัญชีธนาคาร',
  'รหัสผ่าน',
  'password',
  'passcode',
];

const SOCIAL_GREETINGS = ['สวัสดี', 'หวัดดี', 'ขอบคุณ', 'โอเค'];
const SOCIAL_PARTICLES = ['ครับ', 'ค่ะ', 'คะ'];
const SOCIAL_STANDALONE = [
  ...SOCIAL_PARTICLES,
  'hi',
  'hello',
  'thanks',
  'ok',
  'okay',
];

/** Words that point back at something said earlier ("อันนี้", "this one"). */
export const FOLLOW_UP = new RegExp(
  `${FOLLOW_UP_THAI.join('|')}|\\b(?:${FOLLOW_UP_ENGLISH.join('|')})\\b`,
  'iu',
);

/** A comparison names several things, so a later "this one" has no single target. */
export const AMBIGUOUS_CONTEXT = new RegExp(
  `(?:${AMBIGUOUS_WORDS.join('|')})`,
  'u',
);

/** Text that may hold personal data must never be copied into a search query. */
export const PRIVATE_CONTEXT = new RegExp(
  `${PRIVATE_MARKERS.join('|')}|(?:${PRIVATE_WORDS.join('|')})`,
  'iu',
);

/** Greetings and thanks carry no topic to reuse as context. */
export const SOCIAL_MESSAGE = new RegExp(
  `^(?:(?:${SOCIAL_GREETINGS.join('|')})(?:${SOCIAL_PARTICLES.join('|')})?|${SOCIAL_STANDALONE.join('|')})[!. ]*$`,
  'iu',
);
