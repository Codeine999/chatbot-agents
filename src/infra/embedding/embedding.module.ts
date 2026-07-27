import { Module } from '@nestjs/common';
import { EMBEDDING_ADAPTER } from './embedding-adapter.interface';
import { GeminiEmbeddingAdapter } from './gemini-embedding.adapter';

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
