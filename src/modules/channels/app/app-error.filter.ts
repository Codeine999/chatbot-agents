import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AppApiException, type AppErrorBody } from './app-errors';

/**
 * One error shape for the whole public API: { code, message, retryAfterSec? }.
 * Unknown failures never leak details; they are logged and answered generically.
 */
@Catch()
export class AppErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    if (exception instanceof AppApiException) {
      const body = exception.getResponse() as AppErrorBody;
      if (body.retryAfterSec !== undefined) {
        void reply.header('Retry-After', String(body.retryAfterSec));
      }
      void reply.status(exception.getStatus()).send(body);
      return;
    }

    if (exception instanceof BadRequestException) {
      const body: AppErrorBody = {
        code: 'APP_VALIDATION',
        message: 'Invalid request',
      };
      void reply.status(400).send(body);
      return;
    }

    if (exception instanceof HttpException) {
      void reply.status(exception.getStatus()).send(exception.getResponse());
      return;
    }

    this.logger.error(
      'unhandled error in app message api',
      exception instanceof Error ? exception.stack : String(exception),
    );
    const body: AppErrorBody = {
      code: 'APP_UNAVAILABLE',
      message: 'Service unavailable',
    };
    void reply.status(500).send(body);
  }
}
