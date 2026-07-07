import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { LineWebhookBody } from './dto/line';
import {
  GetLineMessagesQueryDto,
  SendLineMessageDto,
} from './dto/line-admin.dto';
import {
  LINE_EVENT_JOB,
  LINE_EVENTS_QUEUE,
  type LineEventJobData,
} from './line-events.queue';
import { LineSignatureGuard } from './line-signature.guard';
import { LineWebhookService } from './line-webhook.service';

@Controller('api/line')
export class LineController {
  constructor(
    private readonly lineWebhookService: LineWebhookService,
    @InjectQueue(LINE_EVENTS_QUEUE)
    private readonly lineEventsQueue: Queue<LineEventJobData>,
  ) {}

  @Post('webhooks')
  @HttpCode(200)
  @UseGuards(LineSignatureGuard)
  async handleWebhook(@Body() body: LineWebhookBody) {
    const events = (body.events ?? []).filter(
      (event) =>
        Boolean(event.webhookEventId) &&
        event.deliveryContext?.isRedelivery !== true,
    );

    // webhookEventId as jobId makes BullMQ drop duplicate deliveries.
    await Promise.all(
      events.map((event) =>
        this.lineEventsQueue.add(
          LINE_EVENT_JOB,
          { event },
          { jobId: event.webhookEventId },
        ),
      ),
    );

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
