import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly genAI: GoogleGenAI;

  constructor() {
    this.genAI = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });
  }

  async embed(text: string): Promise<number[]> {
    const input = text.trim();

    if (!input) {
      throw new Error('Cannot embed empty text');
    }

    const response = await this.genAI.models.embedContent({
      model: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001',
      contents: input,
    });

    const values = response.embeddings?.[0]?.values;

    if (!values?.length) {
      throw new Error('Gemini embedding response is empty');
    }
    
    this.logger.debug(`Embedding generated. dimension=${values.length}`);
    
    return values;
  }
}