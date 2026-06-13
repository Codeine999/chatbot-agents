import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import type { LineWebhookBody } from './dto/line';
import { LineService } from './line-reply.service';
import { ChatbotService } from '../chatbot/chatbot.service';


@Controller('line')
export class LineController {
  constructor(
    private readonly lineService: LineService,
    private readonly chatbotService: ChatbotService
  ) {}

  @Post('webhooks/line')
  @HttpCode(200)
  async handleWebhook(
    @Headers('x-line-signature') signature: string,
    @Body() body: LineWebhookBody,
  ) {
    for (const event of body.events ?? []) {
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

      await this.lineService.replyText(event.replyToken, replyText);
    }

    return { ok: true };
  }


}
