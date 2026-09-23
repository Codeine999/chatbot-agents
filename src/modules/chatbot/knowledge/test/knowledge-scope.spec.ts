import { inKnowledgeScope, knowledgeScope } from '../knowledge-scope';
import { configStub } from './knowledge.fixtures';

describe('knowledgeScope', () => {
  it('ไม่ตั้ง env = legacy scope (tenant null, ภาษา th)', () => {
    expect(knowledgeScope(configStub())).toEqual({
      tenantId: null,
      language: 'th',
    });
  });

  it('ลดรูป tenant id เป็นตัวพิมพ์เล็กเสมอ เทียบกับค่าใน DB ได้ตรง', () => {
    const tenantId = '3F7834D5-AAE0-486E-8FF7-69B3BE0A931F';

    expect(
      knowledgeScope(configStub({ KNOWLEDGE_TENANT_ID: tenantId })),
    ).toEqual({ tenantId: tenantId.toLowerCase(), language: 'th' });
  });

  it('ค่าว่างถือเป็น legacy scope ไม่ใช่ tenant ชื่อ ""', () => {
    expect(
      knowledgeScope(configStub({ KNOWLEDGE_TENANT_ID: '' })).tenantId,
    ).toBeNull();
  });

  it('tenant id ที่ไม่ใช่ uuid ต้องพังตั้งแต่ตอน boot ไม่ใช่ปล่อยให้ query หลุด scope', () => {
    expect(() =>
      knowledgeScope(configStub({ KNOWLEDGE_TENANT_ID: 'tenant-a' })),
    ).toThrow();
  });

  it('ภาษาว่างหรือยาวเกิน 10 ตัวก็ต้องพังตั้งแต่ boot', () => {
    expect(() =>
      knowledgeScope(configStub({ KNOWLEDGE_LANGUAGE: '' })),
    ).toThrow();
    expect(() =>
      knowledgeScope(configStub({ KNOWLEDGE_LANGUAGE: 'thai-language' })),
    ).toThrow();
  });

  it('ตั้งภาษาอื่นได้ตามที่ deployment กำหนด', () => {
    expect(
      knowledgeScope(configStub({ KNOWLEDGE_LANGUAGE: 'en' })).language,
    ).toBe('en');
  });
});

describe('inKnowledgeScope', () => {
  const scope = { tenantId: null, language: 'th' } as const;
  const row = { active: true, tenantId: null, language: 'th' };

  it('ผ่านเมื่อ active และ tenant/ภาษา ตรงกับ scope', () => {
    expect(inKnowledgeScope(row, scope)).toBe(true);
  });

  it('ตัดแถวที่ปิดใช้งาน', () => {
    expect(inKnowledgeScope({ ...row, active: false }, scope)).toBe(false);
  });

  it('ตัดแถวของ tenant อื่น — legacy (null) ไม่ใช่ของทุก tenant', () => {
    expect(inKnowledgeScope({ ...row, tenantId: 'other' }, scope)).toBe(false);
    expect(
      inKnowledgeScope(row, { tenantId: 'tenant-a', language: 'th' }),
    ).toBe(false);
  });

  it('ตัดแถวคนละภาษา', () => {
    expect(inKnowledgeScope({ ...row, language: 'en' }, scope)).toBe(false);
  });
});
