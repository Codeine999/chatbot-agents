import { InternalServerErrorException } from '@nestjs/common';

export const getJson = async <T>(
  path: string,
  resource: string,
  accessToken: string,
  timeoutMs: number,
): Promise<T> => {
  const response = await fetch(`https://api.line.me${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`${resource} error:`, errorText);
    throw new InternalServerErrorException(`Failed to get ${resource}`);
  }

  return response.json() as Promise<T>;
};

/** A LINE API error that keeps the status, for callers that treat 404 or 429 differently. */
export class LineApiError extends Error {
  constructor(
    readonly status: number,
    readonly resource: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super(`LINE ${resource} failed with HTTP ${status}`);
  }
}

/** Like `getJson`, but throws `LineApiError` with the HTTP status. */
export const getLineJson = async <T>(
  path: string,
  resource: string,
  accessToken: string,
  timeoutMs: number,
): Promise<T> => {
  const response = await fetch(`https://api.line.me${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    await response.text().catch(() => undefined);
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new LineApiError(
      response.status,
      resource,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    );
  }

  return response.json() as Promise<T>;
};
