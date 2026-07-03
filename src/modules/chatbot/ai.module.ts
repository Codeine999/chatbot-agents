import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AiChatService } from './aichat.service';
import { AiIntentClassifierService } from './ai-intent-classifier.service';
import { AnswerPatternService } from './answer-pattern.service';
import { EmbeddingService } from './embedding.service';
import { SemanticSearchService } from './semantic-search.service';
import { RerankService } from './rerank.service';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';

@Module({
  imports: [PrismaModule],
  providers: [
    AiChatService,
    AiIntentClassifierService,
    AnswerPatternService,
    EmbeddingService,
    SemanticSearchService,
    RerankService,
    KnowledgeRetrievalService,
  ],
  exports: [AiChatService, AiIntentClassifierService],
})
export class AiModule {}
