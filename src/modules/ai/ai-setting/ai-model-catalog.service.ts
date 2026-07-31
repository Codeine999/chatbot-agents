import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AI_PROVIDER_LABELS } from '../../../ai-provider/utils/ai-provider.constants';
import {
  AI_PROVIDER_NAMES,
  AiProviderCatalogItem,
  AiProviderName,
  AiProviderScope,
  isAiProviderName,
} from '../../../ai-provider/types/ai-provider.types';

@Injectable()
export class AiModelCatalogService {
  constructor(private readonly configService: ConfigService) {}

  getCatalog(): readonly AiProviderCatalogItem[] {
    return AI_PROVIDER_NAMES.map((provider) => ({
      provider,
      label: AI_PROVIDER_LABELS[provider],
      available: this.hasApiKey(provider),
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
    ];

    if (provider === 'GEMINI') {
      candidates.push(
        this.configService.get<string>('GEMINI_MODEL') ??
          'gemini-3.1-flash-lite',
      );
    }

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
      : 'GEMINI';
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
      throw new ServiceUnavailableException(
        `${provider} API key is not configured`,
      );
    }
  }

  private hasApiKey(provider: AiProviderName): boolean {
    const keyName =
      provider === 'GEMINI'
        ? 'GEMINI_API_KEY'
        : provider === 'OPENAI'
          ? 'OPENAI_API_KEY'
          : 'ANTHROPIC_API_KEY';

    return Boolean(this.configService.get<string>(keyName)?.trim());
  }

  private getScopedModels(provider: AiProviderName): Array<string | undefined> {
    return (['USER'] as const).map((scope) => {
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
