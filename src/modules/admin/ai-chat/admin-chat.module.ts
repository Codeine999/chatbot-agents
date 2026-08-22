import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AiProviderModule } from '../../ai/ai-provider.module';
import { CreditServiceModule } from '../../usage/credit-point/credit.module';
import { AdminChatController } from './admin-chat.controller';
import { AdminChatService } from './admin-chat.service';
import { AdminAiUsageService } from './admin-ai-usage.service';

@Module({
  imports: [PrismaModule, AiProviderModule, CreditServiceModule],
  controllers: [AdminChatController],
  providers: [AdminChatService, AdminAiUsageService],
  exports: [AdminAiUsageService],
})
export class AdminChatModule {}
