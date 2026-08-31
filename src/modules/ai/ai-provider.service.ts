import { setTimeout as delay } from 'node:timers/promises';
import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isRetryableAiProviderError } from '../../ai-provider/errors/ai-provider-error';
import {
  DEFAULT_AI_MAX_ATTEMPTS,
  DEFAULT_AI_RETRY_BUDGET_MS,
  DEFAULT_AI_RETRY_DELAY_MS,
} from '../../ai-provider/utils/ai-provider.constants';
import { AiProviderSettingsService } from './ai-provider-settings.service';
import { AiProviderAdapter } from '../../ai-provider/providers/ai-provider.interface';
import { AI_PROVIDER_ADAPTERS } from '../../ai-provider/providers/ai-provider.registry';
import type { AiProviderAdapterRegistry } from '../../ai-provider/providers/ai-provider.registry';
import {
  AiGenerateRequest,
  AiGenerateResponse,
  AiProviderName,
  AiProviderScope,
} from '../../ai-provider/types/ai-provider.types';

@Injectable()
export class AiProviderService {
  private readonly logger = new Logger(AiProviderService.name);
  private readonly providers: ReadonlyMap<AiProviderName, AiProviderAdapter>;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly retryBudgetMs: number;

  constructor(
    private readonly settingsService: AiProviderSettingsService,
    @Inject(AI_PROVIDER_ADAPTERS)
    providerAdapters: AiProviderAdapterRegistry,
    configService: ConfigService,
  ) {
    this.providers = this.createProviderMap(providerAdapters);

    this.maxAttempts = this.positiveNumber(
      configService.get('AI_PROVIDER_MAX_ATTEMPTS'),
      DEFAULT_AI_MAX_ATTEMPTS,
    );
    this.retryDelayMs = this.positiveNumber(
      configService.get('AI_PROVIDER_RETRY_DELAY_MS'),
      DEFAULT_AI_RETRY_DELAY_MS,
    );
    this.retryBudgetMs = this.positiveNumber(
      configService.get('AI_PROVIDER_RETRY_BUDGET_MS'),
      DEFAULT_AI_RETRY_BUDGET_MS,
    );
  }

  async generate(
    scope: AiProviderScope,
    request: AiGenerateRequest,
  ): Promise<AiGenerateResponse> {
    const setting = await this.settingsService.get(scope);
    return this.generateWith(setting.provider, setting.model, request);
  }

  async generateWith(
    providerName: AiProviderName,
    model: string,
    request: AiGenerateRequest,
  ): Promise<AiGenerateResponse> {
    const provider = this.providers.get(providerName);

    if (!provider || !provider.isConfigured()) {
      throw new ServiceUnavailableException(
        `${providerName} is not configured`,
      );
    }

    return this.generateWithRetry(provider, model, request);
  }

  /**
   * Retries a transient provider failure in place, inside the one billed call.
   *
   * Doing it here rather than by re-queuing the LINE job matters twice over:
   * the reservation and settlement stay paired to a single wallet hold, and
   * the sibling calls of the same turn (intent classifier, query planner) are
   * not re-run and re-charged for one flaky HTTP response.
   */
  private async generateWithRetry(
    provider: AiProviderAdapter,
    model: string,
    request: AiGenerateRequest,
  ): Promise<AiGenerateResponse> {
    const startedAt = Date.now();
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await provider.generate({ ...request, model });
      } catch (error) {
        lastError = error;

        const elapsedMs = Date.now() - startedAt;
        const canRetry =
          attempt < this.maxAttempts &&
          isRetryableAiProviderError(error) &&
          elapsedMs < this.retryBudgetMs;

        if (!canRetry) break;

        this.logger.warn(
          `Retrying ${provider.name}/${model} after transient failure ` +
            `(attempt ${attempt}/${this.maxAttempts}, ${elapsedMs}ms elapsed)`,
        );
        await delay(this.retryDelayMs);
      }
    }

    throw lastError;
  }

  private positiveNumber(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private createProviderMap(
    adapters: AiProviderAdapterRegistry,
  ): ReadonlyMap<AiProviderName, AiProviderAdapter> {
    const providers = new Map<AiProviderName, AiProviderAdapter>();

    for (const adapter of adapters) {
      if (providers.has(adapter.name)) {
        throw new Error(`Duplicate AI provider adapter: ${adapter.name}`);
      }
      providers.set(adapter.name, adapter);
    }

    return providers;
  }
}
