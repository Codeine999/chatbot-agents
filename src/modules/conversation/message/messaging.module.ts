import { Module } from '@nestjs/common';
import { ChatbotModule } from '../../chatbot/chatbot.module';
import { MessageProcessorService } from './message-processor.service';
import { PipelineSwitchService } from './pipeline-switch.service';

@Module({
  imports: [ChatbotModule],
  providers: [MessageProcessorService, PipelineSwitchService],
  exports: [MessageProcessorService, PipelineSwitchService],
})
export class MessagingModule {}
