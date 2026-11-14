import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChannelGatewayModule } from './core/channel-gateway.module';
import { LineModule } from './line/line.module';
import { ChatEventsQueueModule } from '../conversation/queue/chat-events-queue.module';
import { ChatEventsProcessor } from './chat-events.processor';

/** Runs the shared queue's worker over the LINE and connector handlers. */
@Module({
  imports: [
    ConfigModule,
    ChatEventsQueueModule,
    LineModule,
    ChannelGatewayModule,
  ],
  providers: [ChatEventsProcessor],
})
export class ChatEventsWorkerModule {}
