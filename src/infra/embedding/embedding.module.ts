import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EMBEDDING_ADAPTER } from './embedding-adapter.interface';
import { configuredEmbeddingProvider } from './embedding-model';
import { GeminiEmbeddingAdapter } from './gemini-embedding.adapter';
import { OpenRouterEmbeddingAdapter } from './openrouter-embedding.adapter';

/**
 * Binds the embedding backend named by `EMBEDDING_PROVIDER` (`GEMINI`, the
 * default, or `OPENROUTER`). It is chosen at boot, never at runtime:
 *
 * 1. Vectors are not comparable across models. `SemanticSearchService` filters
 *    on `embeddingModel`, so when the model changes every stored vector stops
 *    matching and retrieval degrades to keyword-only *silently*.
 * 2. The column is `vector(1536)` (see `EMBEDDING_DIMENSIONS`); a model that
 *    cannot return 1536 dimensions needs a migration.
 *
 * Switching provider for the SAME model is safe when the adapter reports the
 * same `model` (OpenRouter `google/gemini-embedding-2` = `gemini-embedding-2`,
 * measured identical; see `embedding-model.ts`). Any other change — a new
 * model on either provider — is a migration: reindex answer patterns, micro
 * knowledge and products, then re-measure the cosine thresholds with Thai
 * retrieval tests before going live.
 *
 * A new provider = one adapter class + one case below + its price rows.
 */
@Module({
  providers: [
    GeminiEmbeddingAdapter,
    OpenRouterEmbeddingAdapter,
    {
      provide: EMBEDDING_ADAPTER,
      inject: [
        ConfigService,
        GeminiEmbeddingAdapter,
        OpenRouterEmbeddingAdapter,
      ],
      useFactory: (
        config: ConfigService,
        gemini: GeminiEmbeddingAdapter,
        openRouter: OpenRouterEmbeddingAdapter,
      ) =>
        configuredEmbeddingProvider(config) === 'OPENROUTER'
          ? openRouter
          : gemini,
    },
  ],
  exports: [EMBEDDING_ADAPTER],
})
export class EmbeddingModule {}
