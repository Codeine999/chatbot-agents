import {
  AiGenerateResponse,
  AiProviderGenerateRequest,
  AiProviderName,
} from '../types/ai-provider.types';

export interface AiProviderAdapter {
  readonly name: AiProviderName;

  isConfigured(): boolean;

  generate(request: AiProviderGenerateRequest): Promise<AiGenerateResponse>;
}
