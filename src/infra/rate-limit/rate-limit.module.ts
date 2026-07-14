import { Global, Module } from '@nestjs/common';
import { AiBudgetService } from './ai-budget.service';
import { RateLimitService } from './rate-limit.service';

@Global()
@Module({
  providers: [RateLimitService, AiBudgetService],
  exports: [RateLimitService, AiBudgetService],
})
export class RateLimitModule {}
