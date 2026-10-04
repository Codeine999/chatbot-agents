import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { z } from 'zod';
import { RateLimitService } from '../usage/rate-limit/rate-limit.service';
import type { LineWebhookEvent } from './dto/line';
import {
  LINE_EVENT_JOB,
  LINE_EVENTS_QUEUE,
  type LineEventJobData,
} from './line-events.queue';

const source = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('user'), userId: z.string().min(1) })
    .passthrough(),
  z
    .object({
      type: z.literal('group'),
      groupId: z.string().min(1),
      userId: z.string().min(1).optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('room'),
      roomId: z.string().min(1),
      userId: z.string().min(1).optional(),
    })
    .passthrough(),
]);
const base = z
  .object({
    webhookEventId: z.string().min(1),
    timestamp: z.number().int().nonnegative(),
    source,
    mode: z.enum(['active', 'standby']),
    deliveryContext: z.object({ isRedelivery: z.boolean() }).passthrough(),
  })
  .passthrough();
const replyToken = z.string().min(1);
const message = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('text'),
      id: z.string().min(1),
      text: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('image'),
      id: z.string().min(1),
      contentProvider: z
        .discriminatedUnion('type', [
          z.object({ type: z.literal('line') }),
          z.object({
            type: z.literal('external'),
            originalContentUrl: z.string().url(),
            previewImageUrl: z.string().url(),
          }),
        ])
        .optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('sticker'),
      id: z.string().min(1),
      packageId: z.string().min(1),
      stickerId: z.string().min(1),
      stickerResourceType: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      text: z.string().optional(),
    })
    .passthrough(),
]);
const eventSchema = z.discriminatedUnion('type', [
  base.extend({ type: z.literal('message'), message, replyToken }),
  base.extend({
    type: z.literal('postback'),
    replyToken,
    postback: z
      .object({
        data: z.string(),
        params: z.record(z.string(), z.string()).optional(),
      })
      .passthrough(),
  }),
  base.extend({ type: z.literal('follow'), replyToken }),
  base.extend({ type: z.literal('unfollow') }),
]);
const bodySchema = z.object({
  destination: z.string().min(1),
  events: z.array(z.unknown()),
});
const eventTypeSchema = z.object({ type: z.string().min(1) });
const messageTypeSchema = z.object({
  message: z.object({ type: z.string().min(1) }),
});

/** Receives authenticated LINE payloads, validates and dispatches durable jobs.
 * LineChannelAdapter handles the separate worker-side conversion and delivery.
 */
@Injectable()
export class LineWebhookAdapter {
  private readonly globalIngressLimitPerSec: number;

  constructor(
    private readonly rateLimitService: RateLimitService,
    @InjectQueue(LINE_EVENTS_QUEUE)
    private readonly queue: Queue<LineEventJobData>,
    config: ConfigService,
  ) {
    this.globalIngressLimitPerSec = Number(
      config.get('LINE_GLOBAL_INGRESS_LIMIT_PER_SEC') ?? 100,
    );
  }

  async receive(payload: unknown): Promise<void> {
    const events = this.parseEvents(payload);
    if (!events.length) return;

    const ingress = await this.rateLimitService.consume(
      'rl:line:global:ingress',
      this.globalIngressLimitPerSec,
      1,
      events.length,
    );
    if (!ingress.allowed) {
      throw new ServiceUnavailableException(
        'Webhook ingress is busy; retry later',
      );
    }
    // Keep redeliveries: BullMQ deduplicates retained jobs; the database claim
    // deduplicates events after queue retention expires. Do not run AI here.
    await Promise.all(
      events.map((event) =>
        this.queue.add(
          LINE_EVENT_JOB,
          { event },
          { jobId: event.webhookEventId },
        ),
      ),
    );
  }

  private parseEvents(payload: unknown): LineWebhookEvent[] {
    try {
      const body = bodySchema.parse(payload);
      const events: LineWebhookEvent[] = [];
      for (const input of body.events) {
        const { type } = eventTypeSchema.parse(input);
        // LINE sends other lifecycle events and message types this bot does
        // not handle. Acknowledge those without inventing a chatbot turn.
        if (!['message', 'postback', 'follow', 'unfollow'].includes(type))
          continue;
        if (type === 'message') {
          const messageType = messageTypeSchema.parse(input).message.type;
          if (!['text', 'image', 'sticker'].includes(messageType)) continue;
        }
        events.push(eventSchema.parse(input));
      }
      return events;
    } catch {
      // Never return the raw customer payload or validation internals.
      throw new BadRequestException('Invalid LINE webhook payload');
    }
  }
}
