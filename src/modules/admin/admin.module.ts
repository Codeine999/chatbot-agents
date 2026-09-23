import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminAuthModule } from './auth/admin-auth.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AiProviderModule } from '../ai/ai-provider.module';
import { AdminAnswerPatternController } from './knowledge/admin-answer-pattern.controller';
import { AdminAnswerPatternService } from './knowledge/admin-knowledge-pattern.service';
import { AiModule } from '../chatbot/ai.module';
import { AdminChatModule } from './ai-chat/admin-chat.module';
import { CompanyModule } from './company/company.module';
import { AdminBillModule } from './bill/admin-bill.module';
import { AdminAiPricingModule } from './pricing/admin-ai-pricing.module';
import { CreditExchangeRateModule } from './dev/credit/credit-exchange-rate.module';
import { AdminWalletModule } from './wallet/admin-wallet.module';
import { AdminUsageModule } from './usage/admin-usage.module';
import { AdminAnalyticsModule } from './analytics/admin-analytics.module';
import { RichMenuModule } from './richMenu/rich-menu.module';
import { AdminSysCategoryController } from './knowledge/admin-sys-category.controller';
import { AdminSysCategoryService } from './knowledge/admin-sys-category.service';
import { AdminKnowledgeMicroController } from './knowledge/admin-knowledge-micro.controller';
import { AdminKnowledgeMicroService } from './knowledge/admin-knowledge-micro.service';
import { MicroKnowledgeVectorRepository } from '../ai/embeding/micro-knowledge-vector.repository';
import { AdminAiSettingController } from './ai-setting/admin-ai-setting.controller';
import { AdminAiSettingService } from './ai-setting/admin-ai-setting.service';

@Module({
  imports: [
    AdminAuthModule,
    PrismaModule,
    AiProviderModule,
    AiModule,
    AdminChatModule,
    CompanyModule,
    AdminBillModule,
    AdminAiPricingModule,
    CreditExchangeRateModule,
    AdminWalletModule,
    AdminUsageModule,
    AdminAnalyticsModule,
    RichMenuModule,
  ],
  controllers: [
    AdminController,
    AdminAnswerPatternController,
    AdminSysCategoryController,
    AdminKnowledgeMicroController,
    AdminAiSettingController,
  ],
  providers: [
    AdminService,
    AdminAnswerPatternService,
    AdminSysCategoryService,
    AdminKnowledgeMicroService,
    MicroKnowledgeVectorRepository,
    AdminAiSettingService,
  ],
})
export class AdminModule {}
