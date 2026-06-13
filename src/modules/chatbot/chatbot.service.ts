import { Injectable } from '@nestjs/common';
import { UserSessionService } from '../chatbot/user-session.service';
import { ReplyTemplateService } from '../chatbot/reply-template.service';
import { IntentService } from './intent.service';
import { RegistrationFlowService } from '../registration/registration-flow.service';

@Injectable()
export class ChatbotService {
  constructor(
    private readonly intentService: IntentService,
    private readonly userSessionService: UserSessionService,
    private readonly registrationService: RegistrationFlowService,
    private readonly replyTemplateService: ReplyTemplateService,
  ) {}

  async handleTextMessage(userId: string, text: string): Promise<string> {
    const input = text.trim();
    const status = this.intentService.detect(input);

    if (status === 'CANCEL') {
      this.userSessionService.clear(userId);
      return this.replyTemplateService.cancelled();
    }

    const session = this.userSessionService.get(userId);

    if (session.flow === 'REGISTER' && session.status === 'ACTIVE') {
      return this.registrationService.handle(userId, input, session);
    }

    if (status === 'REGISTER') {
      return this.registrationService.start(userId);
    }

    return this.replyTemplateService.defaultMessage();
  }

  // handleTextMessage(userId: string, text: string): string {
  //   const input = text.trim();
  //   const status = this.intentService.detect(input);

  //   if (status === 'CANCEL') {
  //     this.userSessionService.clear(userId);
  //     return this.replyTemplateService.cancelled();
  //   }

  //   const session = this.userSessionService.get(userId);
  //   const isRegisterSession =
  //     session.flow === 'REGISTER' && session.status === 'ACTIVE';

  //   if (isRegisterSession && session.step === 'CONFIRM_REGISTER_INTENT') {
  //     if (!this.isYes(input)) {
  //       return 'หากต้องการสมัครสมาชิก กรุณาพิมพ์ "ใช่" หรือพิมพ์ "ยกเลิก"';
  //     }

  //     const data = session.data as RegisterSessionData;

  //     if (this.isCompleteRegisterData(data)) {
  //       this.userSessionService.set(userId, {
  //         ...session,
  //         step: 'WAITING_REGISTER_CONFIRM',
  //         data,
  //       });

  //       return this.replyTemplateService.confirmRegister(data);
  //     }

  //     this.userSessionService.set(userId, {
  //       ...session,
  //       step: 'WAITING_REGISTER_FORM',
  //       data,
  //     });

  //     return this.replyTemplateService.registerForm();
  //   }

  //   if (isRegisterSession && session.step === 'WAITING_REGISTER_FORM') {
  //     const data = session.data as RegisterSessionData;
  //     const parsedData = this.parseRegisterText(input);
  //     const mergedData: RegisterSessionData = {
  //       ...data,
  //       ...parsedData,
  //     };
  //     const missingFields = this.getMissingRegisterFields(mergedData);

  //     this.userSessionService.set(userId, {
  //       ...session,
  //       step: 'WAITING_REGISTER_FORM',
  //       data: mergedData,
  //     });

  //     if (missingFields.length > 0) {
  //       return this.replyTemplateService.missingRegisterFields(missingFields);
  //     }

  //     if (!/^0\d{9}$/.test(mergedData.phoneNumber ?? '')) {
  //       return this.replyTemplateService.invalidPhoneNumber();
  //     }

  //     if (!/^\d{6,20}$/.test(mergedData.bankAccount ?? '')) {
  //       return this.replyTemplateService.invalidBankAccount();
  //     }

  //     if (this.isCompleteRegisterData(mergedData)) {
  //       this.userSessionService.set(userId, {
  //         ...session,
  //         step: 'WAITING_REGISTER_CONFIRM',
  //         data: mergedData,
  //       });

  //       return this.replyTemplateService.confirmRegister(mergedData);
  //     }
  //   }

  //   if (isRegisterSession && session.step === 'WAITING_REGISTER_CONFIRM') {
  //     if (input !== 'ยืนยัน') {
  //       return 'กรุณาพิมพ์ "ยืนยัน" เพื่อสมัครสมาชิก หรือ "ยกเลิก" เพื่อยกเลิก';
  //     }

  //     const reply = this.replyTemplateService.registerSuccess({
  //       username: 'demo-user',
  //       password: 'demo-pass',
  //       urlWeb: 'https://your-web.com/login',
  //     });

  //     this.userSessionService.clear(userId);
  //     return reply;
  //   }

  //   if (status === 'REGISTER' && !isRegisterSession) {
  //     this.userSessionService.set(userId, {
  //       userId,
  //       flow: 'REGISTER',
  //       step: 'CONFIRM_REGISTER_INTENT',
  //       status: 'ACTIVE',
  //       data: {},
  //     });

  //     return this.replyTemplateService.askRegisterIntent();
  //   }

  //   return this.replyTemplateService.defaultMessage();
  // }

  // private isYes(input: string): boolean {
  //   return ['ใช่', 'yes', 'ตกลง', 'ยืนยัน'].includes(
  //     input.trim().toLowerCase(),
  //   );
  // }

  // private parseRegisterText(text: string): RegisterSessionData {
  //   const data: RegisterSessionData = {};

  //   for (const line of text.split(/\r?\n/)) {
  //     const match = line.match(/^([^:：]+)[:：](.*)$/);

  //     if (!match) {
  //       continue;
  //     }

  //     const key = this.normalizeRegisterKey(match[1]);
  //     const field = REGISTER_FIELD_ALIASES[key];
  //     const value = match[2].trim();

  //     if (!field || value.length === 0) {
  //       continue;
  //     }

  //     data[field] = value;
  //   }

  //   return data;
  // }

  // private getMissingRegisterFields(data: RegisterSessionData): string[] {
  //   return REGISTER_REQUIRED_FIELDS.filter(({ key }) => {
  //     return !data[key]?.trim();
  //   }).map(({ label }) => label);
  // }

  // private isCompleteRegisterData(
  //   data: RegisterSessionData,
  // ): data is CompleteRegisterSessionData {
  //   return this.getMissingRegisterFields(data).length === 0;
  // }

  // private normalizeRegisterKey(key: string): string {
  //   return key
  //     .trim()
  //     .toLowerCase()
  //     .replace(/[\s_-]/g, '');
  // }
}
