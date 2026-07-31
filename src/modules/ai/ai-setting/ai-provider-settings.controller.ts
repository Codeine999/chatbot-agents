import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { AdminRequest } from '../../admin/admin-jwt-auth.guard';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { AdminAiProviderService } from '../admin-ai-provider.service';
import { AdminAiProviderSettingsService } from './admin-ai-provider-settings.service';
import { AiModelCatalogService } from './ai-model-catalog.service';
import { AiProviderSettingsService } from '../ai-provider-settings.service';
import {
  AdminMemberIdParamDto,
  AdminAiGenerateDto,
  AiProviderScopeParamDto,
  UpdateAdminAiAccessDto,
  UpdateMyAdminAiProviderSettingDto,
  UpdateAiProviderSettingDto,
} from '../dto/ai-provider-setting.dto';
import { AiProviderResponseCode } from '../../../utils/responseCode/ai-provider.constant';

@Controller('api/admin/ai-providers')
export class AiProviderSettingsController {
  constructor(
    private readonly catalogService: AiModelCatalogService,
    private readonly settingsService: AiProviderSettingsService,
    private readonly adminSettingsService: AdminAiProviderSettingsService,
    private readonly adminAiProviderService: AdminAiProviderService,
  ) {}

  @AdminGuard()
  @Get('catalog')
  getCatalog() {
    return this.catalogService.getCatalog();
  }

  @AdminGuard()
  @Get('catalog/me')
  async getMyCatalog(@Req() request: AdminRequest) {
    const setting = await this.adminSettingsService.get(this.adminId(request));
    return this.catalogService
      .getCatalog()
      .filter((item) => setting.allowedProviders.includes(item.provider));
  }

  @AdminGuard()
  @Get('settings/me')
  getMySetting(@Req() request: AdminRequest) {
    return this.adminSettingsService.get(this.adminId(request));
  }

  @AdminGuard()
  @Patch('settings/me')
  updateMySetting(
    @Req() request: AdminRequest,
    @Body() body: UpdateMyAdminAiProviderSettingDto,
  ) {
    return this.adminSettingsService.updateDefault(
      this.adminId(request),
      body.provider,
      body.model,
    );
  }

  @AdminGuard()
  @Post('generate')
  generate(@Req() request: AdminRequest, @Body() body: AdminAiGenerateDto) {
    return this.adminAiProviderService.generate(this.adminId(request), body);
  }

  @AdminGuard('dev', 'owner')
  @Patch('admin-members/:adminMemberId/ai-access')
  updateAdminAccess(
    @Req() request: AdminRequest,
    @Param() params: AdminMemberIdParamDto,
    @Body() body: UpdateAdminAiAccessDto,
  ) {
    return this.adminSettingsService.updateAccess(
      request.admin!,
      params.adminMemberId,
      body,
    );
  }

  @AdminGuard()
  @Get('settings')
  getSettings() {
    return this.settingsService.getAll();
  }

  @AdminGuard('dev', 'owner')
  @Patch('settings/:scope')
  async updateSetting(
    @Param() params: AiProviderScopeParamDto,
    @Body() body: UpdateAiProviderSettingDto,
  ) {
    const setting = await this.settingsService.update(
      params.scope,
      body.provider,
      body.model,
    );

    return {
      success: true,
      code: AiProviderResponseCode.SETTING_UPDATED,
      data: setting,
    };
  }

  private adminId(request: AdminRequest): string {
    if (!request.admin) {
      throw new Error('AdminGuard must run before accessing admin settings');
    }

    return request.admin.id;
  }
}
