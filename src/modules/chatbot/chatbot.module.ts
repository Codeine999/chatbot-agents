import { Module } from '@nestjs/common';
import { RegistrationModule } from '../registration/registration.module';
import { RegistrationFlowService } from '../registration/registration-flow.service';
import { RegisterParser } from '../registration/utils/register.parser';
import { RegisterValidator } from '../registration/utils/register.validator';
import { ChatbotService } from './chatbot.service';
import { RuleIntentService } from './rule-intent.service';
import { IntentRouterService } from './intent-router.service';
import { ReplyTemplateService } from './reply-template.service';
import { UserSessionService } from './user-session.service';
import { AiModule } from './ai.module';
import { NotificationModule } from '../admin/notification/notification.module';
import { LoadContextService } from './context/load-context.service';
import { StickerIntentService } from './sticker-intent.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { RichMenuReplyCacheService } from './menu/rich-menu-reply-cache.service';

@Module({
  imports: [PrismaModule, RegistrationModule, AiModule, NotificationModule],
  providers: [
    ChatbotService,
    RuleIntentService,
    IntentRouterService,
    ReplyTemplateService,
    UserSessionService,
    LoadContextService,
    StickerIntentService,
    RichMenuReplyCacheService,
    RegistrationFlowService,
    RegisterParser,
    RegisterValidator,
  ],
  exports: [
    ChatbotService,
    RichMenuReplyCacheService,
    ReplyTemplateService,
    UserSessionService,
    LoadContextService,
  ],
})
export class ChatbotModule {}
