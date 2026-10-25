import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

/** Fixed limits. Only values worth tuning per deployment are environment variables. */
export const APP_LIMITS = {
  /** A session slides forward on use but never lives longer than this. */
  sessionMaxAgeDays: 180,
  /** lastSeenAt/expiresAt are rewritten at most this often per session. */
  sessionTouchSec: 3600,
  maxActiveSessionsPerIp: 50,
  burstWindowSec: 10,
  readsPerIpPerMin: 120,
  authFailuresPerIpPerMin: 30,
  textMaxChars: 2000,
  /** How long one turn may hold its room before another request can take over. */
  turnLockSec: 120,
} as const;

/** Body limit for every /api/app/* route (main.ts reads it before Nest starts). */
export const APP_BODY_LIMIT_BYTES = 16_384;

const ORIGIN_PATTERN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

const int = (def: number, min = 1) =>
  z.coerce.number().int().min(min).max(1_000_000_000).default(def);

const flag = z
  .union([z.boolean(), z.string()])
  .default(false)
  .transform((value) => value === true || value === 'true');

/** "https://a.com, https://b.com/" → normalized list; a bad entry fails validation. */
const origins = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim().toLowerCase().replace(/\/$/, ''))
      .filter(Boolean),
  )
  .pipe(z.array(z.string().regex(ORIGIN_PATTERN, 'scheme://host[:port] only')));

const settingsSchema = z.object({
  enabled: flag,
  ipHashSalt: z.string().default(''),
  allowedOrigins: origins,
  sessionTtlDays: int(30),
  historyRetentionDays: int(7),
  sessionCreatePerIpHour: int(30),
  msgBurstPerContact: int(10),
  msgDailyPerContact: int(300),
  msgPerIpMin: int(30),
  msgDailyPerIp: int(2000),
  /** 0 = no cap. The ceiling on what a distributed attack can spend per day. */
  msgDailyTotal: int(20000, 0),
});

export type AppMessageSettings = z.infer<typeof settingsSchema>;

const ENV_NAMES: Record<keyof AppMessageSettings, string> = {
  enabled: 'APP_MESSAGE_ENABLED',
  ipHashSalt: 'APP_IP_HASH_SALT',
  allowedOrigins: 'APP_ALLOWED_ORIGINS',
  sessionTtlDays: 'APP_SESSION_TTL_DAYS',
  historyRetentionDays: 'APP_HISTORY_RETENTION_DAYS',
  sessionCreatePerIpHour: 'APP_SESSION_CREATE_PER_IP_HOUR',
  msgBurstPerContact: 'APP_MSG_BURST_PER_CONTACT',
  msgDailyPerContact: 'APP_MSG_DAILY_PER_CONTACT',
  msgPerIpMin: 'APP_MSG_PER_IP_MIN',
  msgDailyPerIp: 'APP_MSG_DAILY_PER_IP',
  msgDailyTotal: 'APP_MSG_DAILY_TOTAL',
};

const MIN_SALT_LENGTH = 16;

/**
 * Validation is strict only when the feature is enabled, so a deployment that
 * leaves APP_MESSAGE_ENABLED off never needs any of these variables.
 */
export function loadAppMessageSettings(
  read: (name: string) => unknown,
): AppMessageSettings {
  const raw = Object.fromEntries(
    Object.entries(ENV_NAMES).flatMap(([key, name]) => {
      const value = read(name);
      return value === undefined || value === '' ? [] : [[key, value]];
    }),
  );

  const parsed = settingsSchema.safeParse(raw);
  if (!flag.parse(raw.enabled)) {
    return {
      ...(parsed.success ? parsed.data : settingsSchema.parse({})),
      enabled: false,
    };
  }
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => ENV_NAMES[issue.path[0] as keyof AppMessageSettings])
      .filter(Boolean)
      .join(', ');
    throw new Error(`Invalid App Message configuration: ${fields}`);
  }
  if (parsed.data.ipHashSalt.length < MIN_SALT_LENGTH) {
    throw new Error(
      `APP_IP_HASH_SALT must be at least ${MIN_SALT_LENGTH} characters when APP_MESSAGE_ENABLED=true`,
    );
  }
  return parsed.data;
}

@Injectable()
export class AppMessageConfig {
  readonly values: AppMessageSettings;

  constructor(config: ConfigService) {
    this.values = loadAppMessageSettings((name) => config.get(name));
    if (this.values.enabled && !Number(config.get('TRUST_PROXY_HOPS') ?? 0)) {
      // Without it every client appears to come from the proxy's address, and
      // the per-IP limits would throttle all customers as one.
      new Logger(AppMessageConfig.name).warn(
        'App Message is enabled but TRUST_PROXY_HOPS is 0: set it to the number of proxies in front of the app (nginx = 1) unless clients connect directly',
      );
    }
  }
}
