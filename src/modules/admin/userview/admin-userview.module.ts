import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { ChatbotModule } from '../../chatbot/chatbot.module';
import { AdminUserViewController } from './admin-userview.controller';
import { AdminUserViewService } from './admin-userview.service';

@Module({
  imports: [PrismaModule, ChatbotModule],
  controllers: [AdminUserViewController],
  providers: [AdminUserViewService],
})
export class AdminUserViewModule {}
