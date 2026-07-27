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
} from '../types/ai-provider.types';
import { AiProviderAdapter } from './ai-provider.interface';

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
      };
    } catch (error) {
      this.logger.error(`Gemini generation failed: ${String(error)}`);
      throw new BadGatewayException('Gemini generation failed');
    }
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
