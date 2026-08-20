import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AiProviderModule } from '../../ai/ai-provider.module';
import { AdminChatController } from './admin-chat.controller';
import { AdminChatService } from './admin-chat.service';
import { AdminAiUsageService } from './admin-ai-usage.service';

@Module({
  imports: [PrismaModule, AiProviderModule],
  controllers: [AdminChatController],
  providers: [AdminChatService, AdminAiUsageService],
  exports: [AdminAiUsageService],
})
export class AdminChatModule {}
