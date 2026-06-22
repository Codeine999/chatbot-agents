import { Controller, Post } from '@nestjs/common';
import { CreditService } from './credit.service';

@Controller('api/credits')
export class CreditServiceController {
  constructor(private readonly creditService: CreditService) {}

  @Post('line-oa')
  getLineOaCredit() {
    return this.creditService.getLineOaCredit();
  }
}
