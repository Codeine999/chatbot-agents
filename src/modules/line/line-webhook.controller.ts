import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Public } from '../../shared/guards/public.decorator';
import { LineSignatureGuard } from './line-signature.guard';
import { LineWebhookAdapter } from './line-webhook.adapter';

/** Transport ingress only. Chatbot processing runs in the queue worker. */
@Controller('api/line')
export class LineWebhookController {
  constructor(private readonly webhookAdapter: LineWebhookAdapter) {}

  @Public()
  @Post('webhooks')
  @HttpCode(200)
  @UseGuards(LineSignatureGuard)
  async handleWebhook(@Body() body: unknown) {
    await this.webhookAdapter.receive(body);
    return { ok: true };
  }
}
