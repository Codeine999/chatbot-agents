import { Module } from '@nestjs/common';
import { LineModule } from '../line.module';
import { LineChatImportController } from './line-chat-import.controller';
import { LineChatImportProcessor } from './line-chat-import.processor';
import { LineChatImportQueueModule } from './line-chat-import-queue.module';
import { LineChatImportRunner } from './line-chat-import.runner';
import { LineChatImportService } from './line-chat-import.service';
import { LineChatImportStorage } from './line-chat-import.storage';
import { LineChatImportWriter } from './line-chat-import.writer';

/** LINE OA chat history import (docs/line-chat-import-plan.md). Off unless LINE_IMPORT_ENABLED=true. */
@Module({
  imports: [LineModule, LineChatImportQueueModule],
  controllers: [LineChatImportController],
  providers: [
    LineChatImportStorage,
    LineChatImportWriter,
    LineChatImportRunner,
    LineChatImportService,
    LineChatImportProcessor,
  ],
})
export class LineChatImportModule {}
