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
import { ProductSearchModule } from '../products/search/product-search.module';
import { CommerceAccessModule } from '../commerce/commerce-access.module';
import { CommerceTurnService } from '../commerce/commerce-turn.service';
import { ProductRetrievalService } from './knowledge/product/product-retrieval.service';
import { ProductAnswerService } from './knowledge/product/product-answer.service';

@Module({
  imports: [
    PrismaModule,
    AiProviderModule,
    ProductSearchModule,
    CommerceAccessModule,
  ],
  providers: [
    AiChatService,
    AiIntentClassifierService,
    AnswerPatternService,
    AnswerPatternCacheService,
    SemanticSearchService,
    MicroKnowledgeService,
    MicroKnowledgeVectorRepository,
    KnowledgeRetrievalService,
    CommerceTurnService,
    ProductRetrievalService,
    ProductAnswerService,
  ],
  exports: [
    AiChatService,
    AiIntentClassifierService,
    AnswerPatternCacheService,
    KnowledgeRetrievalService,
  ],
})
export class AiModule {}
