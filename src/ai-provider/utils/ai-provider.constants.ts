export const AI_PROVIDER_SETTING_CACHE_PREFIX = 'ai:provider-setting:v1:';

export const DEFAULT_AI_PROVIDER_CACHE_TTL_SEC = 300;
export const DEFAULT_AI_REQUEST_TIMEOUT_MS = 12_000;
export const DEFAULT_AI_MAX_OUTPUT_TOKENS = 500;

export const AI_PROVIDER_LABELS = {
  GEMINI: 'Google Gemini',
  OPENAI: 'OpenAI',
  ANTHROPIC: 'Anthropic Claude',
} as const;
