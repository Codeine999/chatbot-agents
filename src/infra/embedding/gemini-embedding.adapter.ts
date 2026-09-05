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

const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';

@Injectable()
export class GeminiEmbeddingAdapter implements EmbeddingAdapter {
  constructor(private readonly configService: ConfigService) {}

  readonly provider = 'GEMINI' as const;

  get model(): string {
    return (
      this.configService.get<string>('GEMINI_EMBEDDING_MODEL') ||
      DEFAULT_EMBEDDING_MODEL
    );
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY')?.trim();

    if (!apiKey) {
      throw new ServiceUnavailableException('GEMINI API key is not configured');
    }

    const model = this.model;
    const usesPromptTaskInstruction = this.usesPromptTaskInstruction(model);

    try {
      const response = await new GoogleGenAI({ apiKey }).models.embedContent({
        model,
        contents: usesPromptTaskInstruction
          ? this.toEmbedding2Content(request)
          : request.text,
        config: {
          ...(usesPromptTaskInstruction
            ? {}
            : {
                taskType: request.task,
              }),
          outputDimensionality: EMBEDDING_DIMENSIONS,
          httpOptions: {
            timeout: Number(
              this.configService.get<string>(
                'GEMINI_EMBEDDING_REQUEST_TIMEOUT_MS',
              ) ?? 8_000,
            ),
          },
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

  /**
   * Gemini Embedding 2 does not support taskType. Retrieval intent must be
   * included in the text instead. Embedding 1 keeps using taskType.
   */
  private usesPromptTaskInstruction(model: string): boolean {
    return /(^|\/)(?:gemini-)?embedding-2(?:$|-)/i.test(model.trim());
  }

  private toEmbedding2Content(request: EmbeddingRequest): string {
    if (request.task === 'RETRIEVAL_QUERY') {
      return `task: search result | query: ${request.text}`;
    }

    return `title: none | text: ${request.text}`;
  }
}
