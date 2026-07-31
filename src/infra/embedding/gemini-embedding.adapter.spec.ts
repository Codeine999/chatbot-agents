import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EMBEDDING_DIMENSIONS } from './embedding-adapter.interface';
import { GeminiEmbeddingAdapter } from './gemini-embedding.adapter';

const mockEmbedContent = jest.fn();

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn(() => ({
    models: {
      embedContent: (...args: unknown[]) => mockEmbedContent(...args),
    },
  })),
}));

const validValues = () => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1);

function buildAdapter(env: Record<string, string | undefined>) {
  const configService = {
    get: jest.fn((key: string) => env[key]),
  } as unknown as ConfigService;
  return new GeminiEmbeddingAdapter(configService);
}

describe('GeminiEmbeddingAdapter', () => {
  beforeEach(() => mockEmbedContent.mockReset());

  it('rejects before any network call when GEMINI_API_KEY is missing', async () => {
    const adapter = buildAdapter({});

    await expect(
      adapter.embed({ text: 'ราคาเท่าไหร่', task: 'RETRIEVAL_QUERY' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(mockEmbedContent).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only api key as unconfigured', async () => {
    const adapter = buildAdapter({ GEMINI_API_KEY: '   ' });

    await expect(
      adapter.embed({ text: 'x', task: 'RETRIEVAL_QUERY' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  describe('embedding-1 family (taskType path)', () => {
    it('sends raw text plus taskType and forces the configured dimension', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: validValues() }],
      });
      const adapter = buildAdapter({
        GEMINI_API_KEY: 'key',
        GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
      });

      const result = await adapter.embed({
        text: 'ราคาเท่าไหร่',
        task: 'RETRIEVAL_QUERY',
      });

      expect(result.model).toBe('gemini-embedding-001');
      expect(result.values).toHaveLength(EMBEDDING_DIMENSIONS);
      const call = mockEmbedContent.mock.calls[0][0];
      expect(call.contents).toBe('ราคาเท่าไหร่');
      expect(call.config.taskType).toBe('RETRIEVAL_QUERY');
      expect(call.config.outputDimensionality).toBe(EMBEDDING_DIMENSIONS);
    });

    it('defaults to gemini-embedding-001 when no model is configured', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: validValues() }],
      });
      const adapter = buildAdapter({ GEMINI_API_KEY: 'key' });

      const result = await adapter.embed({ text: 'x', task: 'RETRIEVAL_DOCUMENT' });

      expect(result.model).toBe('gemini-embedding-001');
      expect(mockEmbedContent.mock.calls[0][0].config.taskType).toBe(
        'RETRIEVAL_DOCUMENT',
      );
    });
  });

  describe('embedding-2 family (prompt-instruction path)', () => {
    it('encodes RETRIEVAL_QUERY as a query prompt and drops taskType', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: validValues() }],
      });
      const adapter = buildAdapter({
        GEMINI_API_KEY: 'key',
        GEMINI_EMBEDDING_MODEL: 'gemini-embedding-2',
      });

      await adapter.embed({ text: 'ราคาเท่าไหร่', task: 'RETRIEVAL_QUERY' });

      const call = mockEmbedContent.mock.calls[0][0];
      expect(call.contents).toBe('task: search result | query: ราคาเท่าไหร่');
      expect(call.config.taskType).toBeUndefined();
    });

    it('encodes RETRIEVAL_DOCUMENT as a document prompt', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: validValues() }],
      });
      const adapter = buildAdapter({
        GEMINI_API_KEY: 'key',
        GEMINI_EMBEDDING_MODEL: 'gemini-embedding-2',
      });

      await adapter.embed({ text: 'หัวข้อ: ราคา', task: 'RETRIEVAL_DOCUMENT' });

      expect(mockEmbedContent.mock.calls[0][0].contents).toBe(
        'title: none | text: หัวข้อ: ราคา',
      );
    });

    it.each([
      ['gemini-embedding-2', true],
      ['gemini-embedding-2-preview', true],
      ['models/gemini-embedding-2', true],
      ['embedding-2', true],
      ['gemini-embedding-001', false],
      ['gemini-embedding-21', false],
    ])('model %s -> prompt-instruction path = %s', async (model, usesPrompt) => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: validValues() }],
      });
      const adapter = buildAdapter({
        GEMINI_API_KEY: 'key',
        GEMINI_EMBEDDING_MODEL: model,
      });

      await adapter.embed({ text: 'q', task: 'RETRIEVAL_QUERY' });

      const call = mockEmbedContent.mock.calls[0][0];
      expect(call.contents === 'task: search result | query: q').toBe(usesPrompt);
    });
  });

  describe('response validation', () => {
    it.each([
      ['missing embeddings', {}],
      ['empty embeddings array', { embeddings: [] }],
      ['missing values', { embeddings: [{}] }],
      ['wrong dimension', { embeddings: [{ values: [1, 2, 3] }] }],
    ])('rejects %s as BadGateway', async (_label, response) => {
      mockEmbedContent.mockResolvedValue(response);
      const adapter = buildAdapter({ GEMINI_API_KEY: 'key' });

      await expect(
        adapter.embed({ text: 'x', task: 'RETRIEVAL_QUERY' }),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });

    it('rejects a vector containing NaN', async () => {
      const values = validValues();
      values[42] = Number.NaN;
      mockEmbedContent.mockResolvedValue({ embeddings: [{ values }] });
      const adapter = buildAdapter({ GEMINI_API_KEY: 'key' });

      await expect(
        adapter.embed({ text: 'x', task: 'RETRIEVAL_QUERY' }),
      ).rejects.toThrow(/Invalid embedding dimension|Gemini embedding failed/);
    });

    it('wraps transport errors as BadGateway', async () => {
      mockEmbedContent.mockRejectedValue(new Error('ETIMEDOUT'));
      const adapter = buildAdapter({ GEMINI_API_KEY: 'key' });

      await expect(
        adapter.embed({ text: 'x', task: 'RETRIEVAL_QUERY' }),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });
  });

  describe('timeout parsing', () => {
    it('uses the configured timeout when it is a plain number string', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: validValues() }],
      });
      const adapter = buildAdapter({
        GEMINI_API_KEY: 'key',
        GEMINI_EMBEDDING_REQUEST_TIMEOUT_MS: '8000',
      });

      await adapter.embed({ text: 'x', task: 'RETRIEVAL_QUERY' });

      expect(mockEmbedContent.mock.calls[0][0].config.httpOptions.timeout).toBe(
        8000,
      );
    });

    it('falls back to 8000 when the variable is unset', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: validValues() }],
      });
      const adapter = buildAdapter({ GEMINI_API_KEY: 'key' });

      await adapter.embed({ text: 'x', task: 'RETRIEVAL_QUERY' });

      expect(mockEmbedContent.mock.calls[0][0].config.httpOptions.timeout).toBe(
        8000,
      );
    });

    /**
     * DEFECT: the repo .env sets GEMINI_EMBEDDING_REQUEST_TIMEOUT_MS=8_000.
     * Numeric separators are a JS *literal* feature; Number('8_000') is NaN,
     * so the adapter ships NaN as the HTTP timeout instead of 8 seconds.
     */
    it('DEFECT: an underscore-separated value silently becomes NaN', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: validValues() }],
      });
      const adapter = buildAdapter({
        GEMINI_API_KEY: 'key',
        GEMINI_EMBEDDING_REQUEST_TIMEOUT_MS: '8_000',
      });

      await adapter.embed({ text: 'x', task: 'RETRIEVAL_QUERY' });

      expect(
        Number.isNaN(
          mockEmbedContent.mock.calls[0][0].config.httpOptions.timeout,
        ),
      ).toBe(true);
    });

    /** DEFECT: an empty value parses to 0, i.e. "no timeout" for the SDK. */
    it('DEFECT: an empty value becomes 0 rather than the 8000 default', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: validValues() }],
      });
      const adapter = buildAdapter({
        GEMINI_API_KEY: 'key',
        GEMINI_EMBEDDING_REQUEST_TIMEOUT_MS: '',
      });

      await adapter.embed({ text: 'x', task: 'RETRIEVAL_QUERY' });

      expect(mockEmbedContent.mock.calls[0][0].config.httpOptions.timeout).toBe(
        0,
      );
    });
  });

  /** DEFECT: EMBEDDING_DIMENSIONS is a hardcoded constant; .env is ignored. */
  it('DEFECT: ignores the EMBEDDING_DIMENSIONS environment variable', async () => {
    mockEmbedContent.mockResolvedValue({
      embeddings: [{ values: validValues() }],
    });
    const adapter = buildAdapter({
      GEMINI_API_KEY: 'key',
      EMBEDDING_DIMENSIONS: '768',
    });

    await adapter.embed({ text: 'x', task: 'RETRIEVAL_QUERY' });

    expect(mockEmbedContent.mock.calls[0][0].config.outputDimensionality).toBe(
      EMBEDDING_DIMENSIONS,
    );
  });
});
