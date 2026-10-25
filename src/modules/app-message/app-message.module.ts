import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { CompanyModule } from '../admin/company/company.module';
import { NotificationModule } from '../admin/notification/notification.module';
import { ChatbotModule } from '../chatbot/chatbot.module';
import { CommerceAccessModule } from '../commerce/commerce-access.module';
import { MessagingModule } from '../events/message/messaging.module';
import { AppAbuseService } from './app-abuse.service';
import { AppChannelAdapter } from './app-channel.adapter';
import { AppHandoffHandler } from './app-handoff.handler';
import { AppInboxController } from './app-inbox.controller';
import { AppInboxService } from './app-inbox.service';
import { AppMaintenanceService } from './app-maintenance.service';
import { AppMessageConfig } from './app-message.config';
import { AppMessageController } from './app-message.controller';
import { AppMessageService } from './app-message.service';
import { AppSessionController } from './app-session.controller';
import { AppSessionService } from './app-session.service';
import { AppClientGuard } from './guards/app-client.guard';
import { AppSessionGuard } from './guards/app-session.guard';

/**
 * Guest chat over REST (web/mobile), answered by the same chatbot pipeline as
 * LINE and stored for the back-office inbox. Off unless APP_MESSAGE_ENABLED.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    CompanyModule,
    CommerceAccessModule,
    ChatbotModule,
    MessagingModule,
    NotificationModule,
  ],
  controllers: [AppSessionController, AppMessageController, AppInboxController],
  providers: [
    AppMessageConfig,
    AppClientGuard,
    AppSessionGuard,
    AppAbuseService,
    AppSessionService,
    AppChannelAdapter,
    AppMessageService,
    AppHandoffHandler,
    AppInboxService,
    AppMaintenanceService,
  ],
  exports: [AppMessageConfig],
})
export class AppMessageModule {}
