import type { ConfigService } from '@nestjs/config';
import { publicApiBaseUrl } from '../../core/public-api-base-url';

const LINE_API = 'https://api.line.me';

/** One call to the LINE Messaging API; the caller decides what each status means. */
export function lineApiRequest(
  method: 'GET' | 'PUT' | 'POST',
  path: string,
  accessToken: string,
  timeoutMs: number,
  body?: unknown,
): Promise<Response> {
  return fetch(`${LINE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * The URL LINE should call. A connected channel gets its own keyed route; the
 * deployment's environment channel uses the bare route. The origin is
 * PUBLIC_API_BASE_URL, or the default public API when it is not set.
 */
export function webhookUrlFor(
  config: ConfigService,
  channelKey: string | null,
): string {
  const root = `${publicApiBaseUrl(config)}/api/line/webhooks`;
  return channelKey ? `${root}/${channelKey}` : root;
}
