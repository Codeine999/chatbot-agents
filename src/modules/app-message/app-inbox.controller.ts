import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { AdminGuard } from '../../shared/guards/admin-guard.decorator';
import type { AdminRequest } from '../admin/admin-jwt-auth.guard';
import { AppInboxService } from './app-inbox.service';
import {
  ListAppMessagesQueryDto,
  SendAppAdminMessageDto,
} from './dto/app-inbox.dto';

/** Back-office inbox for App Message rooms; any admin role may use it, like the LINE inbox. */
@AdminGuard()
@Controller('api/admin/app-conversations')
export class AppInboxController {
  constructor(private readonly inbox: AppInboxService) {}

  @Get()
  list(@Req() request: AdminRequest) {
    return this.inbox.listConversations(this.admin(request));
  }

  @Get(':conversationId/messages')
  messages(
    @Req() request: AdminRequest,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Query() query: ListAppMessagesQueryDto,
  ) {
    return this.inbox.getMessages(this.admin(request), conversationId, query);
  }

  @Post(':conversationId/messages')
  send(
    @Req() request: AdminRequest,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() body: SendAppAdminMessageDto,
  ) {
    return this.inbox.sendAdminMessage(
      this.admin(request),
      conversationId,
      body,
    );
  }

  @Post(':conversationId/pause-bot')
  pause(
    @Req() request: AdminRequest,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ) {
    return this.inbox.pauseBot(this.admin(request), conversationId);
  }

  @Post(':conversationId/resume-bot')
  resume(
    @Req() request: AdminRequest,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ) {
    return this.inbox.resumeBot(this.admin(request), conversationId);
  }

  private admin(request: AdminRequest) {
    if (!request.admin)
      throw new UnauthorizedException('Admin authentication required');
    return request.admin;
  }
}
