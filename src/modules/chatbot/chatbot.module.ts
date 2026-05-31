import { Module } from '@nestjs/common';
import { CustomerInfoExtractorService } from './customer-info-extractor.service';
import { MessageAnalyzerService } from './message-analyzer.service';

@Module({
  providers: [CustomerInfoExtractorService, MessageAnalyzerService],
  exports: [MessageAnalyzerService],
})
export class ChatbotModule {}
