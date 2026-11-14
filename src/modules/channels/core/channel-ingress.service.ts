import { InjectQueue } from '@nestjs/bullmq';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import type { WebhookRequest } from './channel-connector';
import { ChannelConnectorRegistry } from './channel-connector.registry';
import { CHAT_EVENTS_QUEUE } from '../../conversation/queue/chat-events.queue';
import {
  CHANNEL_EVENT_JOB,
  CHANNEL_EVENT_JOB_OPTIONS,
  channelEventJobId,
  type ChannelEventJobData,
} from './channel-events.queue';

/**
 * Webhook ingress for every connector: verify the signature on the raw body,
 * normalize, enqueue, return. Nothing here touches the database or the
 * chatbot, so the platform gets its 200 fast.
 */
@Injectable()
export class ChannelIngressService {
  constructor(
    private readonly connectors: ChannelConnectorRegistry,
    @InjectQueue(CHAT_EVENTS_QUEUE)
    private readonly queue: Queue<ChannelEventJobData>,
  ) {}

  async challenge(
    kind: string,
    query: Readonly<Record<string, unknown>>,
    routeKey?: string,
  ): Promise<string> {
    const connector = this.connector(kind);
    const challenge =
      (await connector.verifyChallenge?.(query, routeKey)) ?? null;
    if (challenge === null) throw new ForbiddenException();
    return challenge;
  }

  async receive(kind: string, request: WebhookRequest): Promise<number> {
    const connector = this.connector(kind);
    if (!(await connector.verifySignature(request)))
      throw new UnauthorizedException('Invalid signature');

    const messages = await connector.parse(request.body, request.routeKey);
    if (messages.length)
      await this.queue.addBulk(
        messages.map((message) => ({
          name: CHANNEL_EVENT_JOB,
          data: { kind: connector.kind, message },
          opts: {
            ...CHANNEL_EVENT_JOB_OPTIONS,
            jobId: channelEventJobId(connector.kind, message.externalMessageId),
          },
        })),
      );
    return messages.length;
  }

  /** Unknown or disabled channel answers like a missing route. */
  private connector(kind: string) {
    const connector = this.connectors.findEnabled(kind);
    if (!connector) throw new NotFoundException();
    return connector;
  }
}
