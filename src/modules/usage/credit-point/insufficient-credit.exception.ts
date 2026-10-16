import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Raised before any provider call when the company wallet or the caller's
 * budget cannot fund the request. Kept as 402 so admin HTTP clients see the
 * same status the previous reservation flow returned.
 */
export class InsufficientCreditException extends HttpException {
  constructor(message = 'Insufficient AI credit') {
    super(message, HttpStatus.PAYMENT_REQUIRED);
  }
}

// An unfunded wallet is not a provider or retrieval failure; the LINE chat
// entry point decides the reply (none), so callers must not fall back on it.
export function rethrowInsufficientCredit(error: unknown): void {
  if (error instanceof InsufficientCreditException) throw error;
}
