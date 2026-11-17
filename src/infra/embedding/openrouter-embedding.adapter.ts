import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingAdapter,
  EmbeddingRequest,
  EmbeddingResult,
} from './embedding-adapter.interface';
import { EMPTY_AI_TOKEN_USAGE } from '../../ai-provider/types/ai-provider.types';
import {
  estimateEmbeddingTokenUsage,
  toTokenCount,
} from '../../ai-provider/utils/token-usage.utils';
import {
  configuredEmbeddingModel,
  embeddingRequestTimeoutMs,
  geminiTaskPrefixed,
  openRouterEmbeddingApiModel,
  usesGeminiTaskPrefix,
} from './embedding-model';

/**
 * Embeddings through OpenRouter's OpenAI-compatible `/embeddings` endpoint.
 *
 * `model` is the name vectors are stored and billed under, which can differ
 * from the id sent to OpenRouter: `google/gemini-embedding-2` yields the same
 * vectors as the Gemini API's `gemini-embedding-2`, so it keeps that name and
 * the existing index (see `configuredEmbeddingModel`).
 */
@Injectable()
export class OpenRouterEmbeddingAdapter implements EmbeddingAdapter {
  constructor(private readonly configService: ConfigService) {}

  readonly provider = 'OPENROUTER' as const;
  readonly apiKeyName = 'OPEN_ROUTER_KEY';

  get model(): string {
    return configuredEmbeddingModel(this.configService);
  }

  get requestTimeoutMs(): number {
    return embeddingRequestTimeoutMs(
      this.configService,
      'OPENROUTER_EMBEDDING_REQUEST_TIMEOUT_MS',
    );
  }

  isConfigured(): boolean {
    return Boolean(this.configService.get<string>('OPEN_ROUTER_KEY')?.trim());
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const apiKey = this.configService.get<string>('OPEN_ROUTER_KEY')?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'OpenRouter API key is not configured',
      );
    }

    const apiModel = openRouterEmbeddingApiModel(this.configService);
    const baseURL = (
      this.configService.get<string>('OPEN_ROUTER_BASE_URL') ??
      'https://openrouter.ai/api/v1'
    ).replace(/\/$/, '');

    try {
      const response = await new OpenAI({
        apiKey,
        baseURL,
        timeout: this.requestTimeoutMs,
        // Billing owns retries; a hidden retry would be an unbilled call.
        maxRetries: 0,
      }).embeddings.create({
        model: apiModel,
        input: usesGeminiTaskPrefix(apiModel)
          ? geminiTaskPrefixed(request)
          : request.text,
        dimensions: EMBEDDING_DIMENSIONS,
        encoding_format: 'float',
      });

      const values = response.data?.[0]?.embedding;
      if (
        !Array.isArray(values) ||
        values.length !== EMBEDDING_DIMENSIONS ||
        values.some((value) => !Number.isFinite(value))
      ) {
        throw new Error(
          `Invalid embedding dimension=${Array.isArray(values) ? values.length : 0}, expected=${EMBEDDING_DIMENSIONS}`,
        );
      }

      const reportedTokens = toTokenCount(response.usage?.prompt_tokens);
      return {
        values,
        model: this.model,
        usage:
          reportedTokens > 0
            ? { ...EMPTY_AI_TOKEN_USAGE, inputTokens: reportedTokens }
            : estimateEmbeddingTokenUsage(request.text),
        usageEstimated: reportedTokens === 0,
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new BadGatewayException(
        `OpenRouter embedding failed: ${String(error)}`,
      );
    }
  }
}
