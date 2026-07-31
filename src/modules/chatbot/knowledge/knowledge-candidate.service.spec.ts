import {
  AnswerPatternCacheEntry,
  AnswerPatternCacheService,
} from './answer-pattern-cache.service';
import { KnowledgeCandidateService } from './knowledge-candidate.service';

function entry(over: Partial<AnswerPatternCacheEntry> = {}): AnswerPatternCacheEntry {
  return {
    id: 'p1',
    title: 'ราคาค่าบริการ',
    category: null,
    intentKey: null,
    keywords: [],
    questionExamples: [],
    priority: 0,
    active: true,
    ...over,
  };
}

function build(entries: AnswerPatternCacheEntry[]) {
  const cache = {
    getAll: jest.fn().mockReturnValue(entries),
  } as unknown as jest.Mocked<AnswerPatternCacheService>;
  return { service: new KnowledgeCandidateService(cache), cache };
}

describe('KnowledgeCandidateService.detect', () => {
  it('returns no match for empty input', () => {
    const { service } = build([entry({ keywords: ['ราคา'] })]);

    expect(service.detect('   ')).toMatchObject({ matched: false, score: 0 });
  });

  it('returns no match when the cache is empty', () => {
    const { service } = build([]);

    expect(service.detect('ราคา')).toMatchObject({
      matched: false,
      reason: 'answer pattern cache empty',
    });
  });

  it('matches a whole-message keyword and reports the pattern id', () => {
    const { service } = build([entry({ keywords: ['ราคา'] })]);

    expect(service.detect('ราคา')).toMatchObject({
      matched: true,
      exact: true,
      score: 5,
      patternId: 'p1',
      title: 'ราคาค่าบริการ',
    });
  });

  it('requires a score of at least 3 to match', () => {
    const { service } = build([entry({ questionExamples: ['ขอ ใบเสนอราคา ได้ ไหม'] })]);

    // reordered so containment fails: token overlap 2 * 1.0 = 2, below MATCH_THRESHOLD
    expect(service.detect('ใบเสนอราคา ขอ')).toMatchObject({
      matched: false,
      score: 2,
    });
  });

  it('scales confidence with score and caps it at 0.95', () => {
    const { service } = build([
      entry({ keywords: ['ราคา'], questionExamples: ['ราคา'] }),
    ]);

    const result = service.detect('ราคา');

    expect(result.confidence).toBeLessThanOrEqual(0.95);
    expect(result.confidence).toBeGreaterThan(0.65);
  });

  it('flags exact only for whole-message equality with an example or keyword', () => {
    const { service } = build([
      entry({ questionExamples: ['ค่าบริการเท่าไร'], keywords: ['ค่าบริการ'] }),
    ]);

    expect(service.detect('ค่าบริการเท่าไร').exact).toBe(true);
    expect(service.detect('พี่ครับ ค่าบริการเท่าไร ครับ').exact).toBe(false);
  });

  it('picks the highest-scoring entry across the cache', () => {
    const { service } = build([
      entry({ id: 'weak', keywords: ['บริการ'] }),
      entry({ id: 'strong', title: 'ราคา', keywords: ['ราคา'] }),
    ]);

    expect(service.detect('ราคา').patternId).toBe('strong');
  });

  /**
   * The cached detector deliberately omits the description and the loose
   * KEYWORD_PARTIAL rung that AnswerPatternService uses, so the two can
   * disagree. This asserts the intended divergence rather than a defect.
   */
  it('does not award the loose partial rung that the DB scorer has', () => {
    const { service } = build([entry({ keywords: ['ค่าบริการรายเดือน'] })]);

    expect(service.detect('อยากทราบ รายเดือน')).toMatchObject({
      matched: false,
      score: 0,
    });
  });

  /**
   * DEFECT: same length-blind containment as the DB scorer - a 2-character
   * keyword reaches exactly MATCH_THRESHOLD, so the router hands the message
   * straight to ANSWER_KNOWLEDGE without ever consulting the classifier.
   */
  it('DEFECT: a 2-character keyword substring passes the router gate', () => {
    const { service } = build([entry({ title: 'บริการของเรา', keywords: ['ai'] })]);

    expect(service.detect('waiting room อยู่ไหนครับ')).toMatchObject({
      matched: true,
      score: 3,
    });
  });
});
