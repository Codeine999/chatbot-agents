import { Injectable } from '@nestjs/common';
import { IntentResult } from '../shared/types/chat.types';
import { DETECT_GREET } from './utils/detect-greet';
import { isCancelKeyword } from './utils/cancel-keyword';

@Injectable()
export class RuleIntentService {
  detect(text: string): IntentResult {
    const input = text.trim().toLowerCase();

    if (!input) {
      return {
        intent: 'UNKNOWN',
        confidence: 0.4,
        source: 'RULE',
        reason: 'empty input',
      };
    }

    if (DETECT_GREET.test(input.replace(/\s+/gu, ''))) {
      return {
        intent: 'GREET',
        confidence: 0.95,
        source: 'RULE',
        reason: 'just GREET',
      };
    }

    if (isCancelKeyword(input)) {
      return {
        intent: 'CANCEL',
        confidence: 1,
        source: 'RULE',
        reason: 'cancel keyword',
      };
    }

    if (['สมัคร', 'สมัครสมาชิก', 'register'].includes(input)) {
      return {
        intent: 'REGISTER',
        confidence: 0.95,
        source: 'RULE',
        reason: 'register keyword',
      };
    }

    if (
      ['สมัครยังไง', 'วิธีสมัคร', 'เปิดยูสยังไง'].some((k) => input.includes(k))
    ) {
      return {
        intent: 'REGISTER_HOW_TO',
        confidence: 0.9,
        source: 'RULE',
        reason: 'register how-to keyword',
      };
    }

    if (
      ['ติดต่อแอดมิน', 'คุยกับเจ้าหน้าที่', 'แจ้งปัญหา'].some((k) =>
        input.includes(k),
      )
    ) {
      return {
        intent: 'CONTACT_ADMIN',
        confidence: 0.95,
        source: 'RULE',
        reason: 'contact admin keyword',
      };
    }

    return {
      intent: 'UNKNOWN',
      confidence: 0.4,
      source: 'RULE',
      reason: 'no rule matched',
    };
  }
}
