import { Module } from '@nestjs/common';
import { ChatbotModule } from '../../chatbot/chatbot.module';
import { MessageProcessorService } from './message-processor.service';

@Module({
  imports: [ChatbotModule],
  providers: [MessageProcessorService],
  exports: [MessageProcessorService],
})
export class MessagingModule {}
