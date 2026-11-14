import { Injectable, Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { isRetryableAiProviderError } from '../../../ai-provider/errors/ai-provider-error';
import { channelUserId } from '../../../shared/channel/channel-kinds';
import { BanService } from '../../abuse/ban.service';
import { SpamDetectorService } from '../../abuse/spam-detector.service';
import { RateLimitService } from '../../usage/rate-limit/rate-limit.service';
import type { InboundMessage } from './channel-connector';
import { ChannelConnectorRegistry } from './channel-connector.registry';
import type { ChannelEventJobData } from './channel-events.queue';
import {
  ChannelInboundService,
  ChannelRoomBusyError,
} from './channel-inbound.service';
import { ChannelDeliveryError } from './channel-outbound.service';

/** Per-customer limits, the same defaults as LINE. */
const LIMITS = { burst: 10, burstWindowSec: 10, hourly: 60 } as const;

/**
 * Handles every connector's job of the shared chat-events queue (the worker
 * is ChatEventsProcessor): company + contact, abuse limits, then the shared
 * inbound path. A busy room, a platform that refused a send for now, or a
 * transient AI failure is retried with backoff; anything else is final.
 */
@Injectable()
export class ChannelEventsProcessor {
  private readonly logger = new Logger(ChannelEventsProcessor.name);

  constructor(
    private readonly connectors: ChannelConnectorRegistry,
    private readonly inbound: ChannelInboundService,
    private readonly rateLimit: RateLimitService,
    private readonly bans: BanService,
    private readonly spam: SpamDetectorService,
  ) {}

  async process(job: Job<ChannelEventJobData>): Promise<void> {
    const { kind, message } = job.data;
    // Only an instance with the connector enabled accepted this webhook. One
    // that shares the queue without it (mid-rollout, a dev box on the same
    // Redis) hands the job back instead of dropping the customer's message.
    if (!this.connectors.findEnabled(kind))
      throw new Error(`${kind} connector is not enabled on this instance`);
    const connector = this.connectors.find(kind);
    if (!connector) return;

    try {
      const companyId = await connector.resolveCompany(message.accountId);
      if (!companyId) {
        this.logger.warn(`${kind}: message for an unknown account dropped`);
        return;
      }
      const contact = await this.inbound.contact(kind, companyId, message);
      const userId = channelUserId(kind, contact.contactId);
      if (!(await this.allowed(userId, message, job.attemptsMade > 0))) return;

      await this.inbound.handle(kind, companyId, contact, message);
    } catch (error) {
      if (
        error instanceof ChannelRoomBusyError ||
        error instanceof ChannelDeliveryError ||
        isRetryableAiProviderError(error)
      )
        throw error;
      // Name only: provider messages can echo the customer's text.
      throw new UnrecoverableError(
        `${kind} event failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
  }

  /** Limits count first attempts only, so a retry of an accepted message is never dropped. */
  private async allowed(
    userId: string,
    message: InboundMessage,
    isRetry: boolean,
  ): Promise<boolean> {
    if (await this.bans.isBanned(userId)) return false;
    if (isRetry) return true;

    const burst = await this.rateLimit.consume(
      `rl:channel:${userId}:burst`,
      LIMITS.burst,
      LIMITS.burstWindowSec,
    );
    if (!burst.allowed) {
      await this.bans.addStrike(userId, 'burst limit exceeded');
      return false;
    }
    const hourly = await this.rateLimit.consume(
      `rl:channel:${userId}:hour`,
      LIMITS.hourly,
      3600,
    );
    if (!hourly.allowed) {
      await this.bans.addStrike(userId, 'hourly limit exceeded');
      return false;
    }
    if (!message.unsupported) {
      const check = await this.spam.check(userId, message.text);
      if (check.spam) {
        await this.bans.addStrike(userId, check.reason ?? 'spam');
        return false;
      }
    }
    return true;
  }
}
