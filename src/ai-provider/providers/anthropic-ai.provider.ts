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

type AnthropicResponsePayload = {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
};

@Injectable()
export class AnthropicAiProvider implements AiProviderAdapter {
  readonly name = 'ANTHROPIC' as const;
  private readonly logger = new Logger(AnthropicAiProvider.name);

  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.configService.get<string>('ANTHROPIC_API_KEY')?.trim());
  }

  async generate(
    request: AiProviderGenerateRequest,
  ): Promise<AiGenerateResponse> {
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY')?.trim();

    if (!apiKey) {
      throw new ServiceUnavailableException(
        'ANTHROPIC API key is not configured',
      );
    }

    const baseUrl = (
      this.configService.get<string>('ANTHROPIC_BASE_URL') ??
      'https://api.anthropic.com/v1'
    ).replace(/\/$/, '');

    try {
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          system: request.systemInstruction,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: this.toContent(message),
          })),
          temperature: request.temperature,
          max_tokens: request.maxOutputTokens ?? DEFAULT_AI_MAX_OUTPUT_TOKENS,
        }),
        signal: AbortSignal.timeout(
          Number(
            this.configService.get<string>('ANTHROPIC_REQUEST_TIMEOUT_MS') ??
              DEFAULT_AI_REQUEST_TIMEOUT_MS,
          ),
        ),
      });

      if (!response.ok) {
        this.logger.error(
          `Anthropic API request failed with status=${response.status}`,
        );
        throw new BadGatewayException('Anthropic generation failed');
      }

      const payload = (await response.json()) as AnthropicResponsePayload;

      return {
        text: (payload.content ?? [])
          .filter((item) => item.type === 'text' && item.text)
          .map((item) => item.text!.trim())
          .filter(Boolean)
          .join('\n'),
        provider: this.name,
        model: request.model,
      };
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      this.logger.error(`Anthropic generation failed: ${String(error)}`);
      throw new BadGatewayException('Anthropic generation failed');
    }
  }

  private toContent(message: AiProviderGenerateRequest['messages'][number]) {
    if (!message.images?.length) return message.text;

    return [
      { type: 'text', text: message.text },
      ...message.images.map((image) => ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mediaType,
          data: image.data,
        },
      })),
    ];
  }
}
