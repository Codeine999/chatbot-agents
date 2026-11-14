import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CHAT_EVENTS_QUEUE, CHAT_EVENTS_RETENTION } from './chat-events.queue';

/** The shared queue, for modules that add jobs to it. The worker lives in ChatEventsWorkerModule. */
@Module({
  imports: [
    BullModule.registerQueue({
      name: CHAT_EVENTS_QUEUE,
      defaultJobOptions: { attempts: 1, ...CHAT_EVENTS_RETENTION },
    }),
  ],
  exports: [BullModule],
})
export class ChatEventsQueueModule {}
