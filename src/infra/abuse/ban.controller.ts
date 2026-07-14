import { Body, Controller, Post } from '@nestjs/common';
import { BanService } from './ban.service';
import { BanUserDto } from './dto/ban.dto';
import { AdminGuard } from '../auth/admin-guard.decorator';
import { Public } from '../auth/public.decorator';
/** Admin-only manual ban management. */
// @AdminGuard()
@Controller('api/abuse/bans')
export class BanController {
  constructor(private readonly banService: BanService) {}

  @Post()
  @Public()
  async ban(@Body() body: BanUserDto) {
    if (body.durationSec) {
      await this.banService.banTemporarily(
        body.userId,
        body.durationSec,
        body.reason,
      );
    } else {
      await this.banService.banPermanently(body.userId, body.reason);
    }

    return this.banService.getBanInfo(body.userId);
  }
}
