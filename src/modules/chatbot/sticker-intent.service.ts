import { Injectable } from '@nestjs/common';

export type StickerIntentResult =
  | Readonly<{ intent: 'GREETING' }>
  | Readonly<{ intent: 'THANKS' }>
  | Readonly<{ intent: 'TEXT'; text: string }>
  | Readonly<{ intent: 'UNKNOWN' }>;

const GREETING_SIGNALS = [
  'hello',
  'hi',
  'hey',
  'greeting',
  'greetings',
  'good morning',
  'good afternoon',
  'good evening',
  'สวัสดี',
  'หวัดดี',
] as const;

const THANKS_SIGNALS = [
  'thank',
  'thanks',
  'thank you',
  'thankyou',
  'thx',
  'ขอบคุณ',
  'ขอบใจ',
] as const;

@Injectable()
export class StickerIntentService {
  resolve(input: {
    text?: string;
    keywords?: readonly string[];
  }): StickerIntentResult {
    const text = input.text?.trim();
    const signals = [text, ...(input.keywords ?? [])]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => this.normalize(value));

    if (this.matches(signals, THANKS_SIGNALS)) {
      return { intent: 'THANKS' };
    }

    if (this.matches(signals, GREETING_SIGNALS)) {
      return { intent: 'GREETING' };
    }

    // Message Sticker text is genuine user input. If it is not a social
    // shortcut above, send it through the normal text routing pipeline.
    if (text) {
      return { intent: 'TEXT', text };
    }

    return { intent: 'UNKNOWN' };
  }

  private matches(
    signals: readonly string[],
    expected: readonly string[],
  ): boolean {
    return signals.some((signal) =>
      expected.some((candidate) => {
        const normalizedCandidate = this.normalize(candidate);

        if (signal === normalizedCandidate) return true;

        // Space padding gives English phrases token boundaries, while Thai
        // phrases still use substring matching because words are unspaced.
        if (/^[a-z0-9 ]+$/u.test(normalizedCandidate)) {
          return ` ${signal} `.includes(` ${normalizedCandidate} `);
        }

        return signal.includes(normalizedCandidate);
      }),
    );
  }

  private normalize(value: string): string {
    return value
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
