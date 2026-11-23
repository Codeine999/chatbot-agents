import {
  CreateAdminAiSettingDto,
  UpdateAdminAiSettingDto,
} from './admin-ai-setting.dto';

describe('AdminAiSetting DTOs', () => {
  it('applies safe structured defaults on create', () => {
    expect(CreateAdminAiSettingDto.schema.parse({})).toEqual({
      skills: [],
      responseStyle: {
        targetLength: 'adaptive',
        emojiLevel: 'light',
        politeParticle: 'ค่ะ',
      },
      promptVersion: 1,
      active: true,
    });
  });

  it('accepts valid skills and responseStyle', () => {
    expect(
      CreateAdminAiSettingDto.schema.parse({
        skills: [{ name: 'sales', prompt: 'ตอบอย่างเป็นธรรมชาติ' }],
        responseStyle: { targetLength: 'short', emojiLevel: 'none' },
      }),
    ).toMatchObject({
      skills: [{ name: 'sales', prompt: 'ตอบอย่างเป็นธรรมชาติ' }],
      responseStyle: { targetLength: 'short', emojiLevel: 'none' },
    });
  });

  it('accepts a polite particle and defaults it when only the old keys are sent', () => {
    expect(
      CreateAdminAiSettingDto.schema.parse({
        responseStyle: {
          targetLength: 'short',
          emojiLevel: 'none',
          politeParticle: 'ครับ',
        },
      }).responseStyle.politeParticle,
    ).toBe('ครับ');
    expect(
      CreateAdminAiSettingDto.schema.parse({
        responseStyle: { targetLength: 'short', emojiLevel: 'none' },
      }).responseStyle.politeParticle,
    ).toBe('ค่ะ');
  });

  it('rejects malformed skills, unsupported styles and mass-assignment fields', () => {
    expect(() =>
      CreateAdminAiSettingDto.schema.parse({ skills: [{ name: 'sales' }] }),
    ).toThrow();
    expect(() =>
      CreateAdminAiSettingDto.schema.parse({
        responseStyle: { targetLength: 'long', emojiLevel: 'many' },
      }),
    ).toThrow();
    expect(() =>
      CreateAdminAiSettingDto.schema.parse({ createdAt: new Date() }),
    ).toThrow();
  });

  it('requires at least one PATCH field', () => {
    expect(() => UpdateAdminAiSettingDto.schema.parse({})).toThrow();
  });
});
