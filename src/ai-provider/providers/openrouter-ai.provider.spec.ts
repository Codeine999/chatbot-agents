import { BadGatewayException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { OpenRouterProvider } from './openrouter-ai.provider';
import { RetryableAiProviderException } from '../errors/ai-provider-error';

jest.mock('openai', () => {
  const actual = jest.requireActual<typeof import('openai')>('openai');
  return {
    __esModule: true,
    default: Object.assign(jest.fn(), actual.default),
  };
});

describe('OpenRouterProvider', () => {
  const create = jest.fn<Promise<unknown>, [Record<string, unknown>]>();
  const schema = { type: 'object', properties: {} };
  let provider: OpenRouterProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
      chat: { completions: { create } },
    }));
    provider = new OpenRouterProvider(
      new ConfigService({ OPEN_ROUTER_KEY: 'test-key' }),
    );
    create.mockResolvedValue({
      id: 'generation-1',
      choices: [{ message: { content: ' {"decision":"ANSWER"} ' } }],
      usage: {
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
        completion_tokens: 30,
      },
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it.each(['openai/gpt-6-luna', 'openai/gpt-6.1-sol', 'openai/gpt-5-mini'])(
    'keeps strict schema routing without unsupported sampling for %s',
    async (model) => {
      const response = await provider.generate({
        model,
        messages: [{ role: 'user', text: 'question' }],
        temperature: 0,
        maxOutputTokens: 700,
        responseJsonSchema: schema,
      });
      const body = create.mock.calls[0][0];
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('max_completion_tokens');
      expect(body).toMatchObject({
        max_tokens: 700,
        provider: { require_parameters: true },
        response_format: {
          type: 'json_schema',
          json_schema: { strict: true, schema },
        },
      });
      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({ maxRetries: 0 }),
      );
      expect(response).toMatchObject({
        providerRequestId: 'generation-1',
        usage: {
          inputTokens: 70,
          cachedInputTokens: 20,
          cacheWriteTokens: 10,
          outputTokens: 30,
        },
      });
    },
  );

  it('preserves temperature for other models and omits unrequested schema routing', async () => {
    await provider.generate({
      model: 'google/gemini-3.7-flash',
      messages: [{ role: 'user', text: 'question' }],
      temperature: 0,
    });
    expect(create.mock.calls[0][0]).toMatchObject({
      temperature: 0,
      max_tokens: 500,
    });
    expect(create.mock.calls[0][0]).not.toHaveProperty('provider');
  });

  it.each([
    [404, BadGatewayException],
    [429, RetryableAiProviderException],
    [503, RetryableAiProviderException],
  ])(
    'classifies status %i without retrying or relaxing schema',
    async (status, exception) => {
      create.mockRejectedValue(
        new OpenAI.APIError(
          status,
          { message: 'No endpoints found' },
          undefined,
          new Headers(),
        ),
      );
      await expect(
        provider.generate({
          model: 'openai/gpt-6-luna',
          messages: [{ role: 'user', text: 'question' }],
          responseJsonSchema: schema,
        }),
      ).rejects.toBeInstanceOf(exception);
      expect(create).toHaveBeenCalledTimes(1);
    },
  );
});
