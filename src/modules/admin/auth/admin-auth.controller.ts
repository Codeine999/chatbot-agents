import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Public } from '../../../shared/guards/public.decorator';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { CreateAdminDto } from './dto/create-admin.dto';

@Controller('api/admin/auth')
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: AdminLoginDto) {
    return this.adminAuthService.login(body);
  }

  @Public()
  @Post('owner')
  createOwner(@Body() body: CreateAdminDto) {
    return this.adminAuthService.createOwner(body);
  }

  // @AdminGuard('dev', 'owner')
  @Post('add')
  create(@Body() body: CreateAdminDto) {
    return this.adminAuthService.create(body);
  }

  @Public()
  @Post('audit-owner')
  async audit(): Promise<{ data: boolean; message: string }> {
    const audit = await this.adminAuthService.authOwner();

    return {
      data: audit,
      message: audit ? 'คุณได้สมัครสมาชิกไปแล้ว' : 'ยังไม่มีการสมัครสมาชิก',
    };
  }
}
