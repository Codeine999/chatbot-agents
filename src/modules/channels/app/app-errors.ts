import { HttpException } from '@nestjs/common';

export type AppErrorCode =
  | 'APP_VALIDATION'
  | 'APP_SESSION_INVALID'
  | 'APP_ORIGIN_NOT_ALLOWED'
  | 'APP_CONVERSATION_BUSY'
  | 'APP_CLIENT_MESSAGE_ID_REUSED'
  | 'APP_RATE_LIMITED'
  | 'APP_BANNED'
  | 'APP_TOO_MANY_SESSIONS'
  | 'APP_UNAVAILABLE';

export type AppErrorBody = Readonly<{
  code: AppErrorCode;
  message: string;
  retryAfterSec?: number;
}>;

/** Every error the App Message API returns on purpose. Messages are client-safe. */
export class AppApiException extends HttpException {
  constructor(
    status: number,
    code: AppErrorCode,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    const body: AppErrorBody = {
      code,
      message,
      ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
    };
    super(body, status);
  }
}

export const appUnavailable = () =>
  new AppApiException(
    503,
    'APP_UNAVAILABLE',
    'Service temporarily unavailable, please retry',
    2,
  );

export const sessionInvalid = () =>
  new AppApiException(401, 'APP_SESSION_INVALID', 'Invalid or expired session');
