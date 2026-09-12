import { ServiceUnavailableException } from '@nestjs/common';

// Callers must not convert an uncertain settlement into a final chatbot fallback.
export class PendingAiUsageError extends ServiceUnavailableException {
  readonly retryable = true;
  readonly pendingAiUsage = true;
  constructor() { super('AI usage outcome is pending review; do not call the provider again automatically'); }
}
export function rethrowPendingAiUsage(error: unknown): void {
  if (error instanceof PendingAiUsageError) throw error;
}
