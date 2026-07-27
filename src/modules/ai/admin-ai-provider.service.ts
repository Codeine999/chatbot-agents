import { ForbiddenException, Injectable } from '@nestjs/common';
import { AdminAiProviderSettingsService } from './admin-ai-provider-settings.service';
import { AiModelCatalogService } from './ai-model-catalog.service';
import { AiProviderService } from './ai-provider.service';
import {
  AdminAiGenerateRequest,
  AiGenerateResponse,
} from '../../ai-provider/types/ai-provider.types';

/**
 * Injectable entry point for back-office AI modules.
 * HTTP/WebSocket callers must authenticate with AdminGuard before invoking it.
 */
@Injectable()
export class AdminAiProviderService {
  constructor(
    private readonly aiProviderService: AiProviderService,
    private readonly settingsService: AdminAiProviderSettingsService,
    private readonly catalogService: AiModelCatalogService,
  ) {}

  async generate(
    adminMemberId: string,
    request: AdminAiGenerateRequest,
  ): Promise<AiGenerateResponse> {
    const setting = await this.settingsService.get(adminMemberId);

    if (!setting.enabled) {
      throw new ForbiddenException('AI is disabled for this admin account');
    }

    const {
      provider: requestedProvider,
      model: requestedModel,
      ...input
    } = request;
    const provider = requestedProvider ?? setting.provider;

    if (!setting.allowedProviders.includes(provider)) {
      throw new ForbiddenException(
        `${provider} is not allowed for this admin account`,
      );
    }

    const model =
      requestedModel?.trim() ||
      (provider === setting.provider
        ? setting.model
        : this.catalogService.getDefaultModel(provider));

    this.catalogService.assertSelectable(provider, model);
    return this.aiProviderService.generateWith(provider, model, input);
  }
}
