import type { BusinessLexicon } from '../attributes/types/attribute-definition.types';
import {
  DEFAULT_PRODUCT_TIMEZONE,
  pad2,
  zonedParts,
} from '../time/product-clock';

const WEEKDAYS = [
  'จันทร์',
  'อังคาร',
  'พุธ',
  'พฤหัสบดี',
  'ศุกร์',
  'เสาร์',
  'อาทิตย์',
];
const MONTHS = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
];

/** Clock reading of an HH:mm value as customers read it: "20:00 น." */
export const formatClock = (hhmm: string) => `${hhmm} น.`;

/** "ศุกร์ 6 พ.ย." for a calendar date (YYYY-MM-DD, already in the business timezone). */
export function formatLocalDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
  return `${WEEKDAYS[weekday - 1]} ${day} ${MONTHS[month - 1]}`;
}

export function slotLocalDate(
  instant: string | Date,
  timeZone = DEFAULT_PRODUCT_TIMEZONE,
): string {
  const parts = zonedParts(new Date(instant), timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/** "ศุกร์ 6 พ.ย." of a slot start. */
export const formatSlotDate = (
  instant: string | Date,
  timeZone = DEFAULT_PRODUCT_TIMEZONE,
) => formatLocalDate(slotLocalDate(instant, timeZone));

/** "07:30" of a slot start (24-hour, business timezone), for timetable lines. */
export function slotClock(
  instant: string | Date,
  timeZone = DEFAULT_PRODUCT_TIMEZONE,
): string {
  const parts = zonedParts(new Date(instant), timeZone);
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

/** "20:00 น." of a slot start (24-hour, business timezone). */
export function formatSlotTime(
  instant: string | Date,
  timeZone = DEFAULT_PRODUCT_TIMEZONE,
): string {
  const parts = zonedParts(new Date(instant), timeZone);
  return formatClock(`${pad2(parts.hour)}:${pad2(parts.minute)}`);
}

/** "06:30 น. (วันถัดไป)" when the arrival is on a later day than the start. */
export function formatArrival(
  startsAt: string,
  endsAt: string,
  timeZone = DEFAULT_PRODUCT_TIMEZONE,
): string {
  const later =
    slotLocalDate(endsAt, timeZone) > slotLocalDate(startsAt, timeZone);
  return `${formatSlotTime(endsAt, timeZone)}${later ? ' (วันถัดไป)' : ''}`;
}

/** The customer's time words back to them: one clock, or a range. */
export function formatQueryTime(
  after: string | null,
  before: string | null,
): string | undefined {
  if (!after && !before) return undefined;
  if (after && before) {
    const minutes = (value: string) =>
      Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    const span = minutes(before) - minutes(after);
    if (span <= 120) {
      const mid = minutes(after) + span / 2;
      return formatClock(
        `${pad2(Math.floor(mid / 60))}:${pad2(Math.round(mid % 60))}`,
      );
    }
    return `${after}–${before} น.`;
  }
  if (after) return `หลัง ${formatClock(after)}`;
  return `ก่อน ${formatClock(before!)}`;
}

/**
 * What to say about one slot's availability. "Full for 3 people" with 2 seats
 * left is not "full": when seats remain but not enough for the party, the
 * count is stated (if the business shows counts), otherwise the state label.
 */
export function availabilityLabel(
  lexicon: BusinessLexicon,
  showQuantity: boolean,
  slot: {
    state: keyof BusinessLexicon['availability'];
    seatsLeft: number | null;
  },
  quantity: number | null,
): string {
  const text = lexicon.schedule?.notEnough;
  if (
    text &&
    showQuantity &&
    slot.state === 'FULL' &&
    slot.seatsLeft !== null &&
    slot.seatsLeft > 0 &&
    quantity !== null
  )
    return text
      .replaceAll('{left}', String(slot.seatsLeft))
      .replaceAll('{unit}', lexicon.unit)
      .replaceAll('{quantity}', String(quantity));
  return lexicon.availability[slot.state];
}
