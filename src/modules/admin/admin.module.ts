import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminAuthModule } from './auth/admin-auth.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AiProviderModule } from '../ai/ai-provider.module';
import { AdminAnswerPatternController } from './knowledge/admin-answer-pattern.controller';
import { AdminAnswerPatternService } from './knowledge/admin-answer-pattern.service';
import { AiModule } from '../chatbot/ai.module';
import { AdminChatModule } from './ai-chat/admin-chat.module';
import { CompanyModule } from './company/company.module';
import { AdminBillModule } from './bill/admin-bill.module';

@Module({
  imports: [
    AdminAuthModule,
    PrismaModule,
    AiProviderModule,
    AiModule,
    AdminChatModule,
    CompanyModule,
    AdminBillModule,
  ],
  controllers: [AdminController, AdminAnswerPatternController],
  providers: [AdminService, AdminAnswerPatternService],
})
export class AdminModule {}
