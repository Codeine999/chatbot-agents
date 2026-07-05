import { Injectable, Logger } from '@nestjs/common';
import { UserSessionService } from '../chatbot/user-session.service';
import { ReplyTemplateService } from '../chatbot/reply-template.service';
import { RegistrationFlowService } from '../registration/registration-flow.service';
import { AiChatService } from './aichat.service';
import { IntentRouterService } from './intent-router.service';

@Injectable()
export class ChatbotService {
  private readonly logger = new Logger(ChatbotService.name);

  constructor(
    private readonly intentRouterService: IntentRouterService,
    private readonly userSessionService: UserSessionService,
    private readonly registrationService: RegistrationFlowService,
    private readonly replyTemplateService: ReplyTemplateService,
    private readonly aiChatService: AiChatService,
  ) {}

  async handleTextMessage(userId: string, text: string): Promise<string> {
    const input = text.trim();

    if (!input) return this.replyTemplateService.defaultMessage();

    const session = this.userSessionService.get(userId);

    const decision = await this.intentRouterService.resolve({ 
      userId, 
      input, 
      session 
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
        this.userSessionService.clear(userId);
        return this.replyTemplateService.cancelled();

      case 'CONTINUE_REGISTER':
        return this.registrationService.handle(
          userId, input, session!
        );

      case 'START_REGISTER':
        return this.registrationService.start(userId);

      case 'START_AI_CHAT':
        this.userSessionService.set(userId, {
          userId,
          flow: 'GENERAL_QUESTION',
          step: 'WAITING_QUESTION',
          status: 'ACTIVE',
          data: {},
        });

      return this.replyTemplateService.askAiChatQuestion();

      // Inside an AI_CHAT session -> general/small-talk answer (NOT knowledge).
      case 'CONTINUE_AI_CHAT':
        return this.aiChatService.answerGeneral(input);

      // Casual/general answer without touching the knowledge base.
      case 'GENERAL_QUESTION':
        return this.aiChatService.answerGeneral(input);

      // Grounded answer from the knowledge base only.
      case 'ANSWER_KNOWLEDGE':
        return this.aiChatService.answerKnowLedge(input);

      case 'CONTACT_ADMIN':
        return this.replyTemplateService.contactAdmin();

      default:
        return this.replyTemplateService.defaultMessage();
    }
  }
}
