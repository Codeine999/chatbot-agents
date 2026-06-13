import { Module } from '@nestjs/common';
import { AiChatService } from './aichat.service';

@Module({
  providers: [AiChatService],
  exports: [AiChatService],
})
export class AiModule {}
