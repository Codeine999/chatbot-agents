/**
 * Deterministic Thai date/time reader for customer messages. Pure: no I/O, no
 * clock (the caller passes today's date in the business timezone), no business
 * knowledge. It reads what is plainly said and leaves everything else null; a
 * model's guess is only a fallback for what this cannot read.
 *
 * Thai clock words: n ทุ่ม = 18+n, ตี n = n, บ่าย n (โมง) = 12+n,
 * n โมงเย็น = 12+n, n โมงเช้า = n. A bare "n โมง" with n 1..5 is read as
 * afternoon (บ่าย), 6..11 as morning.
 */
export type LocalDay = { year: number; month: number; day: number };
export type ThaiDateTime = {
  /** YYYY-MM-DD in the business timezone. */
  date: string | null;
  /** HH:mm inclusive lower bound of the departure time. */
  after: string | null;
  /** HH:mm exclusive upper bound of the departure time. */
  before: string | null;
  /** The phrases that were understood, for logs and tests. */
  matched: string[];
};

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
const NUMBER_WORDS: [string, number][] = [
  ['สิบเอ็ด', 11],
  ['สิบสอง', 12],
  ['หนึ่ง', 1],
  ['นึง', 1],
  ['สอง', 2],
  ['สาม', 3],
  ['สี่', 4],
  ['ห้า', 5],
  ['หก', 6],
  ['เจ็ด', 7],
  ['แปด', 8],
  ['เก้า', 9],
  ['สิบ', 10],
];
const NUM = `(\\d{1,2}|${NUMBER_WORDS.map(([w]) => w).join('|')})`;
function numberOf(token: string): number {
  if (/^\d+$/.test(token)) return Number(token);
  return NUMBER_WORDS.find(([word]) => word === token)?.[1] ?? NaN;
}

const MONTHS: [string, string[], number][] = [
  ['มกราคม', ['ม.ค.'], 1],
  ['กุมภาพันธ์', ['ก.พ.'], 2],
  ['มีนาคม', ['มี.ค.'], 3],
  ['เมษายน', ['เม.ย.'], 4],
  ['พฤษภาคม', ['พ.ค.'], 5],
  ['มิถุนายน', ['มิ.ย.'], 6],
  ['กรกฎาคม', ['ก.ค.'], 7],
  ['สิงหาคม', ['ส.ค.'], 8],
  ['กันยายน', ['ก.ย.'], 9],
  ['ตุลาคม', ['ต.ค.'], 10],
  ['พฤศจิกายน', ['พ.ย.', 'พฤศจิกา'], 11],
  ['ธันวาคม', ['ธ.ค.', 'ธันวา'], 12],
];
const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** "พ.ย." also matches "พย" and "พ.ย" */
const dotted = (abbr: string) =>
  [...abbr.replace(/\./g, '')].map(escapeRegex).join('\\.?') + '\\.?';
const MONTH_PATTERNS = MONTHS.flatMap(([full, abbrs, n]) => [
  ...[full, ...abbrs.filter((a) => !a.includes('.'))].map(
    (word) => [escapeRegex(word), n] as [string, number],
  ),
  ...abbrs
    .filter((a) => a.includes('.'))
    .map((abbr) => [dotted(abbr), n] as [string, number]),
]).sort((a, b) => b[0].length - a[0].length);
const MONTH_ALT = MONTH_PATTERNS.map(([p]) => `(?:${p})`).join('|');
const WEEKDAYS: [string, number][] = [
  ['จันทร์', 1],
  ['อังคาร', 2],
  ['พุธ', 3],
  ['พฤหัสบดี', 4],
  ['พฤหัส', 4],
  ['ศุกร์', 5],
  ['เสาร์', 6],
  ['อาทิตย์', 7],
];

const DAYPARTS: Record<string, [string, string]> = {
  เช้า: ['05:00', '11:00'],
  สาย: ['09:00', '12:00'],
  บ่าย: ['12:00', '16:00'],
  เย็น: ['16:00', '19:00'],
  ค่ำ: ['18:00', '21:00'],
  กลางคืน: ['18:00', '23:59'],
  ดึก: ['21:00', '23:59'],
};

const pad = (value: number) => String(value).padStart(2, '0');
const clock = (minutes: number) =>
  `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const clamp = (minutes: number) => Math.min(1439, Math.max(0, minutes));
const dayString = (d: LocalDay) => `${d.year}-${pad(d.month)}-${pad(d.day)}`;
const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

function addDays(d: LocalDay, days: number): LocalDay {
  const next = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}
function isoWeekday(d: LocalDay): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() || 7;
}
const before = (a: LocalDay, b: LocalDay) =>
  Date.UTC(a.year, a.month - 1, a.day) < Date.UTC(b.year, b.month - 1, b.day);

function normalize(text: string): string {
  return [...text]
    .map((ch) => {
      const index = THAI_DIGITS.indexOf(ch);
      return index >= 0 ? String(index) : ch;
    })
    .join('')
    .toLowerCase()
    .replace(/ๆ/g, '')
    .replace(/\s+/g, ' ');
}

function readDate(
  text: string,
  today: LocalDay,
  matched: string[],
): { date: LocalDay; daypart?: string; after?: number } | undefined {
  const note = (value: string) => matched.push(value);
  let match: RegExpExecArray | null;

  // 20/11 or 20/11/2026
  match =
    /(?<![\d/])(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{4}))?(?![\d/])/u.exec(
      text,
    );
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    const date = resolveDate(today, day, month, match[3]);
    if (date) {
      note(match[0]);
      return { date };
    }
  }
  // 20 พ.ย. / วันที่ 20 พฤศจิกายน 2026
  match = new RegExp(
    `(?:วันที่\\s*)?(\\d{1,2})\\s*(${MONTH_ALT})\\s*(\\d{4})?`,
    'u',
  ).exec(text);
  if (match) {
    const resolved = MONTH_PATTERNS.find(([pattern]) =>
      new RegExp(`^${pattern}$`, 'u').test(match![2]),
    )?.[1];
    if (resolved) {
      const date = resolveDate(today, Number(match[1]), resolved, match[3]);
      if (date) {
        note(match[0].trim());
        return { date };
      }
    }
  }
  // วันที่ 25 (no month: this month unless passed)
  match = /วันที่\s*(\d{1,2})(?!\d|\s*(?:\/|เดือน))/u.exec(text);
  if (match) {
    const day = Number(match[1]);
    let { year, month } = today;
    if (day < today.day) {
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    if (day >= 1 && day <= daysInMonth(year, month)) {
      note(match[0]);
      return { date: { year, month, day } };
    }
  }
  // อีก 3 วัน
  match = new RegExp(`อีก\\s*${NUM}\\s*วัน`, 'u').exec(text);
  if (match && numberOf(match[1]) >= 1) {
    note(match[0]);
    return { date: addDays(today, numberOf(match[1])) };
  }
  if (/มะรืน/u.test(text)) {
    note('มะรืน');
    return { date: addDays(today, 2) };
  }
  if (/พรุ่งนี้|พรุ่งนี/u.test(text)) {
    note('พรุ่งนี้');
    return { date: addDays(today, 1) };
  }
  match = /คืนนี้/u.exec(text);
  if (match) {
    note('คืนนี้');
    return { date: today, after: 18 * 60 };
  }
  match = /(เช้า|สาย|บ่าย|เย็น|ค่ำ)นี้/u.exec(text);
  if (match) {
    note(match[0]);
    return { date: today, daypart: match[1] };
  }
  if (/วันนี้/u.test(text)) {
    note('วันนี้');
    return { date: today };
  }
  // วันศุกร์นี้ / ศุกร์หน้า / วันเสาร์
  const weekday = WEEKDAYS.map(([w]) => w).join('|');
  match = new RegExp(`(วัน)?(${weekday})\\s*(นี้|หน้า)?`, 'u').exec(text);
  if (match && (match[1] || match[3])) {
    // "อาทิตย์หน้า" without "วัน" means next week, not Sunday.
    if (match[2] === 'อาทิตย์' && !match[1]) return undefined;
    const target = WEEKDAYS.find(([w]) => w === match[2])![1];
    note(match[0].trim());
    if (match[3] === 'หน้า') {
      // That weekday in the next calendar week (Monday-Sunday).
      const nextMonday = 8 - isoWeekday(today);
      return { date: addDays(today, nextMonday + target - 1) };
    }
    // Otherwise the nearest one that has not passed (today counts).
    return { date: addDays(today, (target - isoWeekday(today) + 7) % 7) };
  }
  return undefined;
}

function resolveDate(
  today: LocalDay,
  day: number,
  month: number,
  yearText?: string,
): LocalDay | undefined {
  if (month < 1 || month > 12 || day < 1) return undefined;
  let year = today.year;
  let explicit = false;
  if (yearText) {
    const given = Number(yearText);
    year = given >= 2400 ? given - 543 : given;
    explicit = true;
  }
  if (day > daysInMonth(year, month)) return undefined;
  const candidate = { year, month, day };
  if (!explicit && before(candidate, today)) {
    year += 1;
    if (day > daysInMonth(year, month)) return undefined;
    return { year, month, day };
  }
  return candidate;
}

type SpecificTime = { minutes: number; text: string; start: number };

function specificTimes(text: string): SpecificTime[] {
  const found: SpecificTime[] = [];
  const add = (match: RegExpExecArray, minutes: number) => {
    if (minutes >= 0 && minutes < 1440)
      found.push({ minutes, text: match[0].trim(), start: match.index });
  };
  const all = (pattern: RegExp, read: (m: RegExpExecArray) => number) => {
    for (const match of text.matchAll(pattern)) {
      const minutes = read(match);
      if (!Number.isNaN(minutes)) add(match, minutes);
    }
  };
  // 10:11, 20:00
  all(/(?<![\d:.])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/gu, (m) => {
    return Number(m[1]) * 60 + Number(m[2]);
  });
  // 20.00 น. (dot only when "น." follows, so prices like 131.00 are not times)
  all(/(?<![\d:.])([01]?\d|2[0-3])\.([0-5]\d)\s*น(?:\.|าฬิกา)?/gu, (m) => {
    return Number(m[1]) * 60 + Number(m[2]);
  });
  // 20 น. / 20 นาฬิกา
  all(/(?<![\d:.])([01]?\d|2[0-3])\s*(?:นาฬิกา|น\.)/gu, (m) => {
    return Number(m[1]) * 60;
  });
  // บ่ายโมง / บ่าย 2 / บ่ายสอง / บ่าย 2 โมง
  all(/บ่ายโมง/gu, () => 13 * 60);
  all(new RegExp(`บ่าย\\s*${NUM}(?:\\s*โมง)?(?!\\s*ครึ่ง)`, 'gu'), (m) => {
    const n = numberOf(m[1]);
    return n >= 1 && n <= 11 ? (12 + n) * 60 : NaN;
  });
  // 6 โมงเช้า / 4 โมงเย็น / 2 โมง / 2 โมงบ่าย
  all(new RegExp(`${NUM}\\s*โมง\\s*(เช้า|เย็น|บ่าย|ครึ่ง)?`, 'gu'), (m) => {
    const n = numberOf(m[1]);
    if (!(n >= 1 && n <= 12)) return NaN;
    const half = m[2] === 'ครึ่ง' ? 30 : 0;
    let hour: number;
    if (m[2] === 'เย็น') hour = n <= 6 ? 12 + n : n;
    else if (m[2] === 'บ่าย') hour = n <= 11 ? 12 + n : n;
    else if (m[2] === 'เช้า') hour = n;
    else hour = n <= 5 ? 12 + n : n;
    return hour * 60 + half;
  });
  // 2 ทุ่ม / ทุ่มนึง / ทุ่ม
  all(new RegExp(`${NUM}\\s*ทุ่ม(?:\\s*(ครึ่ง))?`, 'gu'), (m) => {
    const n = numberOf(m[1]);
    return n >= 1 && n <= 5 ? (18 + n) * 60 + (m[2] ? 30 : 0) : NaN;
  });
  all(/(?<![๐-๙\dก-๙])ทุ่ม(?!ครึ่ง)/gu, () => 19 * 60);
  // ตี 1 / ตีหนึ่ง
  all(new RegExp(`ตี\\s*${NUM}`, 'gu'), (m) => {
    const n = numberOf(m[1]);
    return n >= 1 && n <= 5 ? n * 60 : NaN;
  });
  all(/เที่ยงคืน/gu, () => 0);
  all(/เที่ยง(?!คืน)/gu, () => 12 * 60);
  // The same text can be read by two patterns ("2 โมง" vs "บ่าย 2 โมง"): keep one per spot.
  const unique: SpecificTime[] = [];
  for (const time of found.sort((a, b) => a.start - b.start)) {
    const overlaps = unique.some(
      (kept) =>
        time.start < kept.start + kept.text.length &&
        kept.start < time.start + time.text.length,
    );
    if (!overlaps) unique.push(time);
  }
  return unique;
}

function modifierBefore(text: string, start: number): string | undefined {
  const head = text.slice(Math.max(0, start - 14), start);
  return /(หลัง|ก่อน|ประมาณ|ราวๆ|ราว|แถวๆ|แถว)\s*(?:เวลา|รอบ|ตอน)?\s*$/u.exec(
    head,
  )?.[1];
}

export function parseThaiDateTime(
  message: string,
  today: LocalDay,
): ThaiDateTime {
  const text = normalize(message);
  const matched: string[] = [];
  const dated = readDate(text, today, matched);
  let after: number | null = dated?.after ?? null;
  let upTo: number | null = null;

  const times = specificTimes(text);
  const distinct = [...new Set(times.map((t) => t.minutes))];
  if (distinct.length === 1) {
    const time = times[0];
    matched.push(time.text);
    const modifier = modifierBefore(text, time.start);
    if (modifier === 'หลัง') after = time.minutes;
    else if (modifier === 'ก่อน') upTo = time.minutes;
    else {
      const radius = modifier ? 60 : 30;
      after = clamp(time.minutes - radius);
      upTo = clamp(time.minutes + radius);
    }
  } else if (distinct.length > 1) {
    // Several different times: list the whole day instead of guessing one.
    for (const time of times) matched.push(time.text);
  } else {
    const dayword =
      dated?.daypart ??
      Object.keys(DAYPARTS).find((word) =>
        new RegExp(
          word === 'บ่าย' ? 'บ่าย(?!นี้)' : `${word}(?!นี้)`,
          'u',
        ).test(text.replace(/คืนนี้/g, '')),
      );
    if (dayword) {
      const [from, to] = DAYPARTS[dayword];
      const fromMinutes = Number(from.slice(0, 2)) * 60 + Number(from.slice(3));
      after = dated?.after !== undefined ? dated.after : fromMinutes;
      upTo = Number(to.slice(0, 2)) * 60 + Number(to.slice(3));
      matched.push(dayword);
    } else if (/กลางคืน|ตอนคืน/u.test(text)) {
      after = 18 * 60;
      matched.push('กลางคืน');
    }
  }
  if (dated?.after !== undefined && after !== null)
    after = Math.max(after, dated.after);
  // An inverted window cannot be searched; say nothing rather than guess.
  if (after !== null && upTo !== null && after >= upTo) {
    after = null;
    upTo = null;
  }
  return {
    date: dated ? dayString(dated.date) : null,
    after: after === null ? null : clock(after),
    before: upTo === null ? null : clock(upTo),
    matched,
  };
}

const QUANTITY_WORDS = '(?:คน|ท่าน|ที่นั่ง|ที่)';
/** "ไป 3 คน", "สองที่", "คนเดียว" */
export function parseQuantity(message: string): number | null {
  const text = normalize(message);
  if (/คนเดียว/u.test(text)) return 1;
  const match = new RegExp(
    `(?<![\\d:./])${NUM}\\s*${QUANTITY_WORDS}(?!ไหน|นี้|นั้น|ไหม|แล้ว|ไป|มา)`,
    'u',
  ).exec(text);
  if (!match) return null;
  const n = numberOf(match[1]);
  return n >= 1 && n <= 50 ? n : null;
}
