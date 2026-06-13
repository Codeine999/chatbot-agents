import { Module } from '@nestjs/common';
import { ChatbotModule } from '../chatbot/chatbot.module';
import { PipelineController } from './pipeline.controller';


@Module({
  imports: [ChatbotModule],
  controllers: [PipelineController],
  // providers: [PipelineService],
  // exports: [PipelineService],
})
export class PipelineModule {}
