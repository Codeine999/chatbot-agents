import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

@Injectable()
export class LineSignatureGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const signature = request.headers['x-line-signature'];
    const rawBody = request.rawBody;

    if (typeof signature !== 'string' || signature.length === 0 || !rawBody) {
      throw new UnauthorizedException('Invalid LINE signature');
    }

    const channelSecret = this.configService.getOrThrow<string>(
      'LINE_CHANNEL_SECRET',
    );

    const expected = createHmac('sha256', channelSecret)
      .update(rawBody)
      .digest();
    const received = Buffer.from(signature, 'base64');

    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      throw new UnauthorizedException('Invalid LINE signature');
    }

    return true;
  }
}
