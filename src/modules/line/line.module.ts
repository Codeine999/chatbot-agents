import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ChatbotModule } from '../chatbot/chatbot.module';
import { CreditServiceModule } from '../creditService/credit.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { LineController, LineConversationController } from './line.controller';
import { LineEventsProcessor } from './line-events.processor';
import { LINE_EVENTS_QUEUE } from './line-events.queue';
import { LineService } from './line-reply.service';
import { LineSignatureGuard } from './line-signature.guard';
import { LineWebhookService } from './line-webhook.service';

@Module({
  imports: [
    ChatbotModule,
    PipelineModule,
    CreditServiceModule,
    BullModule.registerQueue({
      name: LINE_EVENTS_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 3600,
          count: 5000,
        },
        removeOnFail: {
          age: 24 * 3600,
        },
      },
    }),
  ],
  controllers: [LineController, LineConversationController],
  providers: [
    LineService,
    LineWebhookService,
    LineSignatureGuard,
    LineEventsProcessor,
  ],
})
export class LineModule {}
