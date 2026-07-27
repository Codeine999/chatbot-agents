import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AiProviderSettingsService } from './ai-provider-settings.service';
import { AiProviderAdapter } from '../../ai-provider/providers/ai-provider.interface';
import { AnthropicAiProvider } from '../../ai-provider/providers/anthropic-ai.provider';
import { GeminiAiProvider } from '../../ai-provider/providers/gemini-ai.provider';
import { OpenAiProvider } from '../../ai-provider/providers/openai-ai.provider';
import {
  AiGenerateRequest,
  AiGenerateResponse,
  AiProviderName,
  AiProviderScope,
} from '../../ai-provider/types/ai-provider.types';

@Injectable()
export class AiProviderService {
  private readonly providers: ReadonlyMap<AiProviderName, AiProviderAdapter>;

  constructor(
    private readonly settingsService: AiProviderSettingsService,
    geminiProvider: GeminiAiProvider,
    openAiProvider: OpenAiProvider,
    anthropicProvider: AnthropicAiProvider,
  ) {
    this.providers = new Map<AiProviderName, AiProviderAdapter>([
      [geminiProvider.name, geminiProvider],
      [openAiProvider.name, openAiProvider],
      [anthropicProvider.name, anthropicProvider],
    ]);
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

    return provider.generate({
      ...request,
      model,
    });
  }
}
