import { Injectable } from '@nestjs/common';

@Injectable()
export class EmbeddingService {
  // TODO: implement text-to-vector embedding (e.g. pgvector)
  embedText(_text: string): null {
    return null;
  }
}
