import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { AdminGuard } from '../../infra/auth/admin-guard.decorator';
import { Public } from '../../infra/auth/public.decorator';
import { RateLimitService } from '../../infra/rate-limit/rate-limit.service';
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
  private readonly logger = new Logger(LineController.name);
  private readonly globalIngressLimitPerSec: number;

  constructor(
    private readonly lineWebhookService: LineWebhookService,
    private readonly rateLimitService: RateLimitService,
    @InjectQueue(LINE_EVENTS_QUEUE)
    private readonly lineEventsQueue: Queue<LineEventJobData>,
    configService: ConfigService,
  ) {
    this.globalIngressLimitPerSec = Number(
      configService.get('LINE_GLOBAL_INGRESS_LIMIT_PER_SEC') ?? 100,
    );
  }

  @Public()
  @Post('webhooks')
  @HttpCode(200)
  @UseGuards(LineSignatureGuard)
  async handleWebhook(@Body() body: LineWebhookBody) {
    const events = (body.events ?? []).filter(
      (event) =>
        Boolean(event.webhookEventId) &&
        event.deliveryContext?.isRedelivery !== true,
    );

    if (events.length > 0) {
      const ingress = await this.rateLimitService.consume(
        'rl:line:global:ingress',
        this.globalIngressLimitPerSec,
        1,
        events.length,
      );

      if (!ingress.allowed) {
        this.logger.warn(
          `global ingress limit exceeded: ${ingress.current}/${ingress.limit} 
          events per sec, dropping ${events.length} events`,
        );
        return { ok: true };
      }
    }

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
  @AdminGuard()
  listConversations() {
    return this.lineWebhookService.listConversations();
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
    @Param('conversationId') conversationId: string,
    @Body() body: SendLineMessageDto,
  ) {
    return this.lineWebhookService.sendAdminMessage(conversationId, body);
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
    @Param('conversationId') conversationId: string,
    @Body() body: SendLineMessageDto,
  ) {
    return this.lineWebhookService.sendAdminMessage(conversationId, body);
  }
}
