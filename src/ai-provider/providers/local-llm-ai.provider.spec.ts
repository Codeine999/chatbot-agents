import {
  BadGatewayException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  DEFAULT_LOCAL_LLM_REQUEST_TIMEOUT_MS,
  LocalLlmProvider,
} from './local-llm-ai.provider';
import { RetryableAiProviderException } from '../errors/ai-provider-error';

jest.mock('openai', () => {
  const actual = jest.requireActual<typeof import('openai')>('openai');
  return {
    __esModule: true,
    default: Object.assign(jest.fn(), actual.default),
  };
});

describe('LocalLlmProvider', () => {
  const create = jest.fn<Promise<unknown>, [Record<string, unknown>]>();
  const schema = { type: 'object', properties: {} };
  const baseEnv = { LOCAL_LLM_BASE_URL: 'http://llm.internal:11434/v1/' };
  const build = (env: Record<string, string> = baseEnv) =>
    new LocalLlmProvider(new ConfigService(env));

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
      chat: { completions: { create } },
    }));
    create.mockResolvedValue({
      id: 'chatcmpl-1',
      model: 'qwen3:8b-alias',
      choices: [{ message: { content: ' {"decision":"ANSWER"} ' } }],
      usage: { prompt_tokens: 120, completion_tokens: 40 },
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('is configured only when a base URL is set', () => {
    expect(build().isConfigured()).toBe(true);
    expect(build({}).isConfigured()).toBe(false);
    expect(build({ LOCAL_LLM_BASE_URL: '   ' }).isConfigured()).toBe(false);
  });

  it('refuses to generate without a base URL', async () => {
    await expect(
      build({}).generate({
        model: 'qwen3:8b',
        messages: [{ role: 'user', text: 'hi' }],
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(create).not.toHaveBeenCalled();
  });

  it('calls the OpenAI-compatible endpoint and bills the configured model', async () => {
    const response = await build().generate({
      model: 'qwen3:8b',
      systemInstruction: 'system',
      messages: [{ role: 'user', text: 'สวัสดี' }],
      temperature: 0.2,
      maxOutputTokens: 600,
      reasoningEffort: 'high',
      responseJsonSchema: schema,
    });

    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: 'local-llm-no-key',
      baseURL: 'http://llm.internal:11434/v1',
      timeout: DEFAULT_LOCAL_LLM_REQUEST_TIMEOUT_MS,
      maxRetries: 0,
    });
    const body = create.mock.calls[0][0];
    expect(body).toMatchObject({
      model: 'qwen3:8b',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'สวัสดี' },
      ],
      temperature: 0.2,
      max_tokens: 600,
      stream: false,
      response_format: {
        type: 'json_schema',
        json_schema: { strict: true, schema },
      },
    });
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('provider');
    expect(response).toEqual({
      text: '{"decision":"ANSWER"}',
      provider: 'LOCAL',
      model: 'qwen3:8b',
      usage: {
        inputTokens: 120,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 40,
      },
      providerRequestId: 'chatcmpl-1',
    });
  });

  it('uses the configured key and timeout, and can skip structured output', async () => {
    await build({
      ...baseEnv,
      LOCAL_LLM_API_KEY: 'secret',
      LOCAL_LLM_REQUEST_TIMEOUT_MS: '45000',
      LOCAL_LLM_STRUCTURED_OUTPUT: 'false',
    }).generate({
      model: 'llama',
      messages: [{ role: 'user', text: 'q' }],
      responseJsonSchema: schema,
    });

    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'secret', timeout: 45000 }),
    );
    const body = create.mock.calls[0][0];
    expect(body).not.toHaveProperty('response_format');
    expect(body).not.toHaveProperty('temperature');
  });

  it('sends images as data-URL parts', async () => {
    await build().generate({
      model: 'llava',
      messages: [
        {
          role: 'user',
          text: 'what is this',
          images: [{ mediaType: 'image/png', data: 'AAAA' }],
        },
      ],
    });

    expect(create.mock.calls[0][0]).toMatchObject({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,AAAA' },
            },
          ],
        },
      ],
    });
  });

  it('marks connection failures retryable without logging the endpoint', async () => {
    create.mockRejectedValue(
      new OpenAI.APIConnectionError({ message: 'connect ECONNREFUSED' }),
    );

    await expect(
      build().generate({ model: 'm', messages: [{ role: 'user', text: 'q' }] }),
    ).rejects.toBeInstanceOf(RetryableAiProviderException);

    const logged = (Logger.prototype.error as jest.Mock).mock.calls
      .flat()
      .join(' ');
    expect(logged).not.toContain('llm.internal');
  });

  it('treats a rejected request as a non-retryable gateway error', async () => {
    create.mockRejectedValue(
      OpenAI.APIError.generate(
        400,
        { error: { message: 'model "m" not found' } },
        'bad request',
        new Headers(),
      ),
    );

    const failure = build().generate({
      model: 'm',
      messages: [{ role: 'user', text: 'q' }],
    });
    await expect(failure).rejects.toBeInstanceOf(BadGatewayException);
    await expect(failure).rejects.not.toBeInstanceOf(
      RetryableAiProviderException,
    );
  });
});
