import { Injectable } from '@nestjs/common';
import { UserSessionService } from '../chatbot/user-session.service';
import { ReplyTemplateService } from '../chatbot/reply-template.service';
import { IntentService } from './intent.service';
import { RegistrationFlowService } from '../registration/registration-flow.service';
import { AiChatService } from './aichat.service';

@Injectable()
export class ChatbotService {
  constructor(
    private readonly intentService: IntentService,
    private readonly userSessionService: UserSessionService,
    private readonly registrationService: RegistrationFlowService,
    private readonly replyTemplateService: ReplyTemplateService,
    private readonly aiChatService: AiChatService,
  ) {}

  async handleTextMessage(userId: string, text: string): Promise<string> {
    const input = text.trim();
    const status = this.intentService.detect(input);

    if (status === 'CANCEL') {
      this.userSessionService.clear(userId);
      return this.replyTemplateService.cancelled();
    }

    const session = this.userSessionService.get(userId);

    if (session?.flow === 'REGISTER' && session?.status === 'ACTIVE') {
      return this.registrationService.handle(userId, input, session);
    }

    if (session?.flow === 'AI_CHAT' && session?.status === 'ACTIVE') {
      return this.aiChatService.answerCustomer(input);
    }

    if (status === 'REGISTER') {
      return this.registrationService.start(userId);
    }

    if (status === 'AI_CHAT') {
      this.userSessionService.set(userId, {
        userId,
        flow: 'AI_CHAT',
        step: 'WAITING_QUESTION',
        status: 'ACTIVE',
        data: {},
      });

      return 'ได้เลยครับ ต้องการสอบถามเรื่องอะไร พิมพ์คำถามมาได้เลยครับ';
    }

    // if (status === 'GENERAL_QUESTION') {
    //   return this.aiChatService.answerCustomer(input);
    // }

    return this.replyTemplateService.defaultMessage();
  }
}
