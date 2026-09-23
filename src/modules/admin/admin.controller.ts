import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { AdminRequest } from './admin-jwt-auth.guard';
import { AdminGuard } from '../../shared/guards/admin-guard.decorator';
import { AdminService } from './admin.service';
import { AdminAuthService } from './auth/admin-auth.service';
import { CreateAdminDto } from './auth/dto/create-admin.dto';
import { AdminIdParamDto, UpdateAdminDto } from './dto/update-admin.dto';

@AdminGuard()
@Controller('api/admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly adminAuthService: AdminAuthService,
  ) {}

  /** Owner/dev view: every admin account in the caller's company. */
  @AdminGuard('dev', 'owner')
  @Get('all')
  getAllAdmin(@Req() request: AdminRequest) {
    return this.adminService.getAllAdmin(request.admin!.companyId);
  }

  /** New accounts join the caller's company, so they appear in `GET all`. */
  @AdminGuard('dev', 'owner')
  @Post()
  createAdmin(@Req() request: AdminRequest, @Body() body: CreateAdminDto) {
    return this.adminAuthService.create(body, request.admin!.companyId);
  }

  @AdminGuard('dev', 'owner')
  @Patch(':id')
  updateAdmin(
    @Req() request: AdminRequest,
    @Param() params: AdminIdParamDto,
    @Body() body: UpdateAdminDto,
  ) {
    return this.adminService.updateAdmin(request.admin!, params.id, body);
  }

  @AdminGuard('dev', 'owner')
  @Delete(':id')
  deleteAdmin(@Req() request: AdminRequest, @Param() params: AdminIdParamDto) {
    return this.adminService.deleteAdmin(request.admin!, params.id);
  }

  @Post('profile/image')
  @HttpCode(200)
  uploadProfileImage(@Req() request: AdminRequest) {
    return this.adminService.uploadProfileImage(request.admin!.id, request);
  }
}
