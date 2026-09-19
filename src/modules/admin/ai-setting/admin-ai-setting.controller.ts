import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import type { AdminRequest } from '../admin-jwt-auth.guard';
import { AdminAiSettingService } from './admin-ai-setting.service';
import {
  AdminAiSettingIdParamDto,
  CreateAdminAiSettingDto,
  UpdateAdminAiSettingDto,
} from './dto/admin-ai-setting.dto';

@AdminGuard()
@Controller('/api/admin/ai-settings')
export class AdminAiSettingController {
  constructor(private readonly aiSettingService: AdminAiSettingService) {}

  @Get()
  list(@Req() request: AdminRequest) {
    return this.aiSettingService.list(request.admin!);
  }

  @Post()
  create(@Req() request: AdminRequest, @Body() body: CreateAdminAiSettingDto) {
    return this.aiSettingService.create(body, request.admin!);
  }

  @Patch(':id')
  update(
    @Req() request: AdminRequest,
    @Param() params: AdminAiSettingIdParamDto,
    @Body() body: UpdateAdminAiSettingDto,
  ) {
    return this.aiSettingService.update(params.id, body, request.admin!);
  }

  @Delete(':id')
  remove(
    @Req() request: AdminRequest,
    @Param() params: AdminAiSettingIdParamDto,
  ) {
    return this.aiSettingService.remove(params.id, request.admin!);
  }
}
