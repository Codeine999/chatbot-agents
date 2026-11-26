import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserSessionService } from '../session/user-session.service';
import { ReplyTemplateService } from '../../shared/templates/answer-template.service';
import { RegistrationFlowService } from '../registration/registration-flow.service';
import { AiChatService } from './answer/answer.service';
import { IntentRouterService } from './intent/intent-router.service';
import {
  AssistantAct,
  ChatContextPolicy,
  ChatChannelKind,
  ChatRequest,
  ChatResponse,
  ChatResponseSource,
  ImageChatRequest,
  KnowledgeRetrievalResult,
  RoomStateContext,
  StickerChatRequest,
  AiAnswerResult,
  ChatContextMessage,
  SmallTalkReply,
} from '../../shared/contracts/chat.types';
import type { LineAiUsageContext } from '../usage/billing/ai-usage.types';
import { StickerIntentService } from './intent/sticker-intent.service';
import { RichMenuReplyCacheService } from './menu/rich-menu-reply-cache.service';
import { logBlock, logSafeText } from '../../utils/text.utils';
import { isRegistrationEnabled } from '../registration/registration-feature';
import { CLARIFY_MESSAGE } from '../../shared/knowledge/knowledge-routing.constants';
import { InsufficientCreditException } from '../usage/credit-point/insufficient-credit.exception';
import { isCancelKeyword } from './intent/utils/cancel-keyword';
import { DecisionTraceService } from '../decision-log/decision-trace.service';
import { CHANNEL_KINDS } from '../../shared/channel/channel-kinds';
import {
  TurnMetaStore,
  askedTextOf,
  roomStateOf,
} from './state/turn-meta.store';

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
    @Optional() private readonly decisionTrace?: DecisionTraceService,
    @Optional() private readonly turnMeta?: TurnMetaStore,
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
      this.decisionTrace?.answer({ mode: 'ADMIN_MUTED' });
      return this.response('', 'SYSTEM', 'EXCLUDE');
    }

    const session = await this.userSessionService.get(userId);
    this.logger.warn(`user session ${session}'`);

    if (!input) {
      this.decisionTrace?.answer({ mode: 'EMPTY_INPUT' });
      return this.response(
        this.replyTemplateService.defaultMessage(this.richMenuReplies.labels()),
        'SYSTEM',
        'CLEAR',
        'GREETED',
      );
    }

    if (input.length > this.aiMaxMessageLength) {
      this.logger.warn(
        `message from ${userId} too long for AI: 
        ${input.length} > ${this.aiMaxMessageLength}`,
      );

      this.decisionTrace?.answer({ mode: 'MESSAGE_TOO_LONG' });
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
    this.decisionTrace?.note('inbound', {
      length: input.length,
      history: recentMessages.length,
      sessionFlow: session?.flow ?? null,
      sessionStep: session?.step ?? null,
      menuTap: Boolean(postbackData),
    });

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

    // Preview rooms have no conversation row; their context is keyed by user.
    const metaKey = conversationId ?? (preview ? userId : undefined);
    const meta = metaKey ? await this.turnMeta?.load(metaKey) : undefined;
    const roomState = roomStateOf(
      request.handoffPending,
      meta,
      Date.now(),
      this.turnMeta?.adminActiveWindowSec,
    );

    const decision = await this.intentRouterService.resolve({
      ...usage,
      input,
      session,
      recentMessages,
      postbackData,
      meta,
      handoffPending: request.handoffPending,
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
    this.decisionTrace?.route(decision);
    this.decisionTrace?.note('route', {
      action: decision.action,
      intent: decision.intent,
      source: decision.source,
      confidence: decision.confidence,
      reason: decision.reason ?? null,
      fallbackReason: decision.fallbackReason ?? null,
    });
    this.decisionTrace?.enter('answer');

    switch (decision.action) {
      case 'CANCEL_SESSION':
        if (session?.flow === 'REGISTER' && session.status === 'ACTIVE') {
          await this.userSessionService.clear(userId);
        }
        return this.response(
          this.replyTemplateService.cancelled(),
          'RULE',
          'CLEAR',
          'GENERAL',
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
      case 'GENERAL_QUESTION': {
        const result = await this.aiChatService.answerGeneral(input, {
          ...usage,
          recentMessages,
          ...(roomState ? { roomState } : {}),
        });
        const waiting = roomState?.waitingForStaff === true;
        const response = await this.aiResponse(
          result,
          'AI',
          userId,
          waiting ? 'HANDOFF_NOTICE' : 'GENERAL',
        );
        return waiting && !result.isFallback
          ? { ...response, contextPolicy: 'EXCLUDE' }
          : response;
      }

      case 'CLARIFY':
        return this.response(
          CLARIFY_MESSAGE,
          'RULE',
          'INCLUDE',
          'ASKED',
          CLARIFY_MESSAGE,
        );

      case 'SMALL_TALK_REPLY':
        return this.smallTalkResponse(decision.smallTalk?.reply, input, {
          ...usage,
          recentMessages,
          ...(roomState ? { roomState } : {}),
        });

      case 'ANSWER_KNOWLEDGE': {
        const result = await this.aiChatService.answerKnowledge(input, {
          ...usage,
          recentMessages,
          ...(roomState ? { roomState } : {}),
          retrievalQuery: decision.resolvedQuery,
          retrieval: decision.retrieval,
          // Only a route that skipped both the classifier and a trusted rule
          // may leave grounding for general chat.
          allowGeneralExit:
            decision.retrieval?.route === 'RAG' &&
            (decision.source === 'CACHE' ||
              decision.source === 'DATABASE' ||
              decision.source === 'EMBEDDING'),
        });

        const general =
          decision.retrieval?.product?.plan.mode === 'GENERAL' ||
          result.general;
        const waitingGeneral =
          general && roomState?.waitingForStaff === true && !result.isFallback;

        const response = await this.aiResponse(
          result,
          general ? 'AI' : 'KNOWLEDGE',
          userId,
          waitingGeneral
            ? 'HANDOFF_NOTICE'
            : general
              ? 'GENERAL'
              : this.productAsksCustomer(decision.retrieval, result)
                ? 'ASKED'
                : 'ANSWERED',
        );
        return waitingGeneral
          ? { ...response, contextPolicy: 'EXCLUDE' }
          : response;
      }

      case 'RICH_MENU_REPLY': {
        if (!decision.richMenuReply) {
          return this.response(
            this.replyTemplateService.defaultMessage(
              this.richMenuReplies.labels(),
            ),
            'SYSTEM',
            'CLEAR',
            'GREETED',
          );
        }

        // A menu tap starts a fresh topic, so whatever flow was open ends here.
        if (session?.status === 'ACTIVE') {
          await this.userSessionService.clear(userId);
        }

        return this.response(
          decision.richMenuReply.replyText,
          'RULE',
          'CLEAR',
          'GREETED',
        );
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
          'GREETED',
        );
    }
  }

  //  Image Handle Message
  async handleImageMessage(request: ImageChatRequest): Promise<ChatResponse> {
    if (await this.userSessionService.isMuted(request.userId)) {
      this.decisionTrace?.answer({ mode: 'ADMIN_MUTED' });
      return this.response('', 'SYSTEM', 'EXCLUDE');
    }
    // A photo (slip, damage, document) is for a person to look at: no search,
    // no model call and no reply. The room is queued for an admin (notified
    // only when it was not already waiting) and the bot says nothing.
    this.decisionTrace?.handoff('IMAGE');
    this.decisionTrace?.answer({ mode: 'IMAGE_HANDOFF' });
    const requested = await this.userSessionService.requestAdmin(
      request.userId,
    );
    // Nothing is sent, so no delivery records the handoff: note it here, or a
    // "ครับ" / "ยังอยู่ไหม" after a slip would not know staff were asked.
    if (requested !== 'NO_ROOM' && request.conversationId) {
      await this.turnMeta?.markHandoffNotice(request.conversationId);
    }
    return this.response('', 'SYSTEM', 'CLEAR');
  }

  //  Image Handle Sticker
  async handleStickerMessage(
    request: StickerChatRequest,
  ): Promise<ChatResponse> {
    if (await this.userSessionService.isMuted(request.userId)) {
      this.decisionTrace?.answer({ mode: 'ADMIN_MUTED' });
      return this.response('', 'SYSTEM', 'EXCLUDE');
    }
    const decision = this.stickerIntentService.resolve({
      text: request.text,
      keywords: request.keywords,
    });
    this.decisionTrace?.note('rule', { sticker: decision.intent });

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

  /**
   * `act` says what the assistant just did (see AssistantAct). It is only
   * attached while TurnMeta is on, so with the feature off a response is
   * byte-for-byte what it was before.
   */
  private response(
    text: string,
    source: ChatResponseSource,
    contextPolicy: ChatContextPolicy,
    act?: AssistantAct,
    askedText?: string,
  ): ChatResponse {
    if (!act || !this.turnMeta?.enabled) return { text, source, contextPolicy };

    return {
      text,
      source,
      contextPolicy,
      assistantAct: act,
      ...(act === 'ASKED' && askedText
        ? { askedText: askedTextOf(askedText) }
        : {}),
    };
  }

  /**
   * A bare acknowledgement: silence, the waiting notice (both without a
   * model), or one general-chat call that reads the history. No retrieval and
   * no classifier run for it either way.
   */
  private async smallTalkResponse(
    reply: SmallTalkReply = 'SILENT',
    input: string,
    context: LineAiUsageContext & {
      userId: string;
      recentMessages: readonly ChatContextMessage[];
      roomState?: RoomStateContext;
    },
  ): Promise<ChatResponse> {
    if (reply === 'SILENT') {
      this.decisionTrace?.answer({ mode: 'SMALL_TALK_SILENT' });
      return this.response('', 'RULE', 'EXCLUDE');
    }

    if (reply === 'HANDOFF_WAITING' || reply === 'HANDOFF_WAITING_NUDGE') {
      const particle = await this.aiChatService.politeParticle();
      this.decisionTrace?.answer({ mode: 'SMALL_TALK' });
      return this.response(
        reply === 'HANDOFF_WAITING_NUDGE'
          ? this.replyTemplateService.handoffWaitingNudge(particle)
          : this.replyTemplateService.handoffWaiting(particle),
        'RULE',
        'EXCLUDE',
        'HANDOFF_NOTICE',
      );
    }

    const hasHistory = context.recentMessages.length > 0;
    const waiting = context.roomState?.waitingForStaff === true;
    this.decisionTrace?.note('answer', {
      phatic: true,
      skipped: ['retrieval', 'classifier'],
    });
    const result = await this.aiChatService.answerGeneral(input, context);
    const response = await this.aiResponse(
      result,
      'AI',
      context.userId,
      // In a waiting room it confirms the queue; in a conversation it only
      // acknowledges, so a second "ครับ" right after is left alone; in a new
      // room it opens the conversation.
      waiting ? 'HANDOFF_NOTICE' : hasHistory ? 'ACKED' : 'GREETED',
    );
    if (result.isFallback) return response;

    this.decisionTrace?.answer({ mode: 'PHATIC_GENERAL' });
    // "โอเคครับ" / waiting ack must not push the topic out of the three-turn context.
    return hasHistory || waiting
      ? { ...response, contextPolicy: 'EXCLUDE' }
      : response;
  }

  /** The product answer is a question back to the customer, not information. */
  private productAsksCustomer(
    retrieval: KnowledgeRetrievalResult | undefined,
    result: AiAnswerResult,
  ): boolean {
    const product = retrieval?.product;
    return (
      !result.isFallback &&
      !product?.failed &&
      product?.result.status === 'MISSING_INPUT' &&
      product.plan.mode !== 'GENERAL' &&
      product.plan.mode !== 'KNOWLEDGE'
    );
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
    this.decisionTrace?.answer({ mode: 'NO_CREDIT' });
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
    act: AssistantAct,
  ): Promise<ChatResponse> {
    if (result.isFallback) {
      // Every fallback branch should report why; a silent one still shows up.
      if (this.decisionTrace?.current()?.answer?.mode !== 'FALLBACK')
        this.decisionTrace?.answer({
          mode: 'FALLBACK',
          fallbackReason: 'UNREPORTED',
        });
      this.decisionTrace?.handoff('AI_FALLBACK');
      return this.fallbackResponse(userId, result.text);
    }
    if (result.handoff) {
      // Part of the question was answered; staff follow up on the rest.
      this.decisionTrace?.handoff('PARTIAL_ANSWER');
      await this.userSessionService.requestAdmin(userId);
    }
    return {
      ...this.response(
        result.text,
        source,
        'INCLUDE',
        result.handoff ? 'HANDOFF_NOTICE' : act,
        act === 'ASKED' ? result.text : undefined,
      ),
      ...(result.catalogRefs ? { catalogRefs: result.catalogRefs } : {}),
    };
  }

  private async contactAdminResponse(
    userId: string,
    businessFallback = false,
  ): Promise<ChatResponse> {
    this.decisionTrace?.handoff(
      businessFallback ? 'BUSINESS_FALLBACK' : 'CONTACT_ADMIN',
    );
    if (businessFallback) {
      // The reason is the router's (conflict, retrieval error, BUSINESS without evidence).
      this.decisionTrace?.answer({ mode: 'FALLBACK' });
      const fallback = await this.aiChatService.answerFallback();
      return this.fallbackResponse(userId, fallback.text);
    }

    await this.userSessionService.requestAdmin(userId);
    return this.response(
      this.replyTemplateService.contactAdmin(),
      'RULE',
      'CLEAR',
      'HANDOFF_NOTICE',
    );
  }

  private async fallbackResponse(
    userId: string,
    text: string,
  ): Promise<ChatResponse> {
    const request = await this.userSessionService.requestAdmin(userId);
    if (request === 'ALREADY_WAITING') {
      this.decisionTrace?.note('handoff', { fallbackNotice: 'SUPPRESSED' });
      return this.response('', 'SYSTEM', 'CLEAR');
    }
    // No room to hand off to: the customer got a fallback and nobody was told.
    return this.response(
      text,
      'SYSTEM',
      'CLEAR',
      request === 'REQUESTED' ? 'HANDOFF_NOTICE' : 'FALLBACK',
    );
  }

  private canRegister(
    preview = false,
    channel: ChatChannelKind = 'LINE',
  ): boolean {
    return (
      !preview &&
      CHANNEL_KINDS[channel].registration &&
      isRegistrationEnabled(this.configService)
    );
  }
}
