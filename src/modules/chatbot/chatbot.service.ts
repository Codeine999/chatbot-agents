import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserSessionService } from '../chatbot/user-session.service';
import { ReplyTemplateService } from '../chatbot/reply-template.service';
import { RegistrationFlowService } from '../registration/registration-flow.service';
import { AiChatService } from './aichat.service';
import { IntentRouterService } from './intent-router.service';
import {
  ChatContextPolicy,
  ChatRequest,
  ChatResponse,
  ChatResponseSource,
  ImageChatRequest,
  RouteDecision,
  StickerChatRequest,
} from './types/chat.types';
import { StickerIntentService } from './sticker-intent.service';
import { ControlMode } from './types/session.types';

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
    private readonly stickerIntentService: StickerIntentService,
    private readonly configService: ConfigService,
  ) {
    this.aiMaxMessageLength = Number(
      this.configService.get('AI_MAX_MESSAGE_LENGTH') ?? 1000,
    );
  }

  async handleTextMessage(request: ChatRequest): Promise<ChatResponse> {
    const {
      userId,
      text,
      recentMessages = [],
      lineMemberId,
      conversationId,
    } = request;
    const input = text.trim();
    const usage = { userId, lineMemberId, conversationId };

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
      ...usage,
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
          controlMode: ControlMode.AI,
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
            ...usage,
            recentMessages,
          }),
          'AI',
        );

      case 'GENERAL_QUESTION':
        return this.answerGeneralDecision(decision);

      case 'FALLBACK': {
        const fallback = await this.aiChatService.answerFallback();
        return this.response(fallback.text, 'SYSTEM', 'EXCLUDE');
      }

      case 'ANSWER_KNOWLEDGE': {
        const result = await this.aiChatService.answerKnowledge(input, {
          ...usage,
          recentMessages,
          retrievalQuery: decision.resolvedQuery,
          retrieval: decision.retrieval,
        });

        if (!result.insufficientContext) {
          return this.aiResponse(result, 'KNOWLEDGE');
        }

        const lowConfidenceDecision =
          await this.intentRouterService.resolveLowConfidence({
            ...usage,
            input,
            recentMessages,
            retrieval: decision.retrieval,
            fallbackReason: 'INSUFFICIENT_CONTEXT',
          });

        return this.executeLowConfidenceDecision(lowConfidenceDecision, userId);
      }

      case 'CONTACT_ADMIN':
        return this.contactAdminResponse(userId, decision.businessFallback);

      default:
        return this.response(
          this.replyTemplateService.defaultMessage(),
          'SYSTEM',
          'CLEAR',
        );
    }
  }

  //  Image Handle Message
  async handleImageMessage(request: ImageChatRequest): Promise<ChatResponse> {
    return this.aiResponse(
      await this.aiChatService.answerImage(request.image, {
        userId: request.userId,
        lineMemberId: request.lineMemberId,
        conversationId: request.conversationId,
        recentMessages: request.recentMessages,
      }),
      'AI',
    );
  }

  //  Image Handle Sticker
  async handleStickerMessage(
    request: StickerChatRequest,
  ): Promise<ChatResponse> {
    const decision = this.stickerIntentService.resolve({
      text: request.text,
      keywords: request.keywords,
    });

    switch (decision.intent) {
      case 'GREETING':
        return this.response(
          this.replyTemplateService.stickerGreeting(),
          'RULE',
          'EXCLUDE',
        );

      case 'THANKS':
        return this.response(
          this.replyTemplateService.stickerThanks(),
          'RULE',
          'EXCLUDE',
        );

      case 'TEXT':
        return this.handleTextMessage({
          userId: request.userId,
          lineMemberId: request.lineMemberId,
          conversationId: request.conversationId,
          text: decision.text,
          recentMessages: request.recentMessages,
        });

      default:
        return this.response(
          this.replyTemplateService.stickerUnknown(),
          'SYSTEM',
          'EXCLUDE',
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

  private async answerGeneralDecision(
    decision: RouteDecision,
  ): Promise<ChatResponse> {
    if (decision.generatedResponse?.trim()) {
      return this.response(decision.generatedResponse.trim(), 'AI', 'INCLUDE');
    }

    const fallback = await this.aiChatService.answerFallback();
    return this.response(fallback.text, 'SYSTEM', 'EXCLUDE');
  }

  private async executeLowConfidenceDecision(
    decision: RouteDecision,
    userId: string,
  ): Promise<ChatResponse> {
    if (decision.action === 'GENERAL_QUESTION') {
      return this.answerGeneralDecision(decision);
    }

    if (decision.action === 'CONTACT_ADMIN') {
      return this.contactAdminResponse(userId, decision.businessFallback);
    }

    const fallback = await this.aiChatService.answerFallback();
    return this.response(fallback.text, 'SYSTEM', 'EXCLUDE');
  }

  private async contactAdminResponse(
    userId: string,
    businessFallback = false,
  ): Promise<ChatResponse> {
    const contactAdminSession = {
      userId,
      flow: 'CONTACT_ADMIN' as const,
      step: 'WAITING_ADMIN',
      status: 'ACTIVE' as const,
      controlMode: ControlMode.ADMIN,
      requiAdmin: true,
      data: {},
    };

    // UserSessionService.set() notifies admins automatically when
    // requiAdmin is true — no separate notify call needed here.
    await this.userSessionService.set(userId, contactAdminSession);

    if (businessFallback) {
      const fallback = await this.aiChatService.answerFallback();
      return this.response(fallback.text, 'SYSTEM', 'CLEAR');
    }

    return this.response(
      this.replyTemplateService.contactAdmin(),
      'RULE',
      'CLEAR',
    );
  }

  private canRegister(): boolean {
    return this.configService.get<string>('CAN_REGISTER') !== 'false';
  }
}
