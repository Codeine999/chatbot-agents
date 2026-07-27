export const EMBEDDING_ADAPTER = Symbol('EMBEDDING_ADAPTER');

export const EMBEDDING_DIMENSIONS = 1536;

export type EmbeddingTask = 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT';

export type EmbeddingRequest = Readonly<{
  text: string;
  task: EmbeddingTask;
}>;

export type EmbeddingResult = Readonly<{
  values: readonly number[];
  model: string;
}>;

export interface EmbeddingAdapter {
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}
