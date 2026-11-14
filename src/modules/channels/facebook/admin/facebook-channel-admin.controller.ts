import {
  Body,
  Controller,
  Delete,
  Get,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { AdminGuard } from '../../../../shared/guards/admin-guard.decorator';
import type { AdminRequest } from '../../../admin/admin-jwt-auth.guard';
import { ConnectFacebookChannelDto } from './facebook-channel.dto';
import { FacebookChannelAdminService } from './facebook-channel-admin.service';

/** Owner, dev and admin: connect, rotate or remove the company's Facebook Page. */
@AdminGuard('owner', 'dev', 'admin')
@Controller('api/admin/facebook/channel')
export class FacebookChannelAdminController {
  constructor(private readonly channels: FacebookChannelAdminService) {}

  @Get()
  status(@Req() request: AdminRequest) {
    return this.channels.status(this.admin(request));
  }

  @Put()
  connect(
    @Req() request: AdminRequest,
    @Body() body: ConnectFacebookChannelDto,
  ) {
    return this.channels.connect(this.admin(request), body);
  }

  @Delete()
  disconnect(@Req() request: AdminRequest) {
    return this.channels.disconnect(this.admin(request));
  }

  private admin(request: AdminRequest) {
    if (!request.admin)
      throw new UnauthorizedException('Admin authentication required');
    return request.admin;
  }
}
