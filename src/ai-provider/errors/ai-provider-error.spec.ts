import {
  isTransientProviderFailure,
  RetryableAiProviderException,
} from './ai-provider-error';

describe('AI provider retry classification', () => {
  it.each([429, 500, 503])('retries HTTP status %i', (status) => {
    expect(
      isTransientProviderFailure(
        Object.assign(new Error('provider error'), { status }),
      ),
    ).toBe(true);
  });

  it('retries network timeouts', () => {
    expect(
      isTransientProviderFailure(
        Object.assign(new Error('connect failed'), { code: 'ETIMEDOUT' }),
      ),
    ).toBe(true);
  });

  it('does not retry permanent 4xx failures', () => {
    expect(
      isTransientProviderFailure(
        Object.assign(new Error('unauthorized'), { status: 401 }),
      ),
    ).toBe(false);
  });

  it('recognizes the explicit retryable exception', () => {
    expect(isTransientProviderFailure(new RetryableAiProviderException())).toBe(
      true,
    );
  });
});
