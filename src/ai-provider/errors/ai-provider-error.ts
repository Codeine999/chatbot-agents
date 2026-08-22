import { BadGatewayException } from '@nestjs/common';

/** Provider failures that are safe to retry on a separate BullMQ worker. */
export class RetryableAiProviderException extends BadGatewayException {
  readonly retryable = true;

  constructor(message = 'AI provider is temporarily unavailable') {
    super(message);
  }
}

export function isRetryableAiProviderError(error: unknown): boolean {
  return (
    error instanceof RetryableAiProviderException ||
    (typeof error === 'object' &&
      error !== null &&
      'retryable' in error &&
      (error as { retryable?: unknown }).retryable === true)
  );
}

/** Detects transient errors returned directly by an SDK or fetch. */
export function isTransientProviderFailure(error: unknown): boolean {
  if (isRetryableAiProviderError(error)) return true;
  if (!(error instanceof Error)) return false;

  const candidate = error as Error & {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    cause?: unknown;
  };
  const status = Number(candidate.status ?? candidate.statusCode);
  if (status === 429 || (status >= 500 && status <= 599)) return true;

  const code =
    typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '';
  if (
    [
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'EAI_AGAIN',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
    ].includes(code)
  ) {
    return true;
  }

  if (candidate.name === 'AbortError' || candidate.name === 'TimeoutError') {
    return true;
  }

  if (candidate.cause && candidate.cause !== error) {
    return isTransientProviderFailure(candidate.cause);
  }

  return /(?:^|\D)(?:429|5\d\d)(?:\D|$)|timed?\s*out|timeout|temporar(?:y|ily)/i.test(
    candidate.message,
  );
}
