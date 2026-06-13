import { Injectable } from '@nestjs/common';
import {
  CompleteRegisterSessionData,
  RegisterSessionData,
  RegisterStep,
} from './types/register-session.types';
import {
  ConversationSession,
  UserSessionService,
} from '../chatbot/user-session.service';
import { ReplyTemplateService } from '../chatbot/reply-template.service';
import { RegistrationService } from './registration.service';
import { RegisterParser } from './utils/register.parser';
import { RegisterValidator } from './utils/register.validator';

@Injectable()
export class RegistrationFlowService {
  constructor(
    private readonly userSessionService: UserSessionService,
    private readonly replyTemplateService: ReplyTemplateService,
    private readonly registrationService: RegistrationService,
    private readonly registerParser: RegisterParser,
    private readonly registerValidator: RegisterValidator,
  ) {}

  start(userId: string): string {
    const session: ConversationSession<RegisterSessionData> = {
      userId,
      flow: 'REGISTER',
      step: RegisterStep.WAITING_REGISTER_FORM,
      status: 'ACTIVE',
      data: {},
    };

    this.userSessionService.set(userId, session);

    return this.handleWaitingRegisterForm(userId, session);
  }

  async handle(
    userId: string,
    input: string,
    session: ConversationSession,
  ): Promise<string> {
    switch (session.step) {
      case RegisterStep.WAITING_REGISTER_FORM:
        return this.handleWaitingRegisterForm(userId, session);

      case RegisterStep.SEND_REGISTER_FORM:
        return this.handleSendRegisterForm(userId, input, session);

      case RegisterStep.CURRENT_REGISTER:
      case RegisterStep.PENDING_REGISTER: {
        const data = session.data as RegisterSessionData;

        if (!this.registerValidator.isComplete(data)) {
          return this.replyTemplateService.missingRegisterFields(
            this.registerValidator.getMissingFields(data),
          );
        }

        return this.handleCurrentRegister(userId, session, data);
      }

      default:
        this.userSessionService.clear(userId);
        return this.replyTemplateService.defaultMessage();
    }
  }

  private handleWaitingRegisterForm(
    userId: string,
    session: ConversationSession,
  ): string {
    this.userSessionService.set(userId, {
      ...session,
      step: RegisterStep.SEND_REGISTER_FORM,
      data: session.data ?? {},
    });

    return this.replyTemplateService.askRegisterIntent();
  }

  private handleSendRegisterForm(
    userId: string,
    input: string,
    session: ConversationSession,
  ): Promise<string> | string {
    const oldData = session.data as RegisterSessionData;
    const parsedData = this.registerParser.parse(input, oldData);

    const mergedData: RegisterSessionData = {
      ...oldData,
      ...parsedData,
    };

    this.userSessionService.set(userId, {
      ...session,
      step: RegisterStep.SEND_REGISTER_FORM,
      data: mergedData,
    });

    const missingFields = this.registerValidator.getMissingFields(mergedData);

    if (missingFields.length > 0) {
      return this.replyTemplateService.missingRegisterFields(missingFields);
    }

    if (!this.registerValidator.isValidPhoneNumber(mergedData.phoneNumber)) {
      return this.replyTemplateService.invalidPhoneNumber();
    }

    if (!this.registerValidator.isValidBankAccount(mergedData.bankAccount)) {
      return this.replyTemplateService.invalidBankAccount();
    }

    if (this.registerValidator.isComplete(mergedData)) {
      return this.handleCurrentRegister(userId, session, mergedData);
    }

    return this.replyTemplateService.missingRegisterFields(
      this.registerValidator.getMissingFields(mergedData),
    );
  }

  private async handleCurrentRegister(
    userId: string,
    session: ConversationSession,
    data: CompleteRegisterSessionData,
  ): Promise<string> {
    this.userSessionService.set(userId, {
      ...session,
      step: RegisterStep.CURRENT_REGISTER,
      data,
    });

    try {
      const auth = await this.registrationService.register(data);

      this.userSessionService.set(userId, {
        ...session,
        step: RegisterStep.CURRENT_REGISTER,
        status: 'COMPLETED',
        data: {
          ...data,
          username: auth.username,
        },
      });

      return this.replyTemplateService.sendAuthToUser(auth);
    } catch (error) {
      this.userSessionService.set(userId, {
        ...session,
        step: RegisterStep.SEND_REGISTER_FORM,
        data,
      });

      return this.getRegistrationErrorMessage(error);
    }
  }

  private getRegistrationErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }

    return 'สมัครสมาชิกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
  }
}
