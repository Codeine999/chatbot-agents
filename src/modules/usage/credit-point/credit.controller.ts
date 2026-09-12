import { Controller, Get, Post, Param, ParseUUIDPipe } from '@nestjs/common';
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

  @AdminGuard('dev', 'owner')
  @Get('reservations')
  unresolved() { return this.creditService.listUnresolvedReservations(); }

  // Explicit operator decision after checking an UNKNOWN provider outcome.
  @AdminGuard('dev', 'owner')
  @Post('reservations/:id/release')
  release(@Param('id', ParseUUIDPipe) id: string) { return this.creditService.releaseUnknownReservation(id); }

  /** Kept for existing back-office clients; same wallet as `GET /wallet`. */
  @Post('line-oa')
  getLineOaCredit() {
    return this.creditService.getWallet();
  }
}
