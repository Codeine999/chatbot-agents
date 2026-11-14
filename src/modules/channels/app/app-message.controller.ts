import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { AppAbuseService } from './app-abuse.service';
import { AppErrorFilter } from './app-error.filter';
import { sessionInvalid } from './app-errors';
import { AppMessageService } from './app-message.service';
import type { AppRequest } from './app-request';
import { ListMessagesQueryDto, SendMessageDto } from './dto/app-message.dto';
import { AppClientGuard } from './guards/app-client.guard';
import { AppSessionGuard } from './guards/app-session.guard';

/** Public: a guest chats with the bot using the session token. No admin role. */
@Controller('api/app/v1/messages')
@UseFilters(AppErrorFilter)
@UseGuards(AppClientGuard, AppSessionGuard)
export class AppMessageController {
  constructor(
    private readonly messages: AppMessageService,
    private readonly abuse: AppAbuseService,
  ) {}

  @Post()
  @HttpCode(200)
  send(@Req() request: AppRequest, @Body() body: SendMessageDto) {
    return this.messages.send(this.guest(request), body);
  }

  @Get()
  async list(@Req() request: AppRequest, @Query() query: ListMessagesQueryDto) {
    const guest = this.guest(request);
    await this.abuse.assertRead(guest);
    return this.messages.list(guest, query);
  }

  private guest(request: AppRequest) {
    if (!request.appGuest) throw sessionInvalid();
    return request.appGuest;
  }
}
