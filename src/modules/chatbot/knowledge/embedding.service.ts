import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { AiBudgetService } from '../../../infra/rate-limit/ai-budget.service';

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly genAI: GoogleGenAI;

  constructor(private readonly aiBudgetService: AiBudgetService) {
    this.genAI = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });
  }

  async embed(text: string): Promise<number[]> {
    const input = text.trim();

    if (!input) {
      throw new Error('Cannot embed empty text');
    }

    // Global AI budget gate; callers already treat embed errors as a
    // fallback-answer path, so throwing here safely skips the AI call.
    if (!(await this.aiBudgetService.tryConsume())) {
      throw new Error('AI budget exceeded, skipping embedding call');
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