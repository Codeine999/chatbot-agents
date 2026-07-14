import { Controller, Post } from '@nestjs/common';
import { AdminGuard } from '../../infra/auth/admin-guard.decorator';
import { CreditService } from './credit.service';

@AdminGuard()
@Controller('api/credits')
export class CreditServiceController {
  constructor(private readonly creditService: CreditService) {}

  @Post('line-oa')
  getLineOaCredit() {
    return this.creditService.getLineOaCredit();
  }
}
