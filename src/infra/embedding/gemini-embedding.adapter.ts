import { GoogleGenAI } from '@google/genai';
import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  embeddingRequestTimeoutMs,
  geminiTaskPrefixed,
  usesGeminiTaskPrefix,
} from './embedding-model';

@Injectable()
export class GeminiEmbeddingAdapter implements EmbeddingAdapter {
  constructor(private readonly configService: ConfigService) {}

  readonly provider = 'GEMINI' as const;
  readonly apiKeyName = 'GEMINI_API_KEY';

  get model(): string {
    return (
      this.configService.get<string>('GEMINI_EMBEDDING_MODEL') ||
      DEFAULT_GEMINI_EMBEDDING_MODEL
    );
  }

  get requestTimeoutMs(): number {
    return embeddingRequestTimeoutMs(
      this.configService,
      'GEMINI_EMBEDDING_REQUEST_TIMEOUT_MS',
    );
  }

  isConfigured(): boolean {
    return Boolean(this.configService.get<string>('GEMINI_API_KEY')?.trim());
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY')?.trim();

    if (!apiKey) {
      throw new ServiceUnavailableException('GEMINI API key is not configured');
    }

    const model = this.model;
    const usesPromptTaskInstruction = usesGeminiTaskPrefix(model);

    try {
      const response = await new GoogleGenAI({ apiKey }).models.embedContent({
        model,
        contents: usesPromptTaskInstruction
          ? geminiTaskPrefixed(request)
          : request.text,
        config: {
          ...(usesPromptTaskInstruction
            ? {}
            : {
                taskType: request.task,
              }),
          outputDimensionality: EMBEDDING_DIMENSIONS,
          httpOptions: { timeout: this.requestTimeoutMs },
        },
      });

      const embedding = response.embeddings?.[0];
      const values = embedding?.values;

      if (
        !values ||
        values.length !== EMBEDDING_DIMENSIONS ||
        values.some((value) => !Number.isFinite(value))
      ) {
        throw new Error(
          `Invalid embedding dimension=${values?.length ?? 0}, expected=${EMBEDDING_DIMENSIONS}`,
        );
      }

      // `statistics` is only populated on Vertex; the Developer API used here
      // reports nothing, so billing falls back to the local estimate.
      const reportedTokens = toTokenCount(embedding?.statistics?.tokenCount);

      return {
        values,
        model,
        usage:
          reportedTokens > 0
            ? { ...EMPTY_AI_TOKEN_USAGE, inputTokens: reportedTokens }
            : estimateEmbeddingTokenUsage(request.text),
        usageEstimated: reportedTokens === 0,
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new BadGatewayException(
        `Gemini embedding failed: ${String(error)}`,
      );
    }
  }
}
