import { GoogleGenAI, type Content, type Part } from '@google/genai';
import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_AI_MAX_OUTPUT_TOKENS,
  DEFAULT_AI_REQUEST_TIMEOUT_MS,
} from '../utils/ai-provider.constants';
import {
  AiGenerateResponse,
  AiProviderGenerateRequest,
  AiTokenUsage,
} from '../types/ai-provider.types';
import { normalizeTokenUsage } from '../utils/token-usage.utils';
import { AiProviderAdapter } from './ai-provider.interface';
import {
  isTransientProviderFailure,
  RetryableAiProviderException,
} from '../errors/ai-provider-error';

type GeminiUsageMetadata = {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
};

@Injectable()
export class GeminiAiProvider implements AiProviderAdapter {
  readonly name = 'GEMINI' as const;
  private readonly logger = new Logger(GeminiAiProvider.name);

  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.configService.get<string>('GEMINI_API_KEY')?.trim());
  }

  async generate(
    request: AiProviderGenerateRequest,
  ): Promise<AiGenerateResponse> {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY')?.trim();

    if (!apiKey) {
      throw new ServiceUnavailableException('GEMINI API key is not configured');
    }

    try {
      const client = new GoogleGenAI({ apiKey });
      const response = await client.models.generateContent({
        model: request.model,
        contents: this.toContents(request),
        config: {
          systemInstruction: request.systemInstruction,
          temperature: request.temperature,
          maxOutputTokens:
            request.maxOutputTokens ?? DEFAULT_AI_MAX_OUTPUT_TOKENS,
          httpOptions: {
            timeout: Number(
              this.configService.get<string>('GEMINI_REQUEST_TIMEOUT_MS') ??
                DEFAULT_AI_REQUEST_TIMEOUT_MS,
            ),
          },
        },
      });

      return {
        text: response.text?.trim() ?? '',
        provider: this.name,
        model: request.model,
        usage: this.toUsage(response.usageMetadata),
        providerRequestId: response.responseId,
      };
    } catch (error) {
      this.logger.error(`Gemini generation failed: ${String(error)}`);
      if (isTransientProviderFailure(error)) {
        throw new RetryableAiProviderException(
          'Gemini generation temporarily failed',
        );
      }
      throw new BadGatewayException('Gemini generation failed');
    }
  }

  /**
   * `promptTokenCount` already includes cached content, and reasoning is
   * reported separately as `thoughtsTokenCount` but billed as output.
   */
  private toUsage(usage: GeminiUsageMetadata | undefined): AiTokenUsage {
    return normalizeTokenUsage({
      promptTokens: usage?.promptTokenCount,
      cachedInputTokens: usage?.cachedContentTokenCount,
      outputTokens:
        (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
      cachedInPrompt: true,
    });
  }

  private toContents(request: AiProviderGenerateRequest): Content[] {
    return request.messages.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [
        { text: message.text },
        ...(message.images ?? []).map(
          (image): Part => ({
            inlineData: {
              mimeType: image.mediaType,
              data: image.data,
            },
          }),
        ),
      ],
    }));
  }
}
