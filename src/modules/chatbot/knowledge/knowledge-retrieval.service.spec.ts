import { KnowledgeItem } from '../types/chat.types';
import { AnswerPatternService } from './answer-pattern.service';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import { SemanticSearchService } from './semantic-search.service';

const keywordItem = (score: number, id = 'kw'): KnowledgeItem => ({
  source: 'ANSWER_PATTERN',
  id,
  title: `keyword-${id}`,
  content: 'c',
  answer: 'a',
  score,
});

const semanticItem = (score: number, id = 'sem'): KnowledgeItem => ({
  source: 'SEMANTIC_CHUNK',
  id,
  title: `semantic-${id}`,
  content: 'c',
  answer: 'a',
  score,
});

function build() {
  const answerPatternService = {
    findMatches: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<AnswerPatternService>;
  const semanticSearchService = {
    search: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<SemanticSearchService>;

  return {
    service: new KnowledgeRetrievalService(
      answerPatternService,
      semanticSearchService,
    ),
    answerPatternService,
    semanticSearchService,
  };
}

describe('KnowledgeRetrievalService', () => {
  it('short-circuits the embedding call on a strong keyword hit', async () => {
    const { service, answerPatternService, semanticSearchService } = build();
    answerPatternService.findMatches.mockResolvedValue([keywordItem(4)]);

    const items = await service.retrieve('ราคา');

    expect(semanticSearchService.search).not.toHaveBeenCalled();
    expect(items).toHaveLength(1);
  });

  it('runs semantic search when the top keyword score is below 3', async () => {
    const { service, answerPatternService, semanticSearchService } = build();
    answerPatternService.findMatches.mockResolvedValue([keywordItem(2.5)]);
    semanticSearchService.search.mockResolvedValue([semanticItem(0.82)]);

    await service.retrieve('ราคา');

    expect(semanticSearchService.search).toHaveBeenCalledWith('ราคา');
  });

  it('runs semantic search when there is no keyword hit at all', async () => {
    const { service, semanticSearchService } = build();
    semanticSearchService.search.mockResolvedValue([semanticItem(0.82)]);

    const items = await service.retrieve('อยากทราบเรื่องระบบ');

    expect(items).toEqual([semanticItem(0.82)]);
  });

  it('degrades to keyword results when semantic search throws', async () => {
    const { service, answerPatternService, semanticSearchService } = build();
    answerPatternService.findMatches.mockResolvedValue([keywordItem(2.5)]);
    semanticSearchService.search.mockRejectedValue(new Error('gemini down'));

    await expect(service.retrieve('ราคา')).resolves.toEqual([keywordItem(2.5)]);
  });

  it('caps the merged result at 5 items', async () => {
    const { service, answerPatternService, semanticSearchService } = build();
    answerPatternService.findMatches.mockResolvedValue([
      keywordItem(2.5, 'k1'),
      keywordItem(2.4, 'k2'),
      keywordItem(2.3, 'k3'),
    ]);
    semanticSearchService.search.mockResolvedValue([
      semanticItem(0.9, 's1'),
      semanticItem(0.88, 's2'),
      semanticItem(0.86, 's3'),
    ]);

    await expect(service.retrieve('ราคา')).resolves.toHaveLength(5);
  });

  /**
   * DEFECT: the two retrievers emit incompatible score scales. Keyword scores
   * are unbounded weights (2..6.5); semantic scores are cosine similarity
   * (0..1). Sorting the concatenation by raw score therefore ranks a perfect
   * 0.95 semantic match *below* the weakest keyword match that survived the
   * MIN_MATCH_SCORE=2 cut. Fusion needs rank-based blending (e.g. RRF) or
   * per-source normalisation before the sort.
   */
  it('DEFECT: a near-perfect semantic hit always loses to the weakest keyword hit', async () => {
    const { service, answerPatternService, semanticSearchService } = build();
    answerPatternService.findMatches.mockResolvedValue([
      keywordItem(2.0, 'weak-keyword'),
    ]);
    semanticSearchService.search.mockResolvedValue([
      semanticItem(0.95, 'perfect-semantic'),
    ]);

    const items = await service.retrieve('ราคา');

    expect(items[0].id).toBe('weak-keyword');
    expect(items[1].id).toBe('perfect-semantic');
  });

  /**
   * DEFECT: semantic items can never reach the top slot, so no matter how
   * many are returned they are effectively decoration on the prompt.
   */
  it('DEFECT: semantic results are never ranked first when any keyword hit exists', async () => {
    const { service, answerPatternService, semanticSearchService } = build();
    answerPatternService.findMatches.mockResolvedValue([keywordItem(2.0)]);
    semanticSearchService.search.mockResolvedValue([
      semanticItem(0.99, 's1'),
      semanticItem(0.98, 's2'),
    ]);

    const items = await service.retrieve('ราคา');

    expect(items[0].source).toBe('ANSWER_PATTERN');
  });

  /**
   * DEFECT: retrieve() takes no userId, so the embedding call it makes is
   * charged only against the global budget, bypassing per-user limits.
   */
  it('DEFECT: no userId is forwarded to the embedding budget', async () => {
    const { service, semanticSearchService } = build();

    await service.retrieve('ราคา');

    expect(semanticSearchService.search).toHaveBeenCalledWith('ราคา');
    expect(semanticSearchService.search.mock.calls[0]).toHaveLength(1);
  });
});
