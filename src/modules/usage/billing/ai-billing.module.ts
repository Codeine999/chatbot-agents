import { Module } from '@nestjs/common';
import { CreditServiceModule } from '../credit-point/credit.module';
import { AiBillingService } from './ai-billing.service';
import { AiPricingService } from './ai-pricing.service';

@Module({
  imports: [CreditServiceModule],
  providers: [AiPricingService, AiBillingService],
  exports: [AiPricingService, AiBillingService],
})
export class AiBillingModule {}
