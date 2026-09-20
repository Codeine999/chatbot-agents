import { Injectable } from '@nestjs/common';
import { IntentResult } from './types/chat.types';

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

    if (['ยกเลิก', 'cancel', 'ออก'].includes(input)) {
      return {
        intent: 'CANCEL',
        confidence: 1,
        source: 'RULE',
        reason: 'cancel keyword',
      };
    }

    // These digits are no longer how a rich menu reaches the bot: a button
    // now carries `menu=<key>` or `intent=<ChatIntent>` and is resolved before
    // any rule runs. They stay, at full confidence, for the two cases that are
    // still real — a menu published before that format is still on customers'
    // phones, and customers who learned to type the number keep doing it.
    // They can be deleted once no published menu sends plain digits.
    if (input === '1') {
      return {
        intent: 'REGISTER',
        confidence: 1,
        source: 'RULE',
        reason: 'typed menu digit 1',
      };
    }

    if (input === '3') {
      return {
        intent: 'CONTACT_ADMIN',
        confidence: 1,
        source: 'RULE',
        reason: 'typed menu digit 3',
      };
    }

    if (input === '2') {
      return {
        intent: 'GENERAL_QUESTION',
        confidence: 1,
        source: 'RULE',
        reason: 'typed menu digit 2',
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
