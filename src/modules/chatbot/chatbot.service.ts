import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserSessionService } from '../users/session/user-session.service';
import { ReplyTemplateService } from './answer/answer-template.service';
import { RegistrationFlowService } from '../registration/registration-flow.service';
import { AiChatService } from './answer/answer.service';
import { IntentRouterService } from './intent/intent-router.service';
import {
  ChatContextPolicy,
  ChatChannelKind,
  ChatRequest,
  ChatResponse,
  ChatResponseSource,
  ImageChatRequest,
  StickerChatRequest,
  AiAnswerResult,
} from './shared/types/chat.types';
import { StickerIntentService } from './intent/sticker-intent.service';
import { RichMenuReplyCacheService } from './menu/rich-menu-reply-cache.service';
import { logBlock, logSafeText } from '../../utils/text.utils';
import { isRegistrationEnabled } from '../registration/registration-feature';
import { CLARIFY_MESSAGE } from './shared/knowledge-routing.constants';
import { InsufficientCreditException } from '../usage/credit-point/insufficient-credit.exception';
import { isCancelKeyword } from './intent/utils/cancel-keyword';

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
    private readonly richMenuReplies: RichMenuReplyCacheService,
    private readonly configService: ConfigService,
  ) {
    this.aiMaxMessageLength = Number(
      this.configService.get('AI_MAX_MESSAGE_LENGTH') ?? 1000,
    );
  }

  async handleTextMessage(request: ChatRequest): Promise<ChatResponse> {
    try {
      return await this.answerText(request);
    } catch (error) {
      return this.withoutCredit(error, request);
    }
  }

  private async answerText(request: ChatRequest): Promise<ChatResponse> {
    const {
      userId,
      text,
      recentMessages = [],
      lineMemberId,
      conversationId,
      turnId,
      postbackData,
      preview,
      channel,
    } = request;

    const input = text.trim();
    const usage = { userId, lineMemberId, conversationId, turnId };

    if (await this.userSessionService.isMuted(userId)) {
      return this.response('', 'SYSTEM', 'EXCLUDE');
    }

    const session = await this.userSessionService.get(userId);
    this.logger.warn(`user session ${session}'`);

    if (!input) {
      return this.response(
        this.replyTemplateService.defaultMessage(this.richMenuReplies.labels()),
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

    this.logger.debug(
      logBlock('Inbound', [
        `user=${userId}`,
        `conversation=${conversationId ?? '-'}`,
        `turn=${turnId ?? '-'}`,
        `length=${input.length}`,
        `history=${recentMessages.length}`,
        `text=${JSON.stringify(logSafeText(input))}`,
      ]),
    );

    // Registration was switched off mid-flow: close the session on any input
    // except cancel, which the router answers. CONTINUE_REGISTER relies on it.
    if (
      session?.status === 'ACTIVE' &&
      session.flow === 'REGISTER' &&
      !this.canRegister(preview, channel) &&
      !isCancelKeyword(input)
    ) {
      await this.userSessionService.clear(userId);
      return this.response(
        this.replyTemplateService.registerUnavailable(),
        'REGISTRATION',
        'CLEAR',
      );
    }

    const decision = await this.intentRouterService.resolve({
      ...usage,
      input,
      session,
      recentMessages,
      postbackData,
    });

    this.logger.debug(
      logBlock('Route', [
        `action=${decision.action}`,
        `intent=${decision.intent}`,
        `source=${decision.source}`,
        `confidence=${decision.confidence}`,
        `reason=${JSON.stringify(decision.reason ?? '')}`,
      ]),
    );

    switch (decision.action) {
      case 'CANCEL_SESSION':
        if (session?.flow === 'REGISTER' && session.status === 'ACTIVE') {
          await this.userSessionService.clear(userId);
        }
        return this.response(
          this.replyTemplateService.cancelled(),
          'RULE',
          'CLEAR',
        );

      case 'CONTINUE_REGISTER':
        if (!this.canRegister(preview, channel)) {
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
        if (!this.canRegister(preview, channel)) {
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
        if (session?.flow !== 'REGISTER' || session.status !== 'ACTIVE') {
          await this.userSessionService.set(userId, {
            userId,
            flow: 'GENERAL_QUESTION',
            step: 'WAITING_QUESTION',
            status: 'ACTIVE',
            data: {},
          });
        }
        return this.response(
          this.replyTemplateService.askAiChatQuestion(),
          'RULE',
          'CLEAR',
        );

      case 'CONTINUE_AI_CHAT':
      case 'GENERAL_QUESTION':
        return this.aiResponse(
          await this.aiChatService.answerGeneral(input, {
            ...usage,
            recentMessages,
          }),
          'AI',
          userId,
        );

      case 'CLARIFY':
        return this.response(CLARIFY_MESSAGE, 'RULE', 'INCLUDE');

      case 'ANSWER_KNOWLEDGE': {
        const result = await this.aiChatService.answerKnowledge(input, {
          ...usage,
          recentMessages,
          retrievalQuery: decision.resolvedQuery,
          retrieval: decision.retrieval,
        });

        return this.aiResponse(
          result,
          decision.retrieval?.product?.plan.mode === 'GENERAL'
            ? 'AI'
            : 'KNOWLEDGE',
          userId,
        );
      }

      case 'RICH_MENU_REPLY': {
        if (!decision.richMenuReply) {
          return this.response(
            this.replyTemplateService.defaultMessage(
              this.richMenuReplies.labels(),
            ),
            'SYSTEM',
            'CLEAR',
          );
        }

        // A menu tap starts a fresh topic, so whatever flow was open ends here.
        if (session?.status === 'ACTIVE') {
          await this.userSessionService.clear(userId);
        }

        return this.response(decision.richMenuReply.replyText, 'RULE', 'CLEAR');
      }

      case 'CONTACT_ADMIN':
        return this.contactAdminResponse(userId, decision.businessFallback);

      case 'FALLBACK': {
        return this.contactAdminResponse(userId, true);
      }

      default:
        return this.response(
          this.replyTemplateService.defaultMessage(
            this.richMenuReplies.labels(),
          ),
          'SYSTEM',
          'CLEAR',
        );
    }
  }

  //  Image Handle Message
  async handleImageMessage(request: ImageChatRequest): Promise<ChatResponse> {
    if (await this.userSessionService.isMuted(request.userId)) {
      return this.response('', 'SYSTEM', 'EXCLUDE');
    }
    try {
      return await this.aiResponse(
        await this.aiChatService.answerImage(request.image, {
          userId: request.userId,
          lineMemberId: request.lineMemberId,
          conversationId: request.conversationId,
          turnId: request.turnId,
          recentMessages: request.recentMessages,
        }),
        'AI',
        request.userId,
      );
    } catch (error) {
      return this.withoutCredit(error, request);
    }
  }

  //  Image Handle Sticker
  async handleStickerMessage(
    request: StickerChatRequest,
  ): Promise<ChatResponse> {
    if (await this.userSessionService.isMuted(request.userId)) {
      return this.response('', 'SYSTEM', 'EXCLUDE');
    }
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
          turnId: request.turnId,
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

  /**
   * An unfunded wallet stops every AI call before a provider is contacted.
   * Nothing was answered: send no reply (no fallback, no admin handoff) and
   * log the reason. Any other error keeps propagating.
   */
  private withoutCredit(
    error: unknown,
    request: Pick<ChatRequest, 'userId' | 'conversationId' | 'turnId'>,
  ): ChatResponse {
    if (!(error instanceof InsufficientCreditException)) throw error;
    this.logger.error(
      logBlock('AiCredit', [
        'no reply sent: AI credit is insufficient',
        `user=${request.userId}`,
        `conversation=${request.conversationId ?? '-'}`,
        `turn=${request.turnId ?? '-'}`,
        `reason=${JSON.stringify(error.message)}`,
      ]),
    );
    return this.response('', 'SYSTEM', 'EXCLUDE');
  }

  private async aiResponse(
    result: AiAnswerResult,
    source: 'AI' | 'KNOWLEDGE',
    userId: string,
  ): Promise<ChatResponse> {
    if (result.isFallback) {
      await this.userSessionService.requestAdmin(userId);
      return this.response(result.text, 'SYSTEM', 'CLEAR');
    }
    return {
      ...this.response(result.text, source, 'INCLUDE'),
      ...(result.catalogRefs ? { catalogRefs: result.catalogRefs } : {}),
    };
  }

  private async contactAdminResponse(
    userId: string,
    businessFallback = false,
  ): Promise<ChatResponse> {
    await this.userSessionService.requestAdmin(userId);

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

  private canRegister(
    preview = false,
    channel: ChatChannelKind = 'LINE',
  ): boolean {
    return (
      !preview &&
      channel === 'LINE' &&
      isRegistrationEnabled(this.configService)
    );
  }
}
