import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserSessionService } from '../chatbot/user-session.service';
import { ReplyTemplateService } from '../chatbot/reply-template.service';
import { RegistrationFlowService } from '../registration/registration-flow.service';
import { AiChatService } from './aichat.service';
import { IntentRouterService } from './intent-router.service';
import { NotificationService } from '../admin/notification/notification.service';

@Injectable()
export class ChatbotService {
  private readonly logger = new Logger(ChatbotService.name);
  private readonly aiMaxMessageLength: number;

  constructor(
    private readonly intentRouterService: IntentRouterService,
    private readonly userSessionService: UserSessionService,
    private readonly registrationService: RegistrationFlowService,
    private readonly replyTemplateService: ReplyTemplateService,
    private readonly aiChatService: AiChatService,
    private readonly notificationService: NotificationService,
    private readonly configService: ConfigService,
  ) {
    this.aiMaxMessageLength = Number(
      this.configService.get('AI_MAX_MESSAGE_LENGTH') ?? 1000,
    );
  }

  private canRegister(): boolean {
    return this.configService.get<string>('CAN_REGISTER') !== 'false';
  }

  async handleTextMessage(userId: string, text: string): Promise<string> {
    const input = text.trim();

    if (!input) return this.replyTemplateService.defaultMessage();

    if (input.length > this.aiMaxMessageLength) {
      this.logger.warn(
        `message from ${userId} too long for AI: ${input.length} > ${this.aiMaxMessageLength}`,
      );
      return this.replyTemplateService.messageTooLong();
    }

    const session = await this.userSessionService.get(userId);

    const decision = await this.intentRouterService.resolve({ 
      userId,
      input,
      session,
    });

    this.logger.debug(
      `input="${input}" 
      action=${decision.action} 
      intent=${decision.intent} ` +
      `source=${decision.source} 
      confidence=${decision.confidence} 
      reason="${decision.reason ?? ''}"`,
    );

    switch (decision.action) {
      case 'CANCEL_SESSION':
        await this.userSessionService.clear(userId);
        return this.replyTemplateService.cancelled();

      case 'CONTINUE_REGISTER':
        if (!this.canRegister()) {
          await this.userSessionService.clear(userId);
          return this.replyTemplateService.registerUnavailable();
        }
        return this.registrationService.handle(userId, input, session!);

      case 'START_REGISTER':
        if (!this.canRegister()) {
          return this.replyTemplateService.registerUnavailable();
        }
        return this.registrationService.start(userId);

      case 'START_AI_CHAT':
        await this.userSessionService.set(userId, {
          userId,
          flow: 'GENERAL_QUESTION',
          step: 'WAITING_QUESTION',
          status: 'ACTIVE',
          data: {},
        });

        return this.replyTemplateService.askAiChatQuestion();

      case 'CONTINUE_AI_CHAT':
        return this.aiChatService.answerGeneral(input, userId);

      case 'GENERAL_QUESTION':
        return this.aiChatService.answerGeneral(input, userId);

      case 'ANSWER_KNOWLEDGE':
        return this.aiChatService.answerKnowLedge(input, userId);

      case 'CONTACT_ADMIN': {
        const contactAdminSession = {
          userId,
          flow: 'CONTACT_ADMIN' as const,
          step: 'WAITING_ADMIN',
          status: 'ACTIVE' as const,
          data: {},
        };

        await this.userSessionService.set(userId, contactAdminSession);
        this.notificationService.notifyContactAdmin(contactAdminSession);

        return this.replyTemplateService.contactAdmin();
      }

      default:
        return this.replyTemplateService.defaultMessage();
    }
  }
}
