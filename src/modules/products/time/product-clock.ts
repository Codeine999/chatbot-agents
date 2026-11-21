import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const DEFAULT_PRODUCT_TIMEZONE = 'Asia/Bangkok';

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** ISO weekday, 1 = Monday ... 7 = Sunday. */
  weekday: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, found);
  }
  return found;
}
const WEEKDAYS: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** Wall-clock fields of an instant in a timezone. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday] ?? 1,
  };
}

/** The instant at which a timezone's wall clock shows these fields. */
export function zonedToUtc(
  wall: Pick<ZonedParts, 'year' | 'month' | 'day' | 'hour' | 'minute'>,
  timeZone: string,
): Date {
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
  );
  // Two passes settle the offset even next to a daylight-saving change.
  let guess = asUtc;
  for (let pass = 0; pass < 2; pass += 1) {
    const shown = zonedParts(new Date(guess), timeZone);
    const shownAsUtc = Date.UTC(
      shown.year,
      shown.month - 1,
      shown.day,
      shown.hour,
      shown.minute,
    );
    guess += asUtc - shownAsUtc;
  }
  return new Date(guess);
}

export function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
export function localDateString(
  parts: Pick<ZonedParts, 'year' | 'month' | 'day'>,
): string {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/** "Now" and the business timezone for everything the product flow reads. */
@Injectable()
export class ProductClock {
  readonly timeZone: string;
  constructor(@Optional() config?: ConfigService) {
    const configured = config?.get<string>('PRODUCT_TIMEZONE')?.trim();
    const zone = configured || DEFAULT_PRODUCT_TIMEZONE;
    try {
      formatter(zone);
    } catch {
      throw new Error(`PRODUCT_TIMEZONE is not a valid IANA timezone: ${zone}`);
    }
    this.timeZone = zone;
  }
  now(): Date {
    return new Date();
  }
}

/** A clock fixed at one instant, for tests and replays. */
export class FixedProductClock extends ProductClock {
  constructor(
    private readonly at: Date,
    zone?: string,
  ) {
    super(zone ? new ConfigService({ PRODUCT_TIMEZONE: zone }) : undefined);
  }
  override now(): Date {
    return new Date(this.at);
  }
}
