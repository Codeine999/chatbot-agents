import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { LineWebhookBody } from './dto/line';
import {
  GetLineMessagesQueryDto,
  SendLineMessageDto,
} from './dto/line-admin.dto';
import { LineService } from './line-reply.service';
import { LineWebhookService } from './line-webhook.service';
import { ChatbotService } from '../chatbot/chatbot.service';
import { CreditService } from '../creditService/credit.service';

@Controller('api/line')
export class LineController {
  constructor(
    private readonly lineService: LineService,
    private readonly chatbotService: ChatbotService,
    private readonly creditService: CreditService,
    private readonly lineWebhookService: LineWebhookService,
  ) {}

  @Post('webhooks')
  @HttpCode(200)
  async handleWebhook(
    @Headers('x-line-signature') signature: string,
    @Body() body: LineWebhookBody,
  ) {
    void signature;

    for (const event of body.events ?? []) {
      const savedIncomingEvent =
        await this.lineWebhookService.saveIncomingEvent(event);

      if (event.type !== 'message') {
        continue;
      }

      if (event.message.type !== 'text') {
        continue;
      }

      if (!event.source?.userId) {
        continue;
      }

      const replyText = await this.chatbotService.handleTextMessage(
        event.source.userId,
        event.message.text,
      );

      await this.creditService.reserveLineReplyCredit();

      try {
        await this.lineService.replyText(event.replyToken, replyText);
      } catch (error) {
        await this.creditService.refundLineReplyCredit();
        throw error;
      }

      if (savedIncomingEvent) {
        await this.lineWebhookService.saveSystemReplyMessage(
          savedIncomingEvent.conversationId,
          savedIncomingEvent.lineMemberId,
          replyText,
        );
      }
    }

    return { ok: true };
  }

  @Get('conversations')
  listConversations() {
    return this.lineWebhookService.listConversations();
  }

  @Get('conversations/:conversationId/messages')
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
  sendAdminMessage(
    @Param('conversationId') conversationId: string,
    @Body() body: SendLineMessageDto,
  ) {
    return this.lineWebhookService.sendAdminMessage(conversationId, body);
  }
}

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
    @Param('conversationId') conversationId: string,
    @Body() body: SendLineMessageDto,
  ) {
    return this.lineWebhookService.sendAdminMessage(conversationId, body);
  }
}
