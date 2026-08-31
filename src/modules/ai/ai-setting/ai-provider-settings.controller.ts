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
  getMyCatalog() {
    return this.catalogService.getCatalog();
  }

  @AdminGuard()
  @Get('settings/me')
  getMySetting(@Req() request: AdminRequest) {
    return this.adminSettingsService.get(this.adminId(request));
  }

  // All admins share one provider/model (scope=ADMIN), so only dev/owner may
  // change it here even though the route reads like a personal setting.
  @AdminGuard('dev', 'owner')
  @Patch('settings/me')
  updateMySetting(@Body() body: UpdateMyAdminAiProviderSettingDto) {
    return this.settingsService.update('ADMIN', body.provider, body.model);
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
    return this.adminSettingsService.updateEnabled(
      request.admin!,
      params.adminMemberId,
      body.enabled,
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
