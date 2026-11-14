import {
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../../shared/guards/public.decorator';
import { ChannelIngressService } from './channel-ingress.service';

/** Transport ingress only (`/api/channels/facebook/webhooks`, ...). Processing runs in the queue worker. */
@Controller('api/channels/:kind/webhooks')
export class ChannelWebhookController {
  constructor(private readonly ingress: ChannelIngressService) {}

  /** Subscription handshake (Facebook: hub.mode / hub.verify_token / hub.challenge). */
  @Public()
  @Get(['', ':routeKey'])
  @Header('Content-Type', 'text/plain')
  verify(
    @Param('kind') kind: string,
    @Query() query: Record<string, unknown>,
    @Param('routeKey') routeKey?: string,
  ) {
    return this.ingress.challenge(kind, query, routeKey);
  }

  @Public()
  @Post(['', ':routeKey'])
  @HttpCode(200)
  async receive(
    @Param('kind') kind: string,
    @Req() request: FastifyRequest,
    @Param('routeKey') routeKey?: string,
  ) {
    await this.ingress.receive(kind, {
      routeKey,
      rawBody: request.rawBody,
      headers: request.headers,
      body: request.body,
    });
    return { ok: true };
  }
}
