import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { AdminRequest } from './admin-jwt-auth.guard';
import { AdminGuard } from '../../shared/guards/admin-guard.decorator';
import { AdminService } from './admin.service';

@AdminGuard()
@Controller('api/admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post('profile/image')
  @HttpCode(200)
  uploadProfileImage(@Req() request: AdminRequest) {
    return this.adminService.uploadProfileImage(request.admin!.id, request);
  }
}
