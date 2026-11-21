import {
  localDateString,
  pad2,
  zonedParts,
  zonedToUtc,
  type ZonedParts,
} from './product-clock';

const WEEKDAY_NAMES = [
  'จันทร์',
  'อังคาร',
  'พุธ',
  'พฤหัสบดี',
  'ศุกร์',
  'เสาร์',
  'อาทิตย์',
];
const DAY_LABELS = ['วันนี้', 'พรุ่งนี้', 'มะรืนนี้'];

/** `2026-11-20T09:30+07:00`: the instant's wall clock with its zone offset. */
export function isoWithOffset(instant: Date, timeZone: string): string {
  const parts = zonedParts(instant, timeZone);
  const wallAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
  const minutes = Math.round(
    (wallAsUtc - Math.floor(instant.getTime() / 60_000) * 60_000) / 60_000,
  );
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${localDateString(parts)}T${pad2(parts.hour)}:${pad2(parts.minute)}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** Today's date parts in the business timezone. */
export function todayIn(now: Date, timeZone: string): ZonedParts {
  return zonedParts(now, timeZone);
}

/**
 * What the planner is told about time: the model never counts days itself, it
 * picks from a labelled calendar of the next 14 days.
 */
export function plannerTimeContext(now: Date, timeZone: string): string {
  const today = zonedParts(now, timeZone);
  const days = Array.from({ length: 14 }, (_, offset) => {
    const noon = zonedToUtc(
      {
        year: today.year,
        month: today.month,
        day: today.day + offset,
        hour: 12,
        minute: 0,
      },
      timeZone,
    );
    const parts = zonedParts(noon, timeZone);
    const name = WEEKDAY_NAMES[parts.weekday - 1];
    return {
      date: localDateString(parts),
      label: DAY_LABELS[offset] ? `${DAY_LABELS[offset]} ${name}` : name,
    };
  });
  return `now=${isoWithOffset(now, timeZone)} (${WEEKDAY_NAMES[today.weekday - 1]})\ncalendar=${JSON.stringify(days)}`;
}
