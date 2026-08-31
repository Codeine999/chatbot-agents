import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AI_PROVIDER_LABELS,
  AI_PROVIDER_TEXT_MODELS,
} from '../../../ai-provider/utils/ai-provider.constants';
import { AI_PROVIDER_ADAPTERS } from '../../../ai-provider/providers/ai-provider.registry';
import type { AiProviderAdapterRegistry } from '../../../ai-provider/providers/ai-provider.registry';
import {
  AI_PROVIDER_NAMES,
  AiProviderCatalogItem,
  AiProviderName,
  AiProviderScope,
  isAiProviderName,
} from '../../../ai-provider/types/ai-provider.types';

@Injectable()
export class AiModelCatalogService {
  private readonly providerAdapters: ReadonlyMap<
    AiProviderName,
    AiProviderAdapterRegistry[number]
  >;

  constructor(
    private readonly configService: ConfigService,
    @Inject(AI_PROVIDER_ADAPTERS)
    adapters: AiProviderAdapterRegistry,
  ) {
    this.providerAdapters = new Map(
      adapters.map((adapter) => [adapter.name, adapter]),
    );
  }

  getCatalog(): readonly AiProviderCatalogItem[] {
    return AI_PROVIDER_NAMES.map((provider) => ({
      provider,
      label: AI_PROVIDER_LABELS[provider],
      available: this.isProviderAvailable(provider),
      models: this.getModels(provider),
    }));
  }

  getModels(provider: AiProviderName): readonly string[] {
    const candidates = [
      ...this.parseList(
        this.configService.get<string>(`AI_${provider}_MODELS`),
      ),
      this.configService.get<string>(`${provider}_MODEL`),
      ...this.getScopedModels(provider),
      ...AI_PROVIDER_TEXT_MODELS[provider],
    ];

    return [
      ...new Set(candidates.map((model) => model?.trim()).filter(Boolean)),
    ] as string[];
  }

  getDefaultSelection(scope: AiProviderScope): {
    provider: AiProviderName;
    model: string;
  } {
    const configuredProvider = this.configService
      .get<string>(`AI_${scope}_PROVIDER`)
      ?.trim()
      .toUpperCase();
    const provider = isAiProviderName(configuredProvider)
      ? configuredProvider
      : (this.getCatalog().find((item) => item.available)?.provider ??
        'GEMINI');
    const configuredModel = this.configService
      .get<string>(`AI_${scope}_MODEL`)
      ?.trim();
    const model = configuredModel || this.getModels(provider)[0];

    if (!model) {
      throw new ServiceUnavailableException(
        `No model is configured for ${provider} in ${scope}`,
      );
    }

    return { provider, model };
  }

  getDefaultModel(provider: AiProviderName): string {
    const model = this.getModels(provider)[0];

    if (!model) {
      throw new ServiceUnavailableException(
        `No model is configured for ${provider}`,
      );
    }

    return model;
  }

  assertSelectable(provider: AiProviderName, model: string): void {
    const catalog = this.getCatalog().find(
      (item) => item.provider === provider,
    );

    if (!catalog || !catalog.models.includes(model)) {
      throw new BadRequestException(
        `Model ${model} is not allowed for provider ${provider}`,
      );
    }

    if (!catalog.available) {
      throw new ServiceUnavailableException(`${provider} is not configured`);
    }
  }

  isConfiguredModel(provider: AiProviderName, model: string): boolean {
    return this.getModels(provider).includes(model.trim());
  }

  private isProviderAvailable(provider: AiProviderName): boolean {
    return this.providerAdapters.get(provider)?.isConfigured() ?? false;
  }

  private getScopedModels(provider: AiProviderName): Array<string | undefined> {
    return (['USER', 'ADMIN'] as const).map((scope) => {
      const scopeProvider = this.configService
        .get<string>(`AI_${scope}_PROVIDER`)
        ?.trim()
        .toUpperCase();

      return scopeProvider === provider
        ? this.configService.get<string>(`AI_${scope}_MODEL`)
        : undefined;
    });
  }

  private parseList(value?: string): string[] {
    return value
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
  }
}
