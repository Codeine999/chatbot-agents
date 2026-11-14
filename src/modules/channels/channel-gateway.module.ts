import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationModule } from '../admin/notification/notification.module';
import { ChatbotModule } from '../chatbot/chatbot.module';
import { CommerceAccessModule } from '../commerce/commerce-access.module';
import { MessagingModule } from '../events/message/messaging.module';
import { ChatEventsQueueModule } from '../events/queue/chat-events-queue.module';
import { ChannelConnectorRegistry } from './channel-connector.registry';
import { ChannelEventsProcessor } from './channel-events.processor';
import { ChannelStoreHandoff } from './channel-handoff.handler';
import { ChannelInboundService } from './channel-inbound.service';
import { ChannelIngressService } from './channel-ingress.service';
import { ChannelOutboundService } from './channel-outbound.service';
import { ChannelStoreAdapter } from './channel-store.adapter';
import { ChannelWebhookController } from './channel-webhook.controller';
import { ChannelInboxController } from './inbox/channel-inbox.controller';
import { ChannelInboxService } from './inbox/channel-inbox.service';

/**
 * Hub of every non-LINE channel: webhook ingress, the shared
 * channel* store, outbound delivery, handoff and the admin inbox. Platforms
 * plug in as connectors (see ./facebook); the chatbot never sees which one.
 */
@Module({
  imports: [
    PrismaModule,
    ChatbotModule,
    MessagingModule,
    NotificationModule,
    CommerceAccessModule,
    ChatEventsQueueModule,
  ],
  controllers: [ChannelWebhookController, ChannelInboxController],
  providers: [
    ChannelConnectorRegistry,
    ChannelOutboundService,
    ChannelStoreAdapter,
    ChannelInboundService,
    ChannelIngressService,
    ChannelEventsProcessor,
    ChannelStoreHandoff,
    ChannelInboxService,
  ],
  exports: [
    ChannelConnectorRegistry,
    ChannelStoreAdapter,
    ChannelEventsProcessor,
  ],
})
export class ChannelGatewayModule {}
