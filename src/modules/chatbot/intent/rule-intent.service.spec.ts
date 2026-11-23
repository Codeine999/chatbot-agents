import { HANDOFF_KEYWORDS, RuleIntentService } from './rule-intent.service';

describe('RuleIntentService handoff keywords', () => {
  const rules = new RuleIntentService();

  it.each(HANDOFF_KEYWORDS)('"%s" asks for a human', (keyword) => {
    const result = rules.detect(keyword);

    expect(result.intent).toBe('CONTACT_ADMIN');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it.each([
    'ขอคุยกับพนักงาน',
    'ขอคุยกับเจ้าหน้าที่หน่อยค่ะ',
    'ติดต่อพนักงานได้ที่ไหนคะ',
    'อยากคุยกับคนจริงๆ',
    'ขอคนจริงมาคุยหน่อย',
    'ขอคุยกับคนหน่อยครับ',
  ])('"%s" is a handoff request', (text) => {
    expect(rules.detect(text).intent).toBe('CONTACT_ADMIN');
  });

  it('keeps a bare admin address as a greeting', () => {
    expect(rules.detect('แอดมินคะ').intent).toBe('GREET');
  });

  it.each([
    'ขอคุยกับคนขับ',
    'ขอคุยกับคนขับรถหน่อยครับ',
    'ขอคุยกับคนขับได้ไหมคะ',
  ])('"%s" asks for the driver, not for staff', (text) => {
    expect(rules.detect(text).intent).not.toBe('CONTACT_ADMIN');
  });

  it.each([
    'ติดต่อแอดมินเรื่องคนขับรถ',
    'ขอคุยกับคนขับ และขอคุยกับพนักงานด้วย',
    'แจ้งปัญหาคนขับค่ะ',
  ])('"%s" still hands off', (text) => {
    expect(rules.detect(text).intent).toBe('CONTACT_ADMIN');
  });

  it.each(['คุยกับคนขับได้ไหม', 'แอดมิน', 'คุยกับคน', 'รอบรถ กรุงเทพ พัทยา'])(
    '"%s" is not a handoff request',
    (text) => {
      expect(rules.detect(text).intent).not.toBe('CONTACT_ADMIN');
    },
  );
});
