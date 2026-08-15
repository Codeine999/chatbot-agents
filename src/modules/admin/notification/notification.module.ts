import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { NotificationController } from './notification.controller';
import { NotificationGateway } from './notification.gateway';
import { NotificationService } from './notification.service';

@Module({
  imports: [PrismaModule],
  controllers: [NotificationController],
  providers: [NotificationGateway, NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
