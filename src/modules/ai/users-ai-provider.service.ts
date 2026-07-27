import { Injectable } from '@nestjs/common';
import { AiProviderService } from './ai-provider.service';
import {
  AiGenerateRequest,
  AiGenerateResponse,
} from '../../ai-provider/types/ai-provider.types';

/** Injectable entry point for user-facing AI modules. */
@Injectable()
export class UsersAiProviderService {
  constructor(private readonly aiProviderService: AiProviderService) {}

  generate(request: AiGenerateRequest): Promise<AiGenerateResponse> {
    return this.aiProviderService.generate('USER', request);
  }
}
