import { ConfigService } from '@nestjs/config';
import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RetryableAiProviderException } from '../../ai-provider/errors/ai-provider-error';
import type { AiGenerateResponse } from '../../ai-provider/types/ai-provider.types';
import { AnthropicAiProvider } from '../../ai-provider/providers/anthropic-ai.provider';
import { GeminiAiProvider } from '../../ai-provider/providers/gemini-ai.provider';
import { OpenAiProvider } from '../../ai-provider/providers/openai-ai.provider';
import { AiProviderSettingsService } from './ai-provider-settings.service';
import { AiProviderService } from './ai-provider.service';

const RESPONSE: AiGenerateResponse = {
  text: 'ok',
  provider: 'ANTHROPIC',
  model: 'model-a',
  usage: {
    inputTokens: 10,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 5,
  },
};

function createService(
  generate: jest.Mock,
  config: Record<string, unknown> = {},
) {
  const anthropic = {
    name: 'ANTHROPIC',
    isConfigured: () => true,
    generate,
  } as unknown as AnthropicAiProvider;
  const stub = (name: string) =>
    ({
      name,
      isConfigured: () => false,
      generate: jest.fn(),
    }) as unknown as GeminiAiProvider;

  const configService = {
    get: (key: string) => config[key],
  } as unknown as ConfigService;

  return new AiProviderService(
    {} as AiProviderSettingsService,
    stub('GEMINI'),
    stub('OPENAI') as unknown as OpenAiProvider,
    anthropic,
    configService,
  );
}

describe('AiProviderService.generateWith', () => {
  it('retries a transient provider failure in place and returns the answer', async () => {
    const generate = jest
      .fn()
      .mockRejectedValueOnce(new RetryableAiProviderException('503'))
      .mockResolvedValueOnce(RESPONSE);
    const service = createService(generate, {
      AI_PROVIDER_RETRY_DELAY_MS: 1,
    });

    await expect(
      service.generateWith('ANTHROPIC', 'model-a', {
        messages: [{ role: 'user', text: 'hi' }],
      }),
    ).resolves.toBe(RESPONSE);

    // One billed call, two provider attempts: the wallet is held and settled
    // once no matter how many HTTP attempts it took.
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('does not retry a rejection the provider will just repeat', async () => {
    const generate = jest
      .fn()
      .mockRejectedValue(new BadGatewayException('bad request'));
    const service = createService(generate, {
      AI_PROVIDER_RETRY_DELAY_MS: 1,
    });

    await expect(
      service.generateWith('ANTHROPIC', 'model-a', {
        messages: [{ role: 'user', text: 'hi' }],
      }),
    ).rejects.toBeInstanceOf(BadGatewayException);

    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('gives up once the attempt budget is spent and surfaces the last error', async () => {
    const generate = jest
      .fn()
      .mockRejectedValue(new RetryableAiProviderException('503'));
    const service = createService(generate, {
      AI_PROVIDER_MAX_ATTEMPTS: 3,
      AI_PROVIDER_RETRY_DELAY_MS: 1,
    });

    await expect(
      service.generateWith('ANTHROPIC', 'model-a', {
        messages: [{ role: 'user', text: 'hi' }],
      }),
    ).rejects.toBeInstanceOf(RetryableAiProviderException);

    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('skips the retry when the call already ate the reply-token window', async () => {
    const generate = jest.fn().mockImplementation(() => {
      // Simulate a slow attempt by pushing the clock past the retry budget.
      jest.setSystemTime(Date.now() + 30_000);
      return Promise.reject(new RetryableAiProviderException('timeout'));
    });
    jest.useFakeTimers({ doNotFake: ['setTimeout'] });

    try {
      const service = createService(generate, {
        AI_PROVIDER_RETRY_BUDGET_MS: 20_000,
        AI_PROVIDER_RETRY_DELAY_MS: 1,
      });

      await expect(
        service.generateWith('ANTHROPIC', 'model-a', {
          messages: [{ role: 'user', text: 'hi' }],
        }),
      ).rejects.toBeInstanceOf(RetryableAiProviderException);

      expect(generate).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses a provider with no API key instead of attempting it', async () => {
    const service = createService(jest.fn());

    await expect(
      service.generateWith('GEMINI', 'model-x', {
        messages: [{ role: 'user', text: 'hi' }],
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
