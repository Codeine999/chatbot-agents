import { Module } from '@nestjs/common';
import { AiProviderModule } from '../ai/ai-provider.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AiChatService } from './aichat.service';
import { AiIntentClassifierService } from './ai-intent-classifier.service';
import { AnswerPatternService } from './knowledge/answer-pattern.service';
import { AnswerPatternCacheService } from './knowledge/answer-pattern-cache.service';
import { SemanticSearchService } from './knowledge/semantic-search.service';
import { KnowledgeRetrievalService } from './knowledge/knowledge-retrieval.service';
import { MicroKnowledgeService } from './knowledge/micro-knowledge.service';
import { MicroKnowledgeVectorRepository } from '../ai/embeding/micro-knowledge-vector.repository';

@Module({
  imports: [PrismaModule, AiProviderModule],
  providers: [
    AiChatService,
    AiIntentClassifierService,
    AnswerPatternService,
    AnswerPatternCacheService,
    SemanticSearchService,
    MicroKnowledgeService,
    MicroKnowledgeVectorRepository,
    KnowledgeRetrievalService,
  ],
  exports: [
    AiChatService,
    AiIntentClassifierService,
    AnswerPatternCacheService,
    KnowledgeRetrievalService,
  ],
})
export class AiModule {}
