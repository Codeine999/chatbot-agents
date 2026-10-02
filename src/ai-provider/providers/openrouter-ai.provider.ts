import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { z } from 'zod';
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import {
  DEFAULT_AI_MAX_OUTPUT_TOKENS,
  DEFAULT_AI_REQUEST_TIMEOUT_MS,
} from '../utils/ai-provider.constants';
import {
  AI_REASONING_EFFORTS,
  type AiGenerateResponse,
  type AiProviderGenerateRequest,
  type AiReasoningEffort,
  type AiTokenUsage,
} from '../types/ai-provider.types';
import { normalizeTokenUsage } from '../utils/token-usage.utils';
import type { AiProviderAdapter } from './ai-provider.interface';
import {
  isTransientProviderFailure,
  RetryableAiProviderException,
} from '../errors/ai-provider-error';

type OpenRouterResponsePayload = {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
    completion_tokens?: number;
  };
};

@Injectable()
export class OpenRouterProvider implements AiProviderAdapter {
  readonly name = 'OPENROUTER' as const;
  private readonly logger = new Logger(OpenRouterProvider.name);
  private readonly defaultReasoningEffort: AiReasoningEffort | undefined;

  constructor(private readonly configService: ConfigService) {
    // Applies only when the caller sets no effort. Unset keeps the model's
    // default reasoning.
    this.defaultReasoningEffort = z
      .enum(AI_REASONING_EFFORTS)
      .optional()
      .parse(
        configService.get<string>('OPEN_ROUTER_REASONING_EFFORT')?.trim() ||
          undefined,
      );
  }

  isConfigured(): boolean {
    return Boolean(this.configService.get<string>('OPEN_ROUTER_KEY')?.trim());
  }

  async generate(
    request: AiProviderGenerateRequest,
  ): Promise<AiGenerateResponse> {
    const apiKey = this.configService.get<string>('OPEN_ROUTER_KEY')?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'OpenRouter API key is not configured',
      );
    }

    const baseUrl = (
      this.configService.get<string>('OPEN_ROUTER_BASE_URL') ??
      'https://openrouter.ai/api/v1'
    ).replace(/\/$/, '');

    try {
      const client = new OpenAI({
        apiKey,
        baseURL: baseUrl,
        timeout: Number(
          this.configService.get<string>('OPEN_ROUTER_REQUEST_TIMEOUT_MS') ??
            DEFAULT_AI_REQUEST_TIMEOUT_MS,
        ),
        maxRetries: 0,
      });

      const messages: ChatCompletionMessageParam[] = [
        ...(request.systemInstruction
          ? [{ role: 'system' as const, content: request.systemInstruction }]
          : []),
        ...request.messages.map(
          (message) =>
            ({
              role: message.role,
              content: this.toContent(message),
            }) as ChatCompletionMessageParam,
        ),
      ];

      const body = {
        model: request.model,
        messages,
        ...this.temperatureParam(request.model, request.temperature),
        max_tokens: request.maxOutputTokens ?? DEFAULT_AI_MAX_OUTPUT_TOKENS,
        stream: false as const,
        ...this.reasoningParam(request.reasoningEffort),
        ...(request.responseJsonSchema
          ? {
              response_format: {
                type: 'json_schema' as const,
                json_schema: {
                  name: 'grounded_answer',
                  strict: true,
                  schema: request.responseJsonSchema,
                },
              },
              provider: { require_parameters: true },
            }
          : {}),
      };

      const payload: OpenRouterResponsePayload =
        await client.chat.completions.create(body);

      return {
        text: this.extractText(payload),
        provider: this.name,
        model: payload.model ?? request.model,
        usage: this.toUsage(payload),
        providerRequestId: payload.id,
      };

    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      const apiError = error instanceof OpenAI.APIError ? error : undefined;
      const status: unknown = apiError?.status;
      const safeLabel = (value: unknown): string | undefined =>
        typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value)
          ? value
          : undefined;
      const reason =
        error instanceof Error
          ? /no endpoints/i.test(error.message)
            ? 'NO_MATCHING_ENDPOINTS'
            : /(?:invalid|unknown|not found|not available).*model|model.*(?:invalid|not found|not available)/i.test(
                  error.message,
                )
              ? 'MODEL_UNAVAILABLE'
              : /credits|insufficient.*balance/i.test(error.message)
                ? 'INSUFFICIENT_PROVIDER_CREDITS'
                : /json_schema|response_format|structured output/i.test(
                      error.message,
                    )
                  ? 'STRUCTURED_OUTPUT_ERROR'
                  : 'UNCLASSIFIED'
          : 'UNCLASSIFIED';
      this.logger.error(
        `OpenRouter generation failed ${JSON.stringify({
          model: safeLabel(request.model),
          status: typeof status === 'number' ? status : undefined,
          code: safeLabel(apiError?.code),
          type: safeLabel(apiError?.type),
          param: safeLabel(apiError?.param),
          requestId: safeLabel(apiError?.requestID),
          errorName: safeLabel(error instanceof Error ? error.name : undefined),
          reason,
          structuredOutput: Boolean(request.responseJsonSchema),
          retryable:
            error instanceof OpenAI.APIConnectionError ||
            isTransientProviderFailure(error),
        })}`,
      );
      if (
        error instanceof OpenAI.APIConnectionError ||
        isTransientProviderFailure(error)
      ) {
        throw new RetryableAiProviderException(
          'OpenRouter generation temporarily failed',
        );
      }
      throw new BadGatewayException('OpenRouter generation failed');
    }
  }

  private temperatureParam(
    model: string,
    temperature: number | undefined,
  ): { temperature?: number } {
    if (temperature === undefined) return {};
    if (/^openai\/gpt-[56](?:[.-]|$)/i.test(model)) return {};
    return { temperature };
  }

  private reasoningParam(effort: AiReasoningEffort | undefined): {
    reasoning?: { effort: AiReasoningEffort };
  } {
    const resolved = effort ?? this.defaultReasoningEffort;
    return resolved ? { reasoning: { effort: resolved } } : {};
  }

  private toContent(
    message: AiProviderGenerateRequest['messages'][number],
  ): string | ChatCompletionContentPart[] {
    if (!message.images?.length) return message.text;

    return [
      { type: 'text', text: message.text },
      ...message.images.map((image) => ({
        type: 'image_url' as const,
        image_url: { url: `data:${image.mediaType};base64,${image.data}` },
      })),
    ];
  }

  private extractText(payload: OpenRouterResponsePayload): string {
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    return content
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text!.trim())
      .filter(Boolean)
      .join('\n');
  }

  /** Prompt includes cached reads and writes; completion includes reasoning. */
  private toUsage(payload: OpenRouterResponsePayload): AiTokenUsage {
    return normalizeTokenUsage({
      promptTokens: payload.usage?.prompt_tokens,
      cachedInputTokens: payload.usage?.prompt_tokens_details?.cached_tokens,
      cacheWriteTokens:
        payload.usage?.prompt_tokens_details?.cache_write_tokens,
      outputTokens: payload.usage?.completion_tokens,
      cachedInPrompt: true,
      cacheWriteInPrompt: true,
    });
  }
}
