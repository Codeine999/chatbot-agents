import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { LINE_CHAT_IMPORT_QUEUE } from './line-chat-import.config';
import { IMPORT_JOB_OPTIONS } from './line-chat-import.jobs';
import { LineChatImportHook } from './line-chat-import.hook';

/**
 * The import queue plus the webhook-side hook. Kept apart from the import
 * module so LineModule can enqueue without importing the whole feature.
 * Separate from `chat-events` so a heavy import never delays live chat.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: LINE_CHAT_IMPORT_QUEUE,
      defaultJobOptions: IMPORT_JOB_OPTIONS,
    }),
  ],
  providers: [LineChatImportHook],
  exports: [BullModule, LineChatImportHook],
})
export class LineChatImportQueueModule {}
