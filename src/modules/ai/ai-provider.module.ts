import { Module } from '@nestjs/common';
import { AuthModule } from '../admin/auth/auth.module';
import { RedisModule } from '../../infra/redis/redis.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminAiProviderService } from './admin-ai-provider.service';
import { AdminAiProviderSettingsService } from './ai-setting/admin-ai-provider-settings.service';
import { AiModelCatalogService } from './ai-setting/ai-model-catalog.service';
import { AiProviderSettingsController } from './ai-setting/ai-provider-settings.controller';
import { AiProviderSettingsService } from './ai-provider-settings.service';
import { AiProviderService } from './ai-provider.service';
import { UsersAiProviderService } from './users-ai-provider.service';
import { AnthropicAiProvider } from '../../ai-provider/providers/anthropic-ai.provider';
import { GeminiAiProvider } from '../../ai-provider/providers/gemini-ai.provider';
import { MaxPlusProvider } from '../../ai-provider/providers/maxPlus-ai.provider';
import { OpenAiProvider } from '../../ai-provider/providers/openai-ai.provider';
import { AI_PROVIDER_ADAPTERS } from '../../ai-provider/providers/ai-provider.registry';
import type { AiProviderAdapter } from '../../ai-provider/providers/ai-provider.interface';
import { AiBillingModule } from '../usage/billing/ai-billing.module';
import { EmbeddingModule } from '../../infra/embedding/embedding.module';
import { EmbeddingService } from './embeding/embedding.service';
import { EmbeddingAdminService } from './embeding/embedding-admin.service';
import { EmbeddingHealthService } from './embeding/embedding-health.service';
import { AnswerPatternVectorRepository } from './embeding/answer-pattern-vector.repository';
import { EmbeddingController } from './embeding/embedding.controller';
import { EmbeddingHealthController } from './embeding/embedding-health.controller';
import { CompanyModule } from '../admin/company/company.module';

const AI_PROVIDER_ADAPTER_CLASSES = [
  GeminiAiProvider,
  OpenAiProvider,
  AnthropicAiProvider,
  MaxPlusProvider,
] as const;

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    RedisModule,
    EmbeddingModule,
    AiBillingModule,
    CompanyModule,
  ],
  controllers: [
    AiProviderSettingsController,
    EmbeddingController,
    EmbeddingHealthController,
  ],
  providers: [
    AiModelCatalogService,
    AiProviderSettingsService,
    AdminAiProviderSettingsService,
    ...AI_PROVIDER_ADAPTER_CLASSES,
    {
      provide: AI_PROVIDER_ADAPTERS,
      inject: [...AI_PROVIDER_ADAPTER_CLASSES],
      useFactory: (...adapters: AiProviderAdapter[]) => adapters,
    },
    AiProviderService,
    UsersAiProviderService,
    AdminAiProviderService,
    EmbeddingService,
    AnswerPatternVectorRepository,
    EmbeddingAdminService,
    EmbeddingHealthService,
  ],
  exports: [
    AiModelCatalogService,
    AiProviderSettingsService,
    AdminAiProviderSettingsService,
    UsersAiProviderService,
    AdminAiProviderService,
    EmbeddingService,
    AnswerPatternVectorRepository,
  ],
})
export class AiProviderModule {}
