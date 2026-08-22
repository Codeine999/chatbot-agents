import { Controller, Get, Post } from '@nestjs/common';
import { AdminGuard } from '../../../shared/guards/admin-guard.decorator';
import { CreditService } from './credit.service';

@AdminGuard()
@Controller('api/credits')
export class CreditServiceController {
  constructor(private readonly creditService: CreditService) {}

  @Get('wallet')
  getWallet() {
    return this.creditService.getWallet();
  }

  /** Kept for existing back-office clients; same wallet as `GET /wallet`. */
  @Post('line-oa')
  getLineOaCredit() {
    return this.creditService.getWallet();
  }
}
