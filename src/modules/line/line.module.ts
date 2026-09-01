import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ChatbotModule } from '../chatbot/chatbot.module';
import { CompanyModule } from '../admin/company/company.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { LineController, LineConversationController } from './line.controller';
import { LineDashboardController } from './line-dashboard.controller';
import {
  LineEventsProcessor,
  LineEventsRetryProcessor,
} from './line-events.processor';
import {
  LINE_EVENTS_QUEUE,
  LINE_EVENTS_RETRY_QUEUE,
} from './line-events.queue';
import { LineService } from './line-reply.service';
import { LineAdminService } from './admin/line-admin.service';
import { LineAdminController } from './admin/line-admin.controller';
import { LineSignatureGuard } from './line-signature.guard';
import { LineWebhookService } from './line-webhook.service';

@Module({
  imports: [
    ChatbotModule,
    CompanyModule,
    PipelineModule,
    BullModule.registerQueue({
      name: LINE_EVENTS_QUEUE,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: {
          age: 3600,
          count: 5000,
        },
        removeOnFail: {
          age: 24 * 3600,
        },
      },
    }),
    BullModule.registerQueue({
      name: LINE_EVENTS_RETRY_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 3600, count: 5000 },
        removeOnFail: { age: 24 * 3600 },
      },
    }),
  ],
  controllers: [
    LineController,
    LineConversationController,
    LineDashboardController,
    LineAdminController,
  ],
  providers: [
    LineService,
    LineAdminService,
    LineWebhookService,
    LineSignatureGuard,
    LineEventsProcessor,
    LineEventsRetryProcessor,
  ],
  exports: [LineAdminService],
})
export class LineModule {}
