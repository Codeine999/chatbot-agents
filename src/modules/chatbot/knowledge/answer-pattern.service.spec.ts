import type { AnswerPattern } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnswerPatternService } from './answer-pattern.service';

function pattern(overrides: Partial<AnswerPattern> = {}): AnswerPattern {
  return {
    id: 'p1',
    tenantId: null,
    title: 'ราคาค่าบริการ',
    description: null,
    category: null,
    intentKey: null,
    keywords: [],
    questionExamples: [],
    answer: 'เริ่มต้น 1,000 บาท',
    language: 'th',
    priority: 0,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as AnswerPattern;
}

function build(patterns: AnswerPattern[]) {
  const prisma = {
    answerPattern: { findMany: jest.fn().mockResolvedValue(patterns) },
  };
  return {
    service: new AnswerPatternService(prisma as unknown as PrismaService),
    prisma,
  };
}

describe('AnswerPatternService.findMatches', () => {
  it('returns nothing for blank input and never queries the database', async () => {
    const { service, prisma } = build([]);

    await expect(service.findMatches('   ')).resolves.toEqual([]);
    expect(prisma.answerPattern.findMany).not.toHaveBeenCalled();
  });

  it('only scans active patterns, priority first, capped at 500', async () => {
    const { service, prisma } = build([]);

    await service.findMatches('ราคา');

    expect(prisma.answerPattern.findMany).toHaveBeenCalledWith({
      where: { active: true },
      take: 500,
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    });
  });

  describe('keyword scoring ladder', () => {
    it('scores a whole-message keyword equality at 5', async () => {
      const { service } = build([pattern({ keywords: ['ราคา'] })]);

      const [match] = await service.findMatches('ราคา');

      expect(match.score).toBe(5);
    });

    it('scores an exact token hit at 4', async () => {
      const { service } = build([pattern({ keywords: ['api'] })]);

      const [match] = await service.findMatches('มี api ให้ใช้ไหม');

      expect(match.score).toBe(4);
    });

    it('scores substring containment at 3 (the Thai path)', async () => {
      const { service } = build([pattern({ keywords: ['ค่าบริการ'] })]);

      const [match] = await service.findMatches('ค่าบริการเท่าไหร่ครับ');

      expect(match.score).toBe(3);
    });

    it('scores a loose partial (keyword contains a token) at 1.5', async () => {
      // 1.5 alone is below MIN_MATCH_SCORE, so a description hit (+0.5) is
      // added purely to let the row survive the filter and expose its score.
      const { service } = build([
        pattern({
          keywords: ['ค่าบริการรายเดือน'],
          description: 'ค่าบริการรายเดือนเริ่มต้นที่หนึ่งพัน',
        }),
      ]);

      const [match] = await service.findMatches('อยากทราบ รายเดือน');

      expect(match.score).toBe(1.5 + 0.5);
    });

    it('adds 0.5 per extra matched keyword, capped at 1', async () => {
      const { service } = build([
        pattern({ keywords: ['ราคา', 'แพ็กเกจ', 'ค่าบริการ', 'รายเดือน'] }),
      ]);

      const [match] = await service.findMatches(
        'ราคา แพ็กเกจ ค่าบริการ รายเดือน',
      );

      // best token-exact hit (4) + capped multi bonus (1)
      expect(match.score).toBe(5);
    });

    it('ignores needles shorter than 2 characters', async () => {
      const { service } = build([pattern({ keywords: ['x'] })]);

      await expect(service.findMatches('axb')).resolves.toEqual([]);
    });
  });

  describe('question example scoring', () => {
    it('scores an exact example match at 5', async () => {
      const { service } = build([
        pattern({ questionExamples: ['ค่าบริการเท่าไร'] }),
      ]);

      const [match] = await service.findMatches('ค่าบริการเท่าไร');

      expect(match.score).toBe(5);
    });

    it('scores bidirectional containment at 2.5', async () => {
      const { service } = build([
        pattern({ questionExamples: ['ค่าบริการเท่าไร'] }),
      ]);

      const [match] = await service.findMatches('พี่ครับ ค่าบริการเท่าไร ครับ');

      expect(match.score).toBe(2.5);
    });

    it('scores contained text at 2.5 before overlap is considered', async () => {
      const { service } = build([
        pattern({ questionExamples: ['ขอ ใบเสนอราคา ได้ ไหม'] }),
      ]);

      const [match] = await service.findMatches('ขอ ใบเสนอราคา');

      expect(match.score).toBe(2.5);
    });

    it('scores token overlap proportionally when containment fails', async () => {
      const { service } = build([
        pattern({ questionExamples: ['ขอ ใบเสนอราคา ได้ ไหม'] }),
      ]);

      // reordered, so neither string contains the other; overlap is 2/2
      const [match] = await service.findMatches('ใบเสนอราคา ขอ');

      expect(match.score).toBe(2); // 2 * 1.0 overlap
    });

    it('drops overlap below 50%', async () => {
      const { service } = build([
        pattern({ questionExamples: ['ขอ ใบเสนอราคา ได้ ไหม'] }),
      ]);

      await expect(
        service.findMatches('ขอ ทราบ เรื่อง อื่น อีก'),
      ).resolves.toEqual([]);
    });
  });

  describe('metadata signals', () => {
    it('adds 2 for an intentKey hit', async () => {
      const { service } = build([
        pattern({ intentKey: 'pricing', keywords: ['ราคา'] }),
      ]);

      const [match] = await service.findMatches('ราคา pricing');

      expect(match.score).toBe(4 + 2);
    });

    it('adds 1 for a title hit and 1 for a category hit', async () => {
      const { service } = build([
        pattern({ title: 'ราคา', category: 'pricing', keywords: ['บริการ'] }),
      ]);

      const [match] = await service.findMatches('บริการ ราคา pricing');

      expect(match.score).toBe(4 + 1 + 1);
    });

    it('adds 0.5 for a description hit', async () => {
      const { service } = build([
        pattern({ description: 'ราคาเริ่มต้นที่หนึ่งพันบาท', keywords: ['ราคา'] }),
      ]);

      const [match] = await service.findMatches('ราคา');

      expect(match.score).toBe(5 + 0.5);
    });
  });

  describe('priority', () => {
    it('adds a bonus proportional to priority, maxing at 0.5', async () => {
      const { service } = build([
        pattern({ keywords: ['ราคา'], priority: 100 }),
      ]);

      const [match] = await service.findMatches('ราคา');

      expect(match.score).toBe(5.5);
    });

    it('never turns a non-match into a match', async () => {
      const { service } = build([
        pattern({ keywords: ['ไม่เกี่ยว'], priority: 100 }),
      ]);

      await expect(service.findMatches('ราคา')).resolves.toEqual([]);
    });
  });

  it('drops matches scoring below 2', async () => {
    const { service } = build([pattern({ keywords: ['ค่าบริการรายเดือน'] })]);

    // loose partial only -> 1.5, below MIN_MATCH_SCORE
    await expect(service.findMatches('อยากทราบ รายเดือน')).resolves.toEqual([]);
  });

  it('sorts by score then priority and caps the result at 5', async () => {
    const { service } = build([
      pattern({ id: 'a', keywords: ['ราคา'], priority: 10 }),
      pattern({ id: 'b', keywords: ['ราคา'], priority: 90 }),
      pattern({ id: 'c', keywords: ['ค่าบริการ'] }),
      pattern({ id: 'd', keywords: ['ราคา'], priority: 50 }),
      pattern({ id: 'e', keywords: ['ราคา'], priority: 20 }),
      pattern({ id: 'f', keywords: ['ราคา'], priority: 30 }),
    ]);

    const matches = await service.findMatches('ราคา ค่าบริการ');

    expect(matches).toHaveLength(5);
    expect(matches[0].id).toBe('b');
    expect(matches.map((m) => m.score)).toEqual(
      [...matches.map((m) => m.score)].sort((a, b) => b - a),
    );
  });

  it('maps a match to an ANSWER_PATTERN knowledge item', async () => {
    const { service } = build([
      pattern({
        keywords: ['ราคา'],
        category: 'pricing',
        intentKey: 'pricing_key',
        description: null,
        priority: 40,
      }),
    ]);

    const [item] = await service.findMatches('ราคา');

    expect(item).toMatchObject({
      source: 'ANSWER_PATTERN',
      id: 'p1',
      title: 'ราคาค่าบริการ',
      category: 'pricing',
      content: 'ราคาค่าบริการ',
      answer: 'เริ่มต้น 1,000 บาท',
      metadata: { priority: 40, intentKey: 'pricing_key' },
    });
  });

  it('normalises punctuation and case before matching', async () => {
    const { service } = build([pattern({ keywords: ['API'] })]);

    const [match] = await service.findMatches('มี api?? ให้ใช้ไหม!!');

    expect(match.score).toBe(4);
  });

  /**
   * DEFECT: the keyword ladder is length-blind, so a 2-character keyword that
   * happens to appear inside an unrelated Thai sentence scores 3 — above the
   * MIN_MATCH_SCORE of 2. That is enough for answerKnowledge to accept the
   * pattern and skip the embedding path entirely.
   */
  it('DEFECT: a 2-character keyword substring produces a confident false match', async () => {
    const { service } = build([
      pattern({ title: 'บริการของเรา', keywords: ['ai'] }),
    ]);

    const [match] = await service.findMatches('waiting room อยู่ไหนครับ');

    expect(match.score).toBe(3);
  });
});
