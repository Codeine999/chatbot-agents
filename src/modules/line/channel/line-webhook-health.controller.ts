import {
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import type { AdminRequest } from '../../admin/admin-jwt-auth.guard';
import { LineWebhookHealthService } from './line-webhook-health.service';

/** Is the LINE webhook set up, reachable, and carrying real traffic? */
@AdminGuard('owner', 'dev', 'admin')
@Controller('api/admin/line/channel/webhook')
export class LineWebhookHealthController {
  constructor(private readonly health: LineWebhookHealthService) {}

  /** Layers 1 and 3: LINE console settings and real events received. */
  @Get()
  check(@Req() request: AdminRequest) {
    return this.health.check(this.admin(request));
  }

  /** Layer 2: ask LINE to send a signed sample event to the configured URL. */
  @Post('test')
  @HttpCode(200)
  test(@Req() request: AdminRequest) {
    return this.health.test(this.admin(request));
  }

  private admin(request: AdminRequest) {
    if (!request.admin)
      throw new UnauthorizedException('Admin authentication required');
    return request.admin;
  }
}
