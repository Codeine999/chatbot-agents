import type { AiProviderName } from '../types/ai-provider.types';

export const AI_PROVIDER_SETTING_CACHE_PREFIX = 'ai:provider-setting:v1:';
export const DEFAULT_AI_REQUEST_TIMEOUT_MS = 12_000;
export const DEFAULT_AI_MAX_OUTPUT_TOKENS = 500;

/**
 * Attempts per billed generation, retried in place rather than by re-queuing
 * the whole LINE turn: a re-queued turn would re-run the classifier and the
 * query planner (billing them again) against a reply token that expires about
 * a minute after delivery.
 */
export const DEFAULT_AI_MAX_ATTEMPTS = 2;
export const DEFAULT_AI_RETRY_DELAY_MS = 300;

/**
 * A retry is only started while the call has spent less than this. It keeps
 * the in-place retry inside the LINE reply-token window instead of trading a
 * dead token for a second attempt.
 */
export const DEFAULT_AI_RETRY_BUDGET_MS = 20_000;

export const AI_PROVIDER_LABELS = {
  GEMINI: 'Google Gemini',
  OPENAI: 'OpenAI',
  ANTHROPIC: 'Anthropic Claude',
} as const satisfies Readonly<Record<AiProviderName, string>>;

export const AI_PROVIDER_TEXT_MODELS = {
  GEMINI: [
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
    'gemini-2.5-flash',
  ],
  OPENAI: [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
  ],
  ANTHROPIC: [
    'claude-fable-5',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-haiku-4-5-20251001',
  ],
} as const satisfies Readonly<Record<AiProviderName, readonly string[]>>;
