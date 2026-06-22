import { Module } from '@nestjs/common';
import { ChatbotModule } from '../chatbot/chatbot.module';
import { CreditServiceModule } from '../creditService/credit.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { LineController, LineConversationController } from './line.controller';
import { LineService } from './line-reply.service';
import { LineWebhookService } from './line-webhook.service';

@Module({
  imports: [ChatbotModule, PipelineModule, CreditServiceModule],
  controllers: [LineController, LineConversationController],
  providers: [LineService, LineWebhookService],
})
export class LineModule {}
