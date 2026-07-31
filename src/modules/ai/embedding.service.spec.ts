import { ServiceUnavailableException } from '@nestjs/common';
import type {
  EmbeddingAdapter,
  EmbeddingResult,
} from '../../infra/embedding/embedding-adapter.interface';
import { AiBudgetService } from '../usage/rate-limit/ai-budget.service';
import { EmbeddingService } from './embedding.service';

const result: EmbeddingResult = { values: [0.1, 0.2], model: 'gemini-embedding-2' };

describe('EmbeddingService', () => {
  let adapter: jest.Mocked<EmbeddingAdapter>;
  let budget: jest.Mocked<Pick<AiBudgetService, 'tryConsume'>>;
  let service: EmbeddingService;

  beforeEach(() => {
    adapter = { embed: jest.fn().mockResolvedValue(result) };
    budget = { tryConsume: jest.fn().mockResolvedValue(true) };
    service = new EmbeddingService(adapter, budget as unknown as AiBudgetService);
  });

  it('embedQuery tags the request as RETRIEVAL_QUERY', async () => {
    await service.embedQuery('ราคาเท่าไหร่', 'U1');

    expect(adapter.embed).toHaveBeenCalledWith({
      text: 'ราคาเท่าไหร่',
      task: 'RETRIEVAL_QUERY',
    });
  });

  it('embedDocument tags the request as RETRIEVAL_DOCUMENT', async () => {
    await service.embedDocument('หัวข้อ: ราคา');

    expect(adapter.embed).toHaveBeenCalledWith({
      text: 'หัวข้อ: ราคา',
      task: 'RETRIEVAL_DOCUMENT',
    });
  });

  it('asymmetric encoding: the same text yields different tasks per entry point', async () => {
    await service.embedQuery('ราคา');
    await service.embedDocument('ราคา');

    expect(adapter.embed.mock.calls[0][0].task).toBe('RETRIEVAL_QUERY');
    expect(adapter.embed.mock.calls[1][0].task).toBe('RETRIEVAL_DOCUMENT');
  });

  it('trims the input before embedding', async () => {
    await service.embedQuery('  ราคาเท่าไหร่ \n');

    expect(adapter.embed).toHaveBeenCalledWith({
      text: 'ราคาเท่าไหร่',
      task: 'RETRIEVAL_QUERY',
    });
  });

  it.each(['', '   ', '\n\t'])(
    'rejects blank input %p without spending budget',
    async (text) => {
      await expect(service.embedQuery(text)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(budget.tryConsume).not.toHaveBeenCalled();
      expect(adapter.embed).not.toHaveBeenCalled();
    },
  );

  it('charges the per-user budget for queries', async () => {
    await service.embedQuery('ราคา', 'U1');

    expect(budget.tryConsume).toHaveBeenCalledWith('U1');
  });

  it('rejects and skips the adapter when over budget', async () => {
    budget.tryConsume.mockResolvedValue(false);

    await expect(service.embedQuery('ราคา', 'U1')).rejects.toThrow(
      /budget exceeded/,
    );
    expect(adapter.embed).not.toHaveBeenCalled();
  });

  /**
   * DEFECT: embedDocument never forwards a user id, so admin re-indexing is
   * only gated by the global per-second limit. A reindex of N patterns issues
   * N sequential calls that can starve live chat traffic's global budget.
   */
  it('DEFECT: embedDocument spends only global budget (userId is always undefined)', async () => {
    await service.embedDocument('doc');

    expect(budget.tryConsume).toHaveBeenCalledWith(undefined);
  });

  it('propagates adapter failures unchanged', async () => {
    adapter.embed.mockRejectedValue(new Error('upstream 503'));

    await expect(service.embedQuery('ราคา')).rejects.toThrow('upstream 503');
  });
});
