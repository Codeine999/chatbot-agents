import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AiChatService } from './aichat.service';

@Module({
  imports: [PrismaModule],
  providers: [AiChatService],
  exports: [AiChatService],
})
export class AiModule {}
