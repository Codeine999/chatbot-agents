import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  ParseUUIDPipe,
} from '@nestjs/common';
import type { AdminRequest } from '../admin/admin-jwt-auth.guard';
import { AdminGuard } from '../../shared/guards/admin-guard.decorator';
import {
  GetLineMessagesQueryDto,
  SendLineMessageDto,
} from './dto/line-admin.dto';
import { LineWebhookService } from './line-webhook.service';

@Controller('api/line')
export class LineController {
  constructor(private readonly lineWebhookService: LineWebhookService) {}

  @Get('conversations')
  @AdminGuard()
  listConversations() {
    return this.lineWebhookService.listConversations();
  }

  @Get('deliveries')
  @AdminGuard()
  deliveries() {
    return this.lineWebhookService.listDeliveries();
  }

  @Get('webhooks/failed')
  @AdminGuard('dev', 'owner')
  failedWebhooks() {
    return this.lineWebhookService.listFailedWebhookEvents();
  }

  @Post('conversations/:conversationId/resume-bot')
  @AdminGuard()
  resumeBot(@Param('conversationId', ParseUUIDPipe) conversationId: string) {
    return this.lineWebhookService.resumeBot(conversationId);
  }

  @Get('conversations/:conversationId/messages')
  @AdminGuard()
  getConversationMessages(
    @Param('conversationId') conversationId: string,
    @Query() query: GetLineMessagesQueryDto,
  ) {
    return this.lineWebhookService.getConversationMessages(
      conversationId,
      query,
    );
  }

  @Post('conversations/:conversationId/messages')
  @AdminGuard()
  sendAdminMessage(
    @Req() request: AdminRequest,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() body: SendLineMessageDto,
  ) {
    return this.lineWebhookService.sendAdminMessage(
      conversationId,
      body,
      request.admin?.id,
    );
  }
}

@AdminGuard()
@Controller('api/conversations')
export class LineConversationController {
  constructor(private readonly lineWebhookService: LineWebhookService) {}

  @Get()
  listConversations() {
    return this.lineWebhookService.listConversations();
  }

  @Get(':conversationId/messages')
  getConversationMessages(
    @Param('conversationId') conversationId: string,
    @Query() query: GetLineMessagesQueryDto,
  ) {
    return this.lineWebhookService.getConversationMessages(
      conversationId,
      query,
    );
  }

  @Post(':conversationId/messages')
  sendAdminMessage(
    @Req() request: AdminRequest,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() body: SendLineMessageDto,
  ) {
    return this.lineWebhookService.sendAdminMessage(
      conversationId,
      body,
      request.admin?.id,
    );
  }
}
