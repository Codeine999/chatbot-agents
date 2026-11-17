import type {
  AiProviderName,
  AiTokenUsage,
} from '../../ai-provider/types/ai-provider.types';

export const EMBEDDING_ADAPTER = Symbol('EMBEDDING_ADAPTER');

/**
 * Pinned to the `AnswerPatternVector.embedding` column, declared as
 * `vector(1536)`. Changing it requires a Prisma migration and a full reindex,
 * so it is a constant rather than a setting.
 */
export const EMBEDDING_DIMENSIONS = 1536;

export type EmbeddingTask = 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT';

export type EmbeddingRequest = Readonly<{
  text: string;
  task: EmbeddingTask;
}>;

export type EmbeddingResult = Readonly<{
  values: readonly number[];
  model: string;
  /** Billable usage. Embeddings have no output, so only `inputTokens` is set. */
  usage: AiTokenUsage;
  /** True when `usage` was estimated locally because the provider reported none. */
  usageEstimated: boolean;
}>;

/**
 * One embedding backend (Gemini API or OpenRouter). The provider is chosen at
 * boot by `EMBEDDING_PROVIDER`, not at runtime — see `EmbeddingModule` for why.
 */
export interface EmbeddingAdapter {
 
  readonly provider: AiProviderName;
  readonly model: string;
  readonly apiKeyName: string;
  readonly requestTimeoutMs: number;
  isConfigured(): boolean;
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}
