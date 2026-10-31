import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { DEFAULT_AI_MAX_OUTPUT_TOKENS } from '../utils/ai-provider.constants';
import type {
  AiGenerateResponse,
  AiProviderGenerateRequest,
  AiTokenUsage,
} from '../types/ai-provider.types';
import { normalizeTokenUsage } from '../utils/token-usage.utils';
import type { AiProviderAdapter } from './ai-provider.interface';
import {
  isTransientProviderFailure,
  RetryableAiProviderException,
} from '../errors/ai-provider-error';

/**
 * Self-hosted models answer slower than hosted APIs, so the default timeout is
 * longer than DEFAULT_AI_REQUEST_TIMEOUT_MS. It still sits inside the LINE
 * reply-token window.
 */
export const DEFAULT_LOCAL_LLM_REQUEST_TIMEOUT_MS = 30_000;

/** Ollama and llama.cpp ignore the key; the SDK refuses an empty one. */
const NO_API_KEY_PLACEHOLDER = 'local-llm-no-key';

type LocalLlmResponsePayload = {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
    completion_tokens?: number;
  } | null;
};

/**
 * Generation adapter for a self-hosted model behind any OpenAI-compatible
 * `/v1/chat/completions` endpoint: Ollama, vLLM, llama.cpp server, LM Studio,
 * LocalAI, or a gateway in front of them.
 *
 * The endpoint is configured once, in env, by the operator. Customers never
 * supply a URL, so there is no per-request SSRF surface here.
 */
@Injectable()
export class LocalLlmProvider implements AiProviderAdapter {
  readonly name = 'LOCAL' as const;
  private readonly logger = new Logger(LocalLlmProvider.name);

  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.baseUrl());
  }

  async generate(
    request: AiProviderGenerateRequest,
  ): Promise<AiGenerateResponse> {
    const baseUrl = this.baseUrl();
    if (!baseUrl) {
      throw new ServiceUnavailableException('Local LLM is not configured');
    }

    try {
      const client = new OpenAI({
        apiKey:
          this.configService.get<string>('LOCAL_LLM_API_KEY')?.trim() ||
          NO_API_KEY_PLACEHOLDER,
        baseURL: baseUrl,
        timeout: this.positiveNumber(
          this.configService.get<string>('LOCAL_LLM_REQUEST_TIMEOUT_MS'),
          DEFAULT_LOCAL_LLM_REQUEST_TIMEOUT_MS,
        ),
        // AiProviderService owns retries, inside the billed call.
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

      const payload: LocalLlmResponsePayload =
        await client.chat.completions.create({
          model: request.model,
          messages,
          ...(request.temperature !== undefined
            ? { temperature: request.temperature }
            : {}),
          max_tokens: request.maxOutputTokens ?? DEFAULT_AI_MAX_OUTPUT_TOKENS,
          stream: false,
          // reasoningEffort is ignored: local servers disagree on the field.
          ...(request.responseJsonSchema && this.structuredOutputEnabled()
            ? {
                response_format: {
                  type: 'json_schema' as const,
                  json_schema: {
                    name: 'grounded_answer',
                    strict: true,
                    schema: request.responseJsonSchema,
                  },
                },
              }
            : {}),
        });

      return {
        text: this.extractText(payload),
        provider: this.name,
        // Bill the configured id: local servers may echo a different alias.
        model: request.model,
        usage: this.toUsage(payload),
        providerRequestId: payload.id,
      };
    } catch (error) {
      const retryable =
        error instanceof OpenAI.APIConnectionError ||
        isTransientProviderFailure(error);
      const status =
        error instanceof OpenAI.APIError && typeof error.status === 'number'
          ? error.status
          : undefined;
      // Never log the endpoint URL, key, or raw body: they can name hosts.
      this.logger.error(
        `Local LLM generation failed ${JSON.stringify({
          status,
          errorName: error instanceof Error ? error.name : undefined,
          structuredOutput: Boolean(request.responseJsonSchema),
          retryable,
        })}`,
      );
      if (retryable) {
        throw new RetryableAiProviderException(
          'Local LLM generation temporarily failed',
        );
      }
      throw new BadGatewayException('Local LLM generation failed');
    }
  }

  private baseUrl(): string | undefined {
    return (
      this.configService
        .get<string>('LOCAL_LLM_BASE_URL')
        ?.trim()
        .replace(/\/+$/, '') || undefined
    );
  }

  /** On by default; turn off for servers that reject `response_format`. */
  private structuredOutputEnabled(): boolean {
    const value = this.configService
      .get<string>('LOCAL_LLM_STRUCTURED_OUTPUT')
      ?.trim()
      .toLowerCase();
    return value !== 'false' && value !== '0';
  }

  private positiveNumber(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

  private extractText(payload: LocalLlmResponsePayload): string {
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    return content
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text!.trim())
      .filter(Boolean)
      .join('\n');
  }

  /** OpenAI-compatible servers report cached reads inside prompt_tokens. */
  private toUsage(payload: LocalLlmResponsePayload): AiTokenUsage {
    return normalizeTokenUsage({
      promptTokens: payload.usage?.prompt_tokens,
      cachedInputTokens: payload.usage?.prompt_tokens_details?.cached_tokens,
      outputTokens: payload.usage?.completion_tokens,
      cachedInPrompt: true,
    });
  }
}
