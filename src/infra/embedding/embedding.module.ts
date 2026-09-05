import { Module } from '@nestjs/common';
import { EMBEDDING_ADAPTER } from './embedding-adapter.interface';
import { GeminiEmbeddingAdapter } from './gemini-embedding.adapter';

/**
 * Embeddings are Gemini-only, and the provider is deliberately NOT switchable.
 *
 * Unlike chat — where `AiProviderSetting` lets an owner move between GEMINI,
 * OPENAI and ANTHROPIC at runtime — this binding is fixed at compile time.
 * Swapping it is not a config change, because:
 *
 * 1. Vectors are not comparable across models. `SemanticSearchService` filters
 *    on `AnswerPatternVector.embeddingModel`, so the moment the model changes,
 *    every stored vector stops matching and the pgvector query returns nothing.
 *    Retrieval then degrades to keyword-only *silently*, because
 *    `KnowledgeRetrievalService` catches the miss as a normal empty result.
 * 2. The column is `vector(1536)` (see `EMBEDDING_DIMENSIONS`), which a
 *    different provider's output size would not fit without a migration.
 * 3. Anthropic publishes no embedding API at all, so parity with the three
 *    chat providers is not reachable anyway.
 *
 * Changing `GEMINI_EMBEDDING_MODEL` carries the same cost as (1): the whole
 * knowledge base must be reindexed (`POST` reindex on the admin answer-pattern
 * route) before vector search works again. Treat it as a migration, not a
 * setting.
 */
@Module({
  providers: [
    GeminiEmbeddingAdapter,
    {
      provide: EMBEDDING_ADAPTER,
      useExisting: GeminiEmbeddingAdapter,
    },
  ],
  exports: [EMBEDDING_ADAPTER],
})
export class EmbeddingModule {}
