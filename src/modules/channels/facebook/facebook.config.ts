import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

const flag = z
  .union([z.boolean(), z.string()])
  .default(false)
  .transform((value) => value === true || value === 'true');

const settingsSchema = z.object({
  enabled: flag,
  appSecret: z.string().min(1),
  pageAccessToken: z.string().min(1),
  verifyToken: z.string().min(16),
  pageId: z.string().regex(/^\d+$/),
  graphBaseUrl: z
    .string()
    .url()
    .default('https://graph.facebook.com/v23.0')
    .transform((url) => url.replace(/\/$/, '')),
  sendTimeoutMs: z.coerce.number().int().min(1000).max(60_000).default(10_000),
});

export type FacebookSettings = z.infer<typeof settingsSchema>;

const ENV_NAMES: Record<keyof FacebookSettings, string> = {
  enabled: 'FACEBOOK_ENABLED',
  appSecret: 'FACEBOOK_APP_SECRET',
  pageAccessToken: 'FACEBOOK_PAGE_ACCESS_TOKEN',
  verifyToken: 'FACEBOOK_VERIFY_TOKEN',
  pageId: 'FACEBOOK_PAGE_ID',
  graphBaseUrl: 'FACEBOOK_GRAPH_BASE_URL',
  sendTimeoutMs: 'FACEBOOK_SEND_TIMEOUT_MS',
};

/**
 * Strict only when FACEBOOK_ENABLED=true, so a deployment without Facebook
 * needs none of these variables. Values are never logged.
 */
export function loadFacebookSettings(
  read: (name: string) => unknown,
): FacebookSettings | null {
  const raw = Object.fromEntries(
    Object.entries(ENV_NAMES).flatMap(([key, name]) => {
      const value = read(name);
      return value === undefined || value === '' ? [] : [[key, value]];
    }),
  );
  if (!flag.parse(raw.enabled)) return null;

  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => ENV_NAMES[issue.path[0] as keyof FacebookSettings])
      .filter(Boolean)
      .join(', ');
    throw new Error(`Invalid Facebook configuration: ${fields}`);
  }
  return parsed.data;
}

const transportSchema = settingsSchema.pick({
  graphBaseUrl: true,
  sendTimeoutMs: true,
});

@Injectable()
export class FacebookConfig {
  /** Legacy single-Page settings from FACEBOOK_*; null when not enabled. */
  readonly values: FacebookSettings | null;
  /** Graph endpoint and timeout, shared by every Page; both have defaults. */
  readonly transport: z.infer<typeof transportSchema>;

  constructor(config: ConfigService) {
    this.values = loadFacebookSettings((name) => config.get(name));
    this.transport = transportSchema.parse({
      graphBaseUrl: config.get<string>('FACEBOOK_GRAPH_BASE_URL') || undefined,
      sendTimeoutMs:
        config.get<string>('FACEBOOK_SEND_TIMEOUT_MS') || undefined,
    });
  }
}
