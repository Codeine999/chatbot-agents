import { Module } from '@nestjs/common';
import { ChatbotModule } from '../../chatbot/chatbot.module';
import { MessagingModule } from '../../conversation/message/messaging.module';
import { LineChannelAdapter } from './line-channel.adapter';
import { CompanyModule } from '../../admin/company/company.module';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { AiProviderModule } from '../../ai/ai-provider.module';
import {
  LineController,
  LineConversationController,
} from './inbox/line.controller';
import { LineDashboardController } from './inbox/line-dashboard.controller';
import { ChatEventsQueueModule } from '../../conversation/queue/chat-events-queue.module';
import { LineEventsProcessor } from './worker/line-events.processor';
import { LineService } from './delivery/line-reply.service';
import { LineAdminService } from './admin/line-admin.service';
import { LineAdminController } from './admin/line-admin.controller';
import { LineWebhookController } from './webhook/line-webhook.controller';
import { LineWebhookAdapter } from './webhook/line-webhook.adapter';
import { LineSignatureGuard } from './webhook/line-signature.guard';
import { LineWebhookService } from './line-webhook.service';
import { LineDeliveryService } from './delivery/line-delivery.service';
import { LineChannelModule } from './connection/line-channel.module';

import { NotificationModule } from '../../admin/notification/notification.module';
import { LineHandoffHandler } from './handoff/line-handoff.handler';

@Module({
  imports: [
    LineChannelModule,
    ChatbotModule,
    MessagingModule,
    CompanyModule,
    PipelineModule,
    AiProviderModule,
    ChatEventsQueueModule,
    NotificationModule,
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
    LineHandoffHandler,
  ],
  exports: [LineAdminService, LineEventsProcessor],
})
export class LineModule {}
