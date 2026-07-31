import { Module } from '@nestjs/common';
import { CreditServiceController } from './credit.controller';
import { CreditService } from './credit.service';

@Module({
  controllers: [CreditServiceController],
  providers: [CreditService],
  exports: [CreditService],
})
export class CreditServiceModule {}
