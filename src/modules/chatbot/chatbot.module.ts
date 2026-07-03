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

@Module({
  imports: [RegistrationModule, AiModule],
  providers: [
    ChatbotService,
    RuleIntentService,
    IntentRouterService,
    ReplyTemplateService,
    UserSessionService,
    RegistrationFlowService,
    RegisterParser,
    RegisterValidator,
  ],
  exports: [ChatbotService, ReplyTemplateService, UserSessionService],
})
export class ChatbotModule {}
