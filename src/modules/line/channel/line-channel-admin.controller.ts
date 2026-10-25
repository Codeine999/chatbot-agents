import {
  Body,
  Controller,
  Get,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import type { AdminRequest } from '../../admin/admin-jwt-auth.guard';
import { ConnectLineChannelDto } from './dto/line-channel.dto';
import { LineChannelAdminService } from './line-channel-admin.service';

/** Owner and dev: connect or rotate the company's LINE Messaging API channel. */
@AdminGuard('owner', 'dev')
@Controller('api/admin/line/channel')
export class LineChannelAdminController {
  constructor(private readonly channels: LineChannelAdminService) {}

  @Get()
  status(@Req() request: AdminRequest) {
    return this.channels.status(this.admin(request));
  }

  @Put()
  connect(@Req() request: AdminRequest, @Body() body: ConnectLineChannelDto) {
    return this.channels.connect(this.admin(request), body);
  }

  private admin(request: AdminRequest) {
    if (!request.admin)
      throw new UnauthorizedException('Admin authentication required');
    return request.admin;
  }
}
