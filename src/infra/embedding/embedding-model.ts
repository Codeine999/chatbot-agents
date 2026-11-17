import type { ConfigService } from '@nestjs/config';
import type { EmbeddingRequest } from './embedding-adapter.interface';

export const EMBEDDING_PROVIDER = ['GEMINI', 'OPENROUTER'] as const;
export type EmbeddingProviderName = (typeof EMBEDDING_PROVIDER)[number];

export const DEFAULT_GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2';
export const DEFAULT_OPENROUTER_EMBEDDING_MODEL = 'google/gemini-embedding-2';
export const DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS = 8_000;

const SAME_VECTORS_AS: Readonly<Record<string, string>> = {
  'google/gemini-embedding-2': 'gemini-embedding-2',
};

/** Which adapter EmbeddingModule binds. Unknown values fail at boot. */
export function configuredEmbeddingProvider(
  config: ConfigService,
): EmbeddingProviderName {
  const raw = (config.get<string>('EMBEDDING_PROVIDER') ?? 'GEMINI')
    .trim()
    .toUpperCase();
  if (!(EMBEDDING_PROVIDER as readonly string[]).includes(raw)) {
    throw new Error(
      `EMBEDDING_PROVIDER must be one of ${EMBEDDING_PROVIDER.join(', ')}, got "${raw}"`,
    );
  }
  return raw as EmbeddingProviderName;
}

/** The model id sent to OpenRouter. */
export function openRouterEmbeddingApiModel(config: ConfigService): string {
  return (
    config.get<string>('OPENROUTER_EMBEDDING_MODEL')?.trim() ||
    DEFAULT_OPENROUTER_EMBEDDING_MODEL
  );
}

/**
 * The name every vector is written and searched under, for the configured
 * provider. Also the billing model (`AiModelPricing.model`). Code that tags
 * vectors outside the adapter (the product index outbox) must use this, never
 * a provider-specific env var.
 */
export function configuredEmbeddingModel(config: ConfigService): string {
  if (configuredEmbeddingProvider(config) === 'OPENROUTER') {
    const apiModel = openRouterEmbeddingApiModel(config);
    return SAME_VECTORS_AS[apiModel] ?? apiModel;
  }
  return (
    config.get<string>('GEMINI_EMBEDDING_MODEL')?.trim() ||
    DEFAULT_GEMINI_EMBEDDING_MODEL
  );
}

export function embeddingRequestTimeoutMs(
  config: ConfigService,
  key: string,
): number {
  const value = Number(config.get<string>(key));
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS;
}

/**
 * Gemini Embedding 2 has no taskType; the retrieval task goes into the text.
 * Shared by every adapter that serves this model so the vectors stay equal.
 */
export function usesGeminiTaskPrefix(model: string): boolean {
  return /(^|\/)(?:gemini-)?embedding-2(?:$|-)/i.test(model.trim());
}

export function geminiTaskPrefixed(request: EmbeddingRequest): string {
  return request.task === 'RETRIEVAL_QUERY'
    ? `task: search result | query: ${request.text}`
    : `title: none | text: ${request.text}`;
}
