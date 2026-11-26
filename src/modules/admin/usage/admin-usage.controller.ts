import { Controller, Get, Query, Req } from '@nestjs/common';
import type { AdminRequest } from '../admin-jwt-auth.guard';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { AdminUsageService } from './admin-usage.service';
import { UsageRepliesQueryDto } from './dto/usage-replies-query.dto';

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

  /** Credits charged per customer reply, newest first (`page`/`limit`). */
  @Get('replies')
  getReplyLog(
    @Req() request: AdminRequest,
    @Query() query: UsageRepliesQueryDto,
  ) {
    return this.adminUsageService.getReplyLog(request.admin!, query);
  }
}
