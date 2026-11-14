import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  isStoredChannelKind,
  type StoredChannelKind,
} from '../../../../shared/channel/channel-kinds';
import { ListInboxConversationsQueryDto } from '../../../../shared/inbox/inbox-page';
import { AdminGuard } from '../../../../shared/guards/admin-guard.decorator';
import type { AdminRequest } from '../../../admin/admin-jwt-auth.guard';
import { ChannelInboxService } from './channel-inbox.service';
import {
  ListChannelMessagesQueryDto,
  SendChannelAdminMessageDto,
} from './channel-inbox.dto';

/**
 * Back-office inbox for channel* rooms; any admin role may use it, like the
 * LINE inbox. `app-conversations` is the original App route (kept for the
 * dashboard); `channels/:channel/conversations` serves every stored channel
 * (`facebook`, `app`, ...).
 */
@AdminGuard()
@Controller([
  'api/admin/app-conversations',
  'api/admin/channels/:channel/conversations',
])
export class ChannelInboxController {
  constructor(private readonly inbox: ChannelInboxService) {}

  @Get()
  list(
    @Req() request: AdminRequest,
    @Param('channel') channel: string | undefined,
    @Query() query: ListInboxConversationsQueryDto,
  ) {
    return this.inbox.listConversations(
      this.admin(request),
      this.channel(channel),
      query,
    );
  }

  @Get('counts')
  counts(
    @Req() request: AdminRequest,
    @Param('channel') channel: string | undefined,
  ) {
    return this.inbox.countConversations(
      this.admin(request),
      this.channel(channel),
    );
  }

  @Post(':conversationId/read')
  markRead(
    @Req() request: AdminRequest,
    @Param('channel') channel: string | undefined,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ) {
    return this.inbox.markConversationRead(
      this.admin(request),
      this.channel(channel),
      conversationId,
    );
  }

  @Get(':conversationId/messages')
  messages(
    @Req() request: AdminRequest,
    @Param('channel') channel: string | undefined,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Query() query: ListChannelMessagesQueryDto,
  ) {
    return this.inbox.getMessages(
      this.admin(request),
      this.channel(channel),
      conversationId,
      query,
    );
  }

  @Post(':conversationId/messages')
  send(
    @Req() request: AdminRequest,
    @Param('channel') channel: string | undefined,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() body: SendChannelAdminMessageDto,
  ) {
    return this.inbox.sendAdminMessage(
      this.admin(request),
      this.channel(channel),
      conversationId,
      body,
    );
  }

  @Post(':conversationId/pause-bot')
  pause(
    @Req() request: AdminRequest,
    @Param('channel') channel: string | undefined,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ) {
    return this.inbox.pauseBot(
      this.admin(request),
      this.channel(channel),
      conversationId,
    );
  }

  @Post(':conversationId/resume-bot')
  resume(
    @Req() request: AdminRequest,
    @Param('channel') channel: string | undefined,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ) {
    return this.inbox.resumeBot(
      this.admin(request),
      this.channel(channel),
      conversationId,
    );
  }

  /** No `:channel` in the path = the legacy App route. */
  private channel(raw: string | undefined): StoredChannelKind {
    const kind = (raw ?? 'APP').toUpperCase();
    if (!isStoredChannelKind(kind))
      throw new NotFoundException('Unknown channel');
    return kind;
  }

  private admin(request: AdminRequest) {
    if (!request.admin)
      throw new UnauthorizedException('Admin authentication required');
    return request.admin;
  }
}
