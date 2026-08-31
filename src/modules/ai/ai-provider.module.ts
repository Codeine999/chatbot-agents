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
import { OpenAiProvider } from '../../ai-provider/providers/openai-ai.provider';
import { AI_PROVIDER_ADAPTERS } from '../../ai-provider/providers/ai-provider.registry';
import type { AiProviderAdapter } from '../../ai-provider/providers/ai-provider.interface';
import { AiBillingModule } from '../usage/billing/ai-billing.module';
import { EmbeddingModule } from '../../infra/embedding/embedding.module';
import { EmbeddingService } from './embedding.service';

const AI_PROVIDER_ADAPTER_CLASSES = [
  GeminiAiProvider,
  OpenAiProvider,
  AnthropicAiProvider,
] as const;

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    RedisModule,
    EmbeddingModule,
    AiBillingModule,
  ],
  controllers: [AiProviderSettingsController],
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
  ],
  exports: [
    AiModelCatalogService,
    AiProviderSettingsService,
    AdminAiProviderSettingsService,
    UsersAiProviderService,
    AdminAiProviderService,
    EmbeddingService,
  ],
})
export class AiProviderModule {}
