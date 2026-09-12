export class LineDeliveryError extends Error {
  constructor(
    message: string,
    readonly outcome: 'REJECTED' | 'UNKNOWN',
    readonly retryable = false,
    readonly replyTokenInvalid = false,
  ) { super(message); }
}
