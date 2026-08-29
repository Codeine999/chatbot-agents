import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../../prisma/prisma.module';
import { CreditExchangeRateController } from './credit-exchange-rate.controller';
import { CreditExchangeRateService } from './credit-exchange-rate.service';

@Module({
  imports: [PrismaModule],
  controllers: [CreditExchangeRateController],
  providers: [CreditExchangeRateService],
})
export class CreditExchangeRateModule {}
