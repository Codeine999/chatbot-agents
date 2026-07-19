import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserSessionService } from '../chatbot/user-session.service';
import { ReplyTemplateService } from '../chatbot/reply-template.service';
import { RegistrationFlowService } from '../registration/registration-flow.service';
import { AiChatService } from './aichat.service';
import { IntentRouterService } from './intent-router.service';
import { NotificationService } from '../admin/notification/notification.service';
import {
  ChatContextPolicy,
  ChatRequest,
  ChatResponse,
  ChatResponseSource,
} from './types/chat.types';

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

  async handleTextMessage(request: ChatRequest): Promise<ChatResponse> {
    const { userId, text, recentMessages = [] } = request;
    const input = text.trim();

    if (!input) {
      return this.response(
        this.replyTemplateService.defaultMessage(),
        'SYSTEM',
        'CLEAR',
      );
    }

    if (input.length > this.aiMaxMessageLength) {
      this.logger.warn(
        `message from ${userId} too long for AI: 
        ${input.length} > ${this.aiMaxMessageLength}`,
      );
      return this.response(
        this.replyTemplateService.messageTooLong(),
        'SYSTEM',
        'EXCLUDE',
      );
    }

    const session = await this.userSessionService.get(userId);

    const decision = await this.intentRouterService.resolve({
      userId,
      input,
      session,
      recentMessages,
    });

    this.logger.debug(
      `route action=${decision.action} intent=${decision.intent} ` +
        `source=${decision.source} confidence=${decision.confidence} ` +
        `reason="${decision.reason ?? ''}"`,
    );

    switch (decision.action) {
      case 'CANCEL_SESSION':
        await this.userSessionService.clear(userId);
        return this.response(
          this.replyTemplateService.cancelled(),
          'RULE',
          'CLEAR',
        );

      case 'CONTINUE_REGISTER':
        if (!this.canRegister()) {
          await this.userSessionService.clear(userId);

          return this.response(
            this.replyTemplateService.registerUnavailable(),
            'REGISTRATION',
            'CLEAR',
          );
        }

        return this.response(
          await this.registrationService.handle(userId, input, session!),
          'REGISTRATION',
          'CLEAR',
        );

      case 'START_REGISTER':
        if (!this.canRegister()) {

          return this.response(
            this.replyTemplateService.registerUnavailable(),
            'REGISTRATION',
            'CLEAR',
          );
        }
        
        return this.response(
          await this.registrationService.start(userId),
          'REGISTRATION',
          'CLEAR',
        );

      case 'START_AI_CHAT':
        await this.userSessionService.set(userId, {
          userId,
          flow: 'GENERAL_QUESTION',
          step: 'WAITING_QUESTION',
          status: 'ACTIVE',
          data: {},
        });

        return this.response(
          this.replyTemplateService.askAiChatQuestion(),
          'RULE',
          'CLEAR',
        );

      case 'CONTINUE_AI_CHAT':
        return this.aiResponse(
          await this.aiChatService.answerGeneral(input, {
            userId,
            recentMessages,
          }),
          'AI',
        );

      case 'GENERAL_QUESTION':
        return this.aiResponse(
          await this.aiChatService.answerGeneral(input, {
            userId,
            recentMessages,
          }),
          'AI',
        );

      case 'FALLBACK': {
        const fallback = await this.aiChatService.answerFallback();
        return this.response(fallback.text, 'SYSTEM', 'EXCLUDE');
      }

      case 'ANSWER_KNOWLEDGE':
        return this.aiResponse(
          await this.aiChatService.answerKnowledge(input, {
            userId,
            recentMessages,
            retrievalQuery: decision.resolvedQuery,
          }),
          'KNOWLEDGE',
        );

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

        return this.response(
          this.replyTemplateService.contactAdmin(),
          'RULE',
          'CLEAR',
        );
      }

      default:
        return this.response(
          this.replyTemplateService.defaultMessage(),
          'SYSTEM',
          'CLEAR',
        );
    }
  }

  private response(
    text: string,
    source: ChatResponseSource,
    contextPolicy: ChatContextPolicy,
  ): ChatResponse {
    return { text, source, contextPolicy };
  }

  private aiResponse(
    result: { text: string; isFallback: boolean },
    source: 'AI' | 'KNOWLEDGE',
  ): ChatResponse {
    return this.response(
      result.text,
      source,
      result.isFallback ? 'EXCLUDE' : 'INCLUDE',
    );
  }
}
