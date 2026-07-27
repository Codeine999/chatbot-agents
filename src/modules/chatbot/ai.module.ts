import { Module } from '@nestjs/common';
import { AiProviderModule } from '../ai/ai-provider.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AiChatService } from './aichat.service';
import { AiIntentClassifierService } from './ai-intent-classifier.service';
import { AnswerPatternService } from './knowledge/answer-pattern.service';
import { AnswerPatternCacheService } from './knowledge/answer-pattern-cache.service';
import { KnowledgeCandidateService } from './knowledge/knowledge-candidate.service';
import { SemanticSearchService } from './knowledge/semantic-search.service';
import { KnowledgeRetrievalService } from './knowledge/knowledge-retrieval.service';

@Module({
  imports: [PrismaModule, AiProviderModule],
  providers: [
    AiChatService,
    AiIntentClassifierService,
    AnswerPatternService,
    AnswerPatternCacheService,
    KnowledgeCandidateService,
    SemanticSearchService,
    KnowledgeRetrievalService,
  ],
  exports: [
    AiChatService,
    AiIntentClassifierService,
    AnswerPatternCacheService,
    KnowledgeCandidateService,
  ],
})
export class AiModule {}
