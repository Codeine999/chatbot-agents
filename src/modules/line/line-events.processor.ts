import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  LINE_EVENT_MAX_AGE_MS,
  LINE_EVENTS_QUEUE,
  type LineEventJobData,
} from './line-events.queue';
import { LineWebhookService } from './line-webhook.service';

@Processor(LINE_EVENTS_QUEUE, {
  concurrency: 5,
  limiter: {
    max: 10,
    duration: 1000,
  },
})
export class LineEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(LineEventsProcessor.name);

  constructor(private readonly lineWebhookService: LineWebhookService) {
    super();
  }

  async process(job: Job<LineEventJobData>): Promise<void> {
    const { event } = job.data;
    const webhookEventId = event.webhookEventId;

    const eventAgeMs = Date.now() - (event.timestamp || job.timestamp);

    if (eventAgeMs > LINE_EVENT_MAX_AGE_MS) {
      this.logger.warn(
        `Dropping LINE event ${webhookEventId}: age ${eventAgeMs}ms exceeds ${LINE_EVENT_MAX_AGE_MS}ms, reply token is likely expired`,
      );
      return;
    }

    const claimed = await this.lineWebhookService.claimWebhookEvent(webhookEventId);

    if (!claimed) {
      this.logger.log(
        `Skipping LINE event ${webhookEventId}: already processed`,
      );
      return;
    }

    try {
      await this.lineWebhookService.processEvent(event);
    } catch (error) {
      // processEvent only throws before a reply is sent, so releasing the
      // claim here cannot lead to a duplicate reply on retry.
      await this.lineWebhookService.releaseWebhookEvent(webhookEventId);
      throw error;
    }
  }
}
