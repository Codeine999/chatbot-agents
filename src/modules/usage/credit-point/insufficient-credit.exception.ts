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
