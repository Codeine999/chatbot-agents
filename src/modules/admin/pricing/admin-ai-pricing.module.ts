import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AiProviderModule } from '../../ai/ai-provider.module';
import { AdminAiPricingController } from './admin-ai-pricing.controller';
import { AdminAiPricingService } from './admin-ai-pricing.service';
import { AiPricingCatalogService } from './ai-pricing-catalog.service';

@Module({
  imports: [PrismaModule, AiProviderModule],
  controllers: [AdminAiPricingController],
  providers: [AdminAiPricingService, AiPricingCatalogService],
  exports: [AdminAiPricingService, AiPricingCatalogService],
})
export class AdminAiPricingModule {}
