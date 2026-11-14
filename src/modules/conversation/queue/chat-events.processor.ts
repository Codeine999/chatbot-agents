import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { ChannelEventsProcessor } from '../../channels/core/channel-events.processor';
import {
  CHANNEL_EVENT_JOB,
  type ChannelEventJobData,
} from '../../channels/core/channel-events.queue';
import { LineEventsProcessor } from '../../channels/line/worker/line-events.processor';
import {
  LINE_EVENT_JOB,
  LINE_EVENT_RETRY_JOB,
  type LineEventJobData,
} from '../../channels/line/worker/line-events.queue';
import {
  CHAT_EVENTS_CONCURRENCY,
  CHAT_EVENTS_QUEUE,
  CHAT_EVENTS_RATE_LIMIT,
  chatEventsWorkerSettings,
} from './chat-events.queue';

/**
 * The only worker of the shared queue. It owns concurrency and the rate
 * limit; what a job means belongs to the handler its name routes to.
 */
@Processor(CHAT_EVENTS_QUEUE, {
  concurrency: CHAT_EVENTS_CONCURRENCY,
  limiter: { ...CHAT_EVENTS_RATE_LIMIT },
})
export class ChatEventsProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(ChatEventsProcessor.name);
  private readonly settings: ReturnType<typeof chatEventsWorkerSettings>;

  constructor(
    private readonly line: LineEventsProcessor,
    private readonly channels: ChannelEventsProcessor,
    config: ConfigService,
  ) {
    super();
    this.settings = chatEventsWorkerSettings(config);
  }

  // The worker exists once every module has initialised. BullMQ reads
  // `concurrency` and `opts.limiter` on each fetch, so this takes effect
  // from the next job on.
  onApplicationBootstrap() {
    const { concurrency, rateLimit } = this.settings;
    this.worker.concurrency = concurrency;
    this.worker.opts.limiter = { ...rateLimit };
    this.logger.log(
      `Chat events worker concurrency=${concurrency}, limiter=${rateLimit.max}/${rateLimit.duration}ms`,
    );
  }

  process(job: Job): Promise<void> {
    switch (job.name) {
      case LINE_EVENT_JOB:
        return this.line.process(job as Job<LineEventJobData>);
      case LINE_EVENT_RETRY_JOB:
        return this.line.processRetry(job as Job<LineEventJobData>);
      case CHANNEL_EVENT_JOB:
        return this.channels.process(job as Job<ChannelEventJobData>);
      default:
        throw new UnrecoverableError(`Unknown chat event job: ${job.name}`);
    }
  }
}
