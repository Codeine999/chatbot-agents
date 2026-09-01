import { Controller, Get, Req } from '@nestjs/common';
import type { AdminRequest } from '../admin-jwt-auth.guard';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { AdminUsageService } from './admin-usage.service';

@AdminGuard()
@Controller('api/admin/usage')
export class AdminUsageController {
  constructor(private readonly adminUsageService: AdminUsageService) {}

  @Get()
  getUsage(@Req() request: AdminRequest) {
    return this.adminUsageService.getUsage(request.admin!.id);
  }

  @Get('line/push-message')
  getLinePushMessageQuota() {
    return this.adminUsageService.getLinePushMessageQuota();
  }

  @Get('account')
  getUsageAllAdmin(@Req() request: AdminRequest) {
    return this.adminUsageService.getUsageAllAdmin(request.admin!);
  }

  
}
