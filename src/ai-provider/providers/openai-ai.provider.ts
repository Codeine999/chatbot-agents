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

type OpenAiResponsePayload = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
};

@Injectable()
export class OpenAiProvider implements AiProviderAdapter {
  readonly name = 'OPENAI' as const;
  private readonly logger = new Logger(OpenAiProvider.name);

  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.configService.get<string>('OPENAI_API_KEY')?.trim());
  }

  async generate(
    request: AiProviderGenerateRequest,
  ): Promise<AiGenerateResponse> {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY')?.trim();

    if (!apiKey) {
      throw new ServiceUnavailableException('OPENAI API key is not configured');
    }

    const baseUrl = (
      this.configService.get<string>('OPENAI_BASE_URL') ??
      'https://api.openai.com/v1'
    ).replace(/\/$/, '');

    try {
      const response = await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          instructions: request.systemInstruction,
          input: request.messages.map((message) => ({
            role: message.role,
            content: this.toContent(message),
          })),
          temperature: request.temperature,
          max_output_tokens:
            request.maxOutputTokens ?? DEFAULT_AI_MAX_OUTPUT_TOKENS,
        }),
        signal: AbortSignal.timeout(
          Number(
            this.configService.get<string>('OPENAI_REQUEST_TIMEOUT_MS') ??
              DEFAULT_AI_REQUEST_TIMEOUT_MS,
          ),
        ),
      });

      if (!response.ok) {
        this.logger.error(
          `OpenAI API request failed with status=${response.status}`,
        );
        throw new BadGatewayException('OpenAI generation failed');
      }

      const payload = (await response.json()) as OpenAiResponsePayload;

      return {
        text: this.extractText(payload),
        provider: this.name,
        model: request.model,
      };
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      this.logger.error(`OpenAI generation failed: ${String(error)}`);
      throw new BadGatewayException('OpenAI generation failed');
    }
  }

  private toContent(message: AiProviderGenerateRequest['messages'][number]) {
    if (!message.images?.length) return message.text;

    return [
      { type: 'input_text', text: message.text },
      ...message.images.map((image) => ({
        type: 'input_image',
        image_url: `data:${image.mediaType};base64,${image.data}`,
        detail: 'auto',
      })),
    ];
  }

  private extractText(payload: OpenAiResponsePayload): string {
    if (payload.output_text?.trim()) return payload.output_text.trim();

    return (payload.output ?? [])
      .flatMap((item) => item.content ?? [])
      .filter((item) => item.type === 'output_text' && item.text)
      .map((item) => item.text!.trim())
      .filter(Boolean)
      .join('\n');
  }
}
