import { Module } from '@nestjs/common';
import { ChatbotModule } from '../chatbot/chatbot.module';
import { MessagingModule } from '../events/message/messaging.module';
import { LineChannelAdapter } from './line-channel.adapter';
import { CompanyModule } from '../admin/company/company.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { AiProviderModule } from '../ai/ai-provider.module';
import { LineController, LineConversationController } from './line.controller';
import { LineDashboardController } from './line-dashboard.controller';
import { ChatEventsQueueModule } from '../events/queue/chat-events-queue.module';
import { LineEventsProcessor } from './line-events.processor';
import { LineService } from './line-reply.service';
import { LineAdminService } from './admin/line-admin.service';
import { LineAdminController } from './admin/line-admin.controller';
import { LineWebhookController } from './line-webhook.controller';
import { LineWebhookAdapter } from './line-webhook.adapter';
import { LineSignatureGuard } from './line-signature.guard';
import { LineWebhookService } from './line-webhook.service';
import { LineDeliveryService } from './line-delivery.service';
import { LineChannelModule } from './channel/line-channel.module';

@Module({
  imports: [
    LineChannelModule,
    ChatbotModule,
    MessagingModule,
    CompanyModule,
    PipelineModule,
    AiProviderModule,
    ChatEventsQueueModule,
  ],
  controllers: [
    LineWebhookController,
    LineController,
    LineConversationController,
    LineDashboardController,
    LineAdminController,
  ],
  providers: [
    LineService,
    LineAdminService,
    LineWebhookService,
    LineChannelAdapter,
    LineDeliveryService,
    LineSignatureGuard,
    LineWebhookAdapter,
    LineEventsProcessor,
  ],
  exports: [LineAdminService, LineEventsProcessor],
})
export class LineModule {}
