/**
 * Slot times are stored in UTC and shown in the business timezone. Thailand
 * has had one fixed offset (+07:00, no daylight saving) since 1920, so a
 * constant offset is exact for Asia/Bangkok.
 */
export const BANGKOK_OFFSET_MINUTES = 7 * 60;

export type LocalDate = { year: number; month: number; day: number };

export function parseLocalDate(value: string): LocalDate {
  const [year, month, day] = value.split('-').map(Number);
  return { year, month, day };
}

/** A Bangkok wall-clock moment as the UTC instant it is. */
export function bangkokToUtc(
  date: LocalDate,
  hour: number,
  minute: number,
): Date {
  return new Date(
    Date.UTC(date.year, date.month - 1, date.day, hour, minute) -
      BANGKOK_OFFSET_MINUTES * 60_000,
  );
}

export function isValidLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const { year, month, day } = parseLocalDate(value);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/** ISO weekday of a calendar date: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(date: LocalDate): number {
  return (
    new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() || 7
  );
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

export function daysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round(
    (Date.UTC(to.year, to.month - 1, to.day) -
      Date.UTC(from.year, from.month - 1, from.day)) /
      86_400_000,
  );
}

/** `YYYY-MM-DD HH:MM:SS.mmm` of a UTC instant, safe to cast to timestamp(3). */
export function sqlTimestamp(instant: Date): string {
  return instant.toISOString().replace('T', ' ').replace('Z', '');
}
