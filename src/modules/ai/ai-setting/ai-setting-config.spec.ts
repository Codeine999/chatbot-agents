import {
  DEFAULT_AI_RESPONSE_STYLE,
  aiResponseStyleSchema,
  parseAiResponseStyle,
} from './ai-setting-config';

describe('aiResponseStyleSchema politeParticle', () => {
  it('defaults to ค่ะ for rows saved before the field existed', () => {
    expect(
      parseAiResponseStyle({ targetLength: 'short', emojiLevel: 'none' }),
    ).toEqual({
      targetLength: 'short',
      emojiLevel: 'none',
      politeParticle: 'ค่ะ',
    });
  });

  it('accepts ครับ and rejects any other particle', () => {
    const base = { targetLength: 'short', emojiLevel: 'none' };

    expect(
      aiResponseStyleSchema.safeParse({ ...base, politeParticle: 'ครับ' })
        .success,
    ).toBe(true);
    expect(
      aiResponseStyleSchema.safeParse({ ...base, politeParticle: 'จ้ะ' })
        .success,
    ).toBe(false);
  });

  it('falls back to the default style, particle included', () => {
    expect(parseAiResponseStyle(undefined)).toEqual(DEFAULT_AI_RESPONSE_STYLE);
    expect(DEFAULT_AI_RESPONSE_STYLE.politeParticle).toBe('ค่ะ');
  });
});
