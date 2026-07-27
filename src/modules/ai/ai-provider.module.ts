import { Module } from '@nestjs/common';
import { AuthModule } from '../../infra/auth/auth.module';
import { RedisModule } from '../../infra/redis/redis.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminAiProviderService } from './admin-ai-provider.service';
import { AdminAiProviderSettingsService } from './admin-ai-provider-settings.service';
import { AiModelCatalogService } from './ai-model-catalog.service';
import { AiProviderSettingsController } from './ai-provider-settings.controller';
import { AiProviderSettingsService } from './ai-provider-settings.service';
import { AiProviderService } from './ai-provider.service';
import { UsersAiProviderService } from './users-ai-provider.service';
import { AnthropicAiProvider } from '../../ai-provider/providers/anthropic-ai.provider';
import { GeminiAiProvider } from '../../ai-provider/providers/gemini-ai.provider';
import { OpenAiProvider } from '../../ai-provider/providers/openai-ai.provider';
import { EmbeddingModule } from '../../infra/embedding/embedding.module';
import { EmbeddingService } from './embedding.service';

@Module({
  imports: [AuthModule, PrismaModule, RedisModule, EmbeddingModule],
  controllers: [AiProviderSettingsController],
  providers: [
    AiModelCatalogService,
    AiProviderSettingsService,
    AdminAiProviderSettingsService,
    GeminiAiProvider,
    OpenAiProvider,
    AnthropicAiProvider,
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
