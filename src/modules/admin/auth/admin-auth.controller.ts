import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { AdminGuard } from '../../../infra/auth/admin-guard.decorator';
import { Public } from '../../../infra/auth/public.decorator';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { CreateAdminDto } from './dto/create-admin.dto';

@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: AdminLoginDto) {
    return this.adminAuthService.login(body);
  }

  @AdminGuard('dev', 'owner')
  @Post('admins')
  create(@Body() body: CreateAdminDto) {
    return this.adminAuthService.create(body);
  }
}
