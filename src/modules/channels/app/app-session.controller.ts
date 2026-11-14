import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { AppAbuseService } from './app-abuse.service';
import { AppErrorFilter } from './app-error.filter';
import { sessionInvalid } from './app-errors';
import type { AppRequest } from './app-request';
import { AppSessionService } from './app-session.service';
import { CreateSessionDto } from './dto/app-session.dto';
import { AppClientGuard } from './guards/app-client.guard';
import { AppSessionGuard } from './guards/app-session.guard';

/** Public: guests start here. No admin role; protected by rate limits. */
@Controller('api/app/v1')
@UseFilters(AppErrorFilter)
@UseGuards(AppClientGuard)
export class AppSessionController {
  constructor(
    private readonly sessions: AppSessionService,
    private readonly abuse: AppAbuseService,
  ) {}

  @Post('sessions')
  @HttpCode(201)
  create(@Req() request: AppRequest, @Body() body: CreateSessionDto) {
    if (!request.appCaller) throw sessionInvalid();
    return this.sessions.create(request.appCaller.ipHash, body);
  }

  @Get('session')
  @UseGuards(AppSessionGuard)
  async current(@Req() request: AppRequest) {
    const guest = this.guest(request);
    await this.abuse.assertRead(guest);
    return this.sessions.describe(guest);
  }

  @Delete('session')
  @HttpCode(204)
  @UseGuards(AppSessionGuard)
  async revoke(@Req() request: AppRequest): Promise<void> {
    await this.sessions.revoke(this.guest(request).sessionId);
  }

  private guest(request: AppRequest) {
    if (!request.appGuest) throw sessionInvalid();
    return request.appGuest;
  }
}
