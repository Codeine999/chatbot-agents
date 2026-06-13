import { Module } from '@nestjs/common';
import { ChatbotModule } from '../chatbot/chatbot.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { LineController } from './line.controller';
import { LineService } from './line-reply.service';

@Module({
  imports: [ChatbotModule, PipelineModule],
  controllers: [LineController],
  providers: [LineService],
})
export class LineModule {}
