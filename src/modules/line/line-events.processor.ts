import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { isRetryableAiProviderError } from '../../ai-provider/errors/ai-provider-error';
import { BanService } from '../abuse/ban.service';
import { SpamDetectorService } from '../abuse/spam-detector.service';
import { RateLimitService } from '../usage/rate-limit/rate-limit.service';
import { CHAT_EVENTS_QUEUE } from '../events/queue/chat-events.queue';
import {
  LINE_EVENT_RETRY_JOB,
  LINE_EVENT_RETRY_JOB_OPTIONS,
  type LineEventJobData,
} from './line-events.queue';
import { LineWebhookService } from './line-webhook.service';

/**
 * Handles the LINE jobs of the shared chat-events queue. The worker itself
 * (concurrency, rate limit) is ChatEventsProcessor.
 */
@Injectable()
export class LineEventsProcessor implements OnModuleInit, OnModuleDestroy {
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private recovering = false;

  onModuleInit() {
    this.recoveryTimer = setInterval(() => void this.recover(), 15_000);
    this.recoveryTimer.unref();
  }
  onModuleDestroy() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
  }
  private async recover() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      for (const event of await this.lineWebhookService.recoverableWebhookEvents()) {
        await this.queue.add(
          LINE_EVENT_RETRY_JOB,
          { event },
          {
            ...LINE_EVENT_RETRY_JOB_OPTIONS,
            jobId: `recover-${event.webhookEventId}-${Math.floor(Date.now() / 15000)}`,
          },
        );
      }
    } catch (error) {
      this.logger.error(`Webhook recovery: ${String(error)}`);
    } finally {
      this.recovering = false;
    }
  }
  private readonly logger = new Logger(LineEventsProcessor.name);
  private readonly userProcessingTails = new Map<string, Promise<void>>();

  private readonly userBurstLimit: number;
  private readonly userBurstWindowSec: number;
  private readonly userHourlyLimit: number;

  constructor(
    private readonly lineWebhookService: LineWebhookService,
    private readonly rateLimitService: RateLimitService,
    private readonly banService: BanService,
    private readonly spamDetectorService: SpamDetectorService,
    @InjectQueue(CHAT_EVENTS_QUEUE)
    private readonly queue: Queue<LineEventJobData>,
    configService: ConfigService,
  ) {
    this.userBurstLimit = Number(
      configService.get('LINE_USER_BURST_LIMIT') ?? 10,
    );
    this.userBurstWindowSec = Number(
      configService.get('LINE_USER_BURST_WINDOW_SEC') ?? 10,
    );
    this.userHourlyLimit = Number(
      configService.get('LINE_USER_HOURLY_LIMIT') ?? 60,
    );
  }

  async process(job: Job<LineEventJobData>): Promise<void> {
    try {
      await this.processQueuedJob(job, false);
    } catch (error) {
      if (!isRetryableAiProviderError(error)) throw error;

      await this.queue.add(LINE_EVENT_RETRY_JOB, job.data, {
        ...LINE_EVENT_RETRY_JOB_OPTIONS,
        jobId: `retry-${job.data.event.webhookEventId}`,
      });
      this.logger.warn(
        `Re-queued transient AI failure for ${job.data.event.webhookEventId} as a retry job`,
      );
    }
  }

  async processRetry(job: Job<LineEventJobData>): Promise<void> {
    try {
      await this.processQueuedJob(job, true);
    } catch (error) {
      if (!isRetryableAiProviderError(error)) {
        throw new UnrecoverableError(
          error instanceof Error ? error.message : 'LINE retry failed',
        );
      }
      throw error;
    }
  }

  private async processQueuedJob(
    job: Job<LineEventJobData>,
    isRetry: boolean,
  ): Promise<void> {
    const userId = job.data.event.source?.userId;

    if (!userId) return;

    const previous = this.userProcessingTails.get(userId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.processInOrder(job, isRetry));

    this.userProcessingTails.set(userId, current);

    try {
      await current;
    } finally {
      if (this.userProcessingTails.get(userId) === current) {
        this.userProcessingTails.delete(userId);
      }
    }
  }

  private async processInOrder(
    job: Job<LineEventJobData>,
    isRetry: boolean,
  ): Promise<void> {
    const { event } = job.data;
    const webhookEventId = event.webhookEventId;

    const allowed = await this.passesAbuseChecks(
      event,
      isRetry || job.attemptsMade > 0,
    );

    if (!allowed) return;

    const claimed = await this.lineWebhookService.claimWebhookEvent(event);

    if (!claimed) {
      this.logger.log(
        `Skipping LINE event ${webhookEventId}: already processed`,
      );
      return;
    }

    const heartbeat = setInterval(() => {
      void this.lineWebhookService
        .renewWebhookLease(webhookEventId, claimed)
        .catch((error: unknown) =>
          this.logger.error(`Webhook lease: ${String(error)}`),
        );
    }, 30_000);
    heartbeat.unref();
    try {
      await this.lineWebhookService.processEvent(event, claimed);
      await this.lineWebhookService.finishWebhookEvent(webhookEventId, claimed);
    } catch (error) {
      await this.lineWebhookService.finishWebhookEvent(
        webhookEventId,
        claimed,
        error,
      );
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async passesAbuseChecks(
    event: LineEventJobData['event'],
    isRetry: boolean,
  ): Promise<boolean> {
    const userId = event.source?.userId;

    if (!userId) return false;

    if (await this.banService.isBanned(userId)) {
      this.logger.debug(`Dropping event from banned user ${userId}`);
      return false;
    }

    if (isRetry) return true;

    const burst = await this.rateLimitService.consume(
      `rl:line:user:${userId}:burst`,
      this.userBurstLimit,
      this.userBurstWindowSec,
    );

    if (!burst.allowed) {
      this.logger.warn(
        `burst limit exceeded for user ${userId}: ${burst.current}/${burst.limit} 
          per ${this.userBurstWindowSec}s`,
      );
      await this.banService.addStrike(userId, 'burst limit exceeded');
      return false;
    }

    const hourly = await this.rateLimitService.consume(
      `rl:line:user:${userId}:hour`,
      this.userHourlyLimit,
      3600,
    );

    if (!hourly.allowed) {
      this.logger.warn(
        `hourly limit exceeded for user ${userId}: ${hourly.current}/${hourly.limit} per hour`,
      );
      await this.banService.addStrike(userId, 'hourly limit exceeded');
      return false;
    }

    if (event.type === 'message' && event.message.type === 'text') {
      const spamCheck = await this.spamDetectorService.check(
        userId,
        event.message.text,
      );

      if (spamCheck.spam) {
        this.logger.warn(
          `spam detected from user ${userId}: ${spamCheck.reason}`,
        );
        await this.banService.addStrike(userId, spamCheck.reason ?? 'spam');
        return false;
      }
    }

    return true;
  }
}
