import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AiChatService } from './aichat.service';
import { AiIntentClassifierService } from './ai-intent-classifier.service';
import { AnswerPatternService } from './knowledge/answer-pattern.service';
import { AnswerPatternCacheService } from './knowledge/answer-pattern-cache.service';
import { KnowledgeCandidateService } from './knowledge/knowledge-candidate.service';
import { EmbeddingService } from './knowledge/embedding.service';
import { SemanticSearchService } from './knowledge/semantic-search.service';
import { KnowledgeRetrievalService } from './knowledge/knowledge-retrieval.service';

@Module({
  imports: [PrismaModule],
  providers: [
    AiChatService,
    AiIntentClassifierService,
    AnswerPatternService,
    AnswerPatternCacheService,
    KnowledgeCandidateService,
    EmbeddingService,
    SemanticSearchService,
    KnowledgeRetrievalService,
  ],
  exports: [AiChatService, AiIntentClassifierService, KnowledgeCandidateService],
})
export class AiModule {}
