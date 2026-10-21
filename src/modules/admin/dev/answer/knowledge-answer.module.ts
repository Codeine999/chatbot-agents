import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../../prisma/prisma.module';
import { AiProviderModule } from '../../../ai/ai-provider.module';
import { MicroKnowledgeVectorRepository } from '../../../ai/embeding/micro-knowledge-vector.repository';
import { AiModule } from '../../../chatbot/ai.module';
import { AdminKnowledgeMicroService } from '../../knowledge/admin-knowledge-micro.service';
import { AdminKnowledgePatternService } from '../../knowledge/admin-knowledge-pattern.service';
import { KnowledgeAnswerController } from './knowledge-answer.controller';
import { KnowledgeAnswerService } from './knowledge-answer.service';

@Module({
  imports: [PrismaModule, AiProviderModule, AiModule],
  controllers: [KnowledgeAnswerController],
  providers: [
    KnowledgeAnswerService,
    AdminKnowledgePatternService,
    AdminKnowledgeMicroService,
    MicroKnowledgeVectorRepository,
  ],
})
export class KnowledgeAnswerModule {}
