import { Injectable } from '@nestjs/common';

export type ChatStatus =
  | 'REGISTER'
  | 'AI_CHAT'
  | 'CHECK_STATUS'
  | 'CONTACT_ADMIN'
  | 'GENERAL_QUESTION'
  | 'CANCEL'
  | 'UNKNOWN';

@Injectable()
export class IntentService {
  detect(text: string): ChatStatus {
    const normalized = text.trim().toLowerCase();

    if (
      normalized === 'ยกเลิก' ||
      normalized === 'cancel' ||
      normalized === 'ออก'
    ) {
      return 'CANCEL';
    }

    if (
      normalized.includes('สมัครสมาชิก') ||
      normalized === 'สมัคร' ||
      normalized === 'register' ||
      normalized === '1'
    ) {
      return 'REGISTER';
    }

    if (normalized === '2') {
      return 'AI_CHAT';
    }

    if (
      normalized.includes('ติดต่อแอดมิน') ||
      normalized.includes('คุยกับเจ้าหน้าที่') ||
      normalized.includes('แจ้งปัญหา')
    ) {
      return 'AI_CHAT';
    }

    if (
      normalized.includes('สอบถาม') ||
      normalized.includes('ข้อมูล') ||
      normalized.includes('คืออะไร') ||
      normalized.includes('ใช้งานยังไง')
    ) {
      return 'GENERAL_QUESTION';
    }

    if (normalized.length > 0) {
      return 'GENERAL_QUESTION';
    }

    return 'UNKNOWN';
  }
}
