import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { LineCredentialService } from './channel/line-credential.service';

@Injectable()
export class LineSignatureGuard implements CanActivate {
  constructor(private readonly credentials: LineCredentialService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { params?: { channelKey?: string } }>();
    const signature = request.headers['x-line-signature'];
    const rawBody = request.rawBody;

    if (typeof signature !== 'string' || signature.length === 0 || !rawBody) {
      throw new UnauthorizedException('Invalid LINE signature');
    }

    // /webhooks/:channelKey selects a stored channel; the bare route keeps the
    // deployment's channel. An unknown key answers like a bad signature.
    const channelKey = request.params?.channelKey;
    const channel =
      channelKey === undefined
        ? await this.credentials.forDeployment()
        : await this.credentials.forChannelKey(channelKey);
    if (!channel) throw new UnauthorizedException('Invalid LINE signature');

    const expected = createHmac('sha256', channel.secret)
      .update(rawBody)
      .digest();
    const received = Buffer.from(signature, 'base64');

    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      throw new UnauthorizedException('Invalid LINE signature');
    }

    // A signed body for another bot of the same provider must not land here.
    const destination = (request.body as { destination?: unknown } | undefined)
      ?.destination;
    if (channel.botUserId && destination !== channel.botUserId) {
      throw new UnauthorizedException('Invalid LINE signature');
    }

    return true;
  }
}
