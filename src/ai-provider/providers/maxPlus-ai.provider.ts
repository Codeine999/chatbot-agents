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

const DEFAULT_MAXPLUS_BASE_URL = 'https://api.maxplus-ai.cc/v1';

/** MaxPlus speaks the OpenAI *chat completions* dialect, not `/responses`. */
type MaxPlusResponsePayload = {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens?: number;
  };
};

@Injectable()
export class MaxPlusProvider implements AiProviderAdapter {
  readonly name = 'MAXPLUS' as const;
  private readonly logger = new Logger(MaxPlusProvider.name);

  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.configService.get<string>('MAXPLUS_API_KEY')?.trim());
  }

  async generate(
    request: AiProviderGenerateRequest,
  ): Promise<AiGenerateResponse> {
    const apiKey = this.configService.get<string>('MAXPLUS_API_KEY')?.trim();

    if (!apiKey) {
      throw new ServiceUnavailableException(
        'MAXPLUS API key is not configured',
      );
    }

    const baseUrl = (
      this.configService.get<string>('MAXPLUS_BASE_URL') ??
      DEFAULT_MAXPLUS_BASE_URL
    ).replace(/\/$/, '');

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          messages: this.toMessages(request),
          temperature: request.temperature,
          max_tokens: request.maxOutputTokens ?? DEFAULT_AI_MAX_OUTPUT_TOKENS,
          stream: false,
        }),
        signal: AbortSignal.timeout(
          Number(
            this.configService.get<string>('MAXPLUS_REQUEST_TIMEOUT_MS') ??
              DEFAULT_AI_REQUEST_TIMEOUT_MS,
          ),
        ),
      });

      if (!response.ok) {
        // The status alone cannot tell an unknown model from a bad key, and
        // MaxPlus explains itself in the body — log it or every 4xx is a
        // guess. Truncated because a rejected payload can be echoed back.
        this.logger.error(
          `MaxPlus API request failed with status=${response.status} body=${(
            await response.text().catch(() => '')
          ).slice(0, 500)}`,
        );
        if (response.status === 429 || response.status >= 500) {
          throw new RetryableAiProviderException(
            `MaxPlus generation temporarily failed (${response.status})`,
          );
        }
        throw new BadGatewayException(
          `MaxPlus generation rejected (${response.status})`,
        );
      }

      const payload = (await response.json()) as MaxPlusResponsePayload;

      return {
        text: this.extractText(payload),
        provider: this.name,
        model: request.model,
        usage: this.toUsage(payload),
        providerRequestId: payload.id,
      };
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      this.logger.error(`MaxPlus generation failed: ${String(error)}`);
      if (isTransientProviderFailure(error)) {
        throw new RetryableAiProviderException(
          'MaxPlus generation temporarily failed',
        );
      }
      throw new BadGatewayException('MaxPlus generation failed');
    }
  }

  /**
   * `prompt_tokens` already includes the cached prefix. The dialect reports no
   * cache-write counter, so that bucket stays zero rather than being guessed.
   */
  private toUsage(payload: MaxPlusResponsePayload): AiTokenUsage {
    return normalizeTokenUsage({
      promptTokens: payload.usage?.prompt_tokens,
      cachedInputTokens: payload.usage?.prompt_tokens_details?.cached_tokens,
      outputTokens: payload.usage?.completion_tokens,
      cachedInPrompt: true,
    });
  }

  /** The system instruction is a leading `system` turn in this dialect. */
  private toMessages(request: AiProviderGenerateRequest) {
    const messages = request.messages.map((message) => ({
      role: message.role,
      content: this.toContent(message),
    }));

    return request.systemInstruction
      ? [{ role: 'system', content: request.systemInstruction }, ...messages]
      : messages;
  }

  private toContent(message: AiProviderGenerateRequest['messages'][number]) {
    if (!message.images?.length) return message.text;

    return [
      { type: 'text', text: message.text },
      ...message.images.map((image) => ({
        type: 'image_url',
        image_url: {
          url: `data:${image.mediaType};base64,${image.data}`,
          detail: 'auto',
        },
      })),
    ];
  }

  private extractText(payload: MaxPlusResponsePayload): string {
    return payload.choices?.[0]?.message?.content?.trim() ?? '';
  }
}
