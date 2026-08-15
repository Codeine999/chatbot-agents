import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../infra/redis/redis.module';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AI_PROVIDER_SETTING_CACHE_PREFIX,
  DEFAULT_AI_PROVIDER_CACHE_TTL_SEC,
} from '../../ai-provider/utils/ai-provider.constants';
import { AiModelCatalogService } from './ai-setting/ai-model-catalog.service';
import {
  AiProviderName,
  AiProviderRuntimeSetting,
  AiProviderScope,
  isAiProviderName,
  isAiProviderScope,
} from '../../ai-provider/types/ai-provider.types';

@Injectable()
export class AiProviderSettingsService {
  private readonly logger = new Logger(AiProviderSettingsService.name);
  private readonly cacheTtlSec: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogService: AiModelCatalogService,
    configService: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    const configuredCacheTtl = Number(
      configService.get<string>('AI_PROVIDER_CACHE_TTL_SEC') ??
        DEFAULT_AI_PROVIDER_CACHE_TTL_SEC,
    );
    this.cacheTtlSec = Number.isFinite(configuredCacheTtl)
      ? Math.max(30, configuredCacheTtl)
      : DEFAULT_AI_PROVIDER_CACHE_TTL_SEC;
  }

  async get(scope: AiProviderScope): Promise<AiProviderRuntimeSetting> {
    const cached = await this.readCache(scope);
    if (cached) return cached;

    const setting = await this.loadDatabaseSetting(scope);
    await this.writeCache(setting);
    return setting;
  }

  async getAll(): Promise<readonly AiProviderRuntimeSetting[]> {
    return Promise.all([this.get('USER'), this.get('ADMIN')]);
  }

  async update(
    scope: AiProviderScope,
    provider: AiProviderName,
    model: string,
  ): Promise<AiProviderRuntimeSetting> {
    const normalizedModel = model.trim();
    this.catalogService.assertSelectable(provider, normalizedModel);

    const setting = await this.prisma.aiProviderSetting.upsert({
      where: { scope },
      create: { scope, provider, model: normalizedModel },
      update: { provider, model: normalizedModel },
    });

    const runtimeSetting = this.toRuntimeSetting(setting);

    await this.writeCache(runtimeSetting);
    return runtimeSetting;
  }

  private async loadDatabaseSetting(
    scope: AiProviderScope,
  ): Promise<AiProviderRuntimeSetting> {
    const existing = await this.prisma.aiProviderSetting.findUnique({
      where: { scope },
    });

    if (existing) return this.toRuntimeSetting(existing);

    const fallback = this.catalogService.getDefaultSelection(scope);
    const created = await this.prisma.aiProviderSetting.upsert({
      where: { scope },
      create: { scope, ...fallback },
      update: {},
    });

    return this.toRuntimeSetting(created);
  }

  private async readCache(
    scope: AiProviderScope,
  ): Promise<AiProviderRuntimeSetting | null> {
    const key = this.cacheKey(scope);

    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;

      const parsed: unknown = JSON.parse(raw);
      if (this.isRuntimeSetting(parsed) && parsed.scope === scope) {
        return parsed;
      }

      this.logger.warn(`Discarding invalid AI provider cache key=${key}`);
      await this.redis.del(key);
    } catch (error) {
      // PostgreSQL remains available when Redis is temporarily unavailable.
      this.logger.warn(
        `Failed to read AI provider cache scope=${scope}: ${String(error)}`,
      );
    }

    return null;
  }

  private async writeCache(
    setting: AiProviderRuntimeSetting,
  ): Promise<boolean> {
    try {
      await this.redis.set(
        this.cacheKey(setting.scope),
        JSON.stringify(setting),
        'EX',
        this.cacheTtlSec,
      );
      return true;
    } catch (error) {
      // The durable database value is already correct; the cache will recover
      // on a later request instead of making provider selection unavailable.
      this.logger.warn(
        `Failed to cache AI provider setting scope=${setting.scope}: ${String(error)}`,
      );
      return false;
    }
  }

  private cacheKey(scope: AiProviderScope): string {
    return `${AI_PROVIDER_SETTING_CACHE_PREFIX}${scope.toLowerCase()}`;
  }

  private toRuntimeSetting(setting: {
    scope: string;
    provider: AiProviderName;
    model: string;
    updatedAt: Date;
  }): AiProviderRuntimeSetting {
    if (!isAiProviderScope(setting.scope)) {
      throw new Error(`Unsupported global AI provider scope=${setting.scope}`);
    }

    return {
      scope: setting.scope,
      provider: setting.provider,
      model: setting.model,
      updatedAt: setting.updatedAt.toISOString(),
    };
  }

  private isRuntimeSetting(value: unknown): value is AiProviderRuntimeSetting {
    if (!value || typeof value !== 'object') return false;

    const setting = value as Record<string, unknown>;
    return (
      isAiProviderScope(setting.scope) &&
      isAiProviderName(setting.provider) &&
      typeof setting.model === 'string' &&
      setting.model.trim().length > 0 &&
      typeof setting.updatedAt === 'string'
    );
  }
}
