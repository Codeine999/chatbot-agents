import { Injectable } from '@nestjs/common';
import { IntentResult } from '../../../shared/contracts/chat.types';
import { DETECT_GREET } from './utils/detect-greet';
import { isCancelKeyword } from './utils/cancel-keyword';

/**
 * Phrases that ask for a human. Matched as substrings of the lower-cased
 * message, so they must stay specific: never bare "แอดมิน" (a greeting, see
 * DETECT_GREET) and never bare "คุยกับคน" ("คุยกับคนขับ" is not a handoff).
 */
export const HANDOFF_KEYWORDS: readonly string[] = [
  'ติดต่อแอดมิน',
  'คุยกับแอดมิน',
  'ขอคุยกับแอดมิน',
  'ติดต่อเจ้าหน้าที่',
  'คุยกับเจ้าหน้าที่',
  'ขอเจ้าหน้าที่',
  'ติดต่อพนักงาน',
  'คุยกับพนักงาน',
  'ขอพนักงาน',
  'ขอคุยกับคน',
  'คุยกับคนจริง',
  'ขอคนจริง',
  'แจ้งปัญหา',
];

/**
 * "ขอคุยกับคนขับ" asks for the driver, not for staff, yet it contains the
 * keyword "ขอคุยกับคน". The word is dropped before matching, so the rest of a
 * message ("ติดต่อแอดมินเรื่องคนขับ") still hands off.
 */
const NOT_A_HUMAN_REQUEST = 'คนขับ';

const asksForHuman = (input: string): boolean => {
  const text = input.replaceAll(NOT_A_HUMAN_REQUEST, '');
  return HANDOFF_KEYWORDS.some((keyword) => text.includes(keyword));
};

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

    if (asksForHuman(input)) {
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
