import { logSafeText, redactPii } from './text.utils';

describe('redactPii', () => {
  it('removes a Thai mobile number in either local or +66 form', () => {
    expect(redactPii('โทรหาผมที่ 081-234-5678 ครับ')).toBe(
      'โทรหาผมที่ [REDACTED_PHONE] ครับ',
    );
    expect(redactPii('ติดต่อ +66 81 234 5678')).toBe('ติดต่อ [REDACTED_PHONE]');
  });

  it('removes a labelled password and bank account but keeps the label', () => {
    expect(redactPii('รหัสผ่าน: hunter2')).toBe(
      'รหัสผ่าน: [REDACTED_PASSWORD]',
    );
    expect(redactPii('เลขบัญชี 123-4-56789-0')).toBe(
      'เลขบัญชี [REDACTED_ACCOUNT]',
    );
  });

  it('leaves ordinary business text untouched', () => {
    const text = 'ห้องประชุม 4 ชั่วโมง 3,000 บาท';
    expect(redactPii(text)).toBe(text);
  });
});

describe('logSafeText', () => {
  it('redacts before truncating so a cut cannot expose a partial number', () => {
    const text = `${'ก'.repeat(150)} 081-234-5678`;
    expect(logSafeText(text)).not.toContain('081');
  });

  it('caps length by code point and marks the cut', () => {
    expect(logSafeText('ก'.repeat(200))).toBe(`${'ก'.repeat(160)}…`);
    expect(logSafeText('สั้น')).toBe('สั้น');
  });

  it('never splits a surrogate pair when truncating', () => {
    const emoji = '🙏'.repeat(20);
    expect(logSafeText(emoji, 10)).toBe(`${'🙏'.repeat(10)}…`);
  });
});
