import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { isRetryableAiProviderError } from '../../ai-provider/errors/ai-provider-error';
import { BanService } from '../abuse/ban.service';
import { SpamDetectorService } from '../abuse/spam-detector.service';
import { RateLimitService } from '../usage/rate-limit/rate-limit.service';
import {
  LINE_EVENT_MAX_AGE_MS,
  LINE_EVENT_JOB,
  LINE_EVENTS_CONCURRENCY,
  LINE_EVENTS_QUEUE,
  LINE_EVENTS_RETRY_CONCURRENCY,
  LINE_EVENTS_RETRY_QUEUE,
  type LineEventJobData,
} from './line-events.queue';
import { LineWebhookService } from './line-webhook.service';

@Processor(LINE_EVENTS_QUEUE, {
  concurrency: LINE_EVENTS_CONCURRENCY,
  limiter: {
    max: 12,
    duration: 1000,
  },
})
export class LineEventsProcessor extends WorkerHost {
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
    @InjectQueue(LINE_EVENTS_RETRY_QUEUE)
    private readonly retryQueue: Queue<LineEventJobData>,
    configService: ConfigService,
  ) {
    super();
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

      await this.retryQueue.add(LINE_EVENT_JOB, job.data, {
        jobId: `retry-${job.data.event.webhookEventId}`,
      });
      this.logger.warn(
        `Moved transient AI failure for ${job.data.event.webhookEventId} to retry queue`,
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

    const eventAgeMs = Date.now() - (event.timestamp || job.timestamp);

    if (eventAgeMs > LINE_EVENT_MAX_AGE_MS) {
      this.logger.warn(
        `Dropping LINE event ${webhookEventId}: age ${eventAgeMs}ms 
         exceeds ${LINE_EVENT_MAX_AGE_MS}ms, reply token is likely expired`,
      );
      return;
    }

    const allowed = await this.passesAbuseChecks(
      event,
      isRetry || job.attemptsMade > 0,
    );

    if (!allowed) return;

    const claimed =
      await this.lineWebhookService.claimWebhookEvent(webhookEventId);

    if (!claimed) {
      this.logger.log(
        `Skipping LINE event ${webhookEventId}: already processed`,
      );
      return;
    }

    try {
      await this.lineWebhookService.processEvent(event);
    } catch (error) {
      await this.lineWebhookService.releaseWebhookEvent(webhookEventId);
      throw error;
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

@Processor(LINE_EVENTS_RETRY_QUEUE, {
  concurrency: LINE_EVENTS_RETRY_CONCURRENCY,
})
export class LineEventsRetryProcessor extends WorkerHost {
  constructor(private readonly eventsProcessor: LineEventsProcessor) {
    super();
  }

  process(job: Job<LineEventJobData>): Promise<void> {
    return this.eventsProcessor.processRetry(job);
  }
}
