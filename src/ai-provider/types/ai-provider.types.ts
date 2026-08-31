export const AI_PROVIDER_NAMES = ['GEMINI', 'OPENAI', 'ANTHROPIC'] as const;

export const AI_PROVIDER_SCOPES = ['USER', 'ADMIN'] as const;

export type AiProviderName = (typeof AI_PROVIDER_NAMES)[number];
export type AiProviderScope = (typeof AI_PROVIDER_SCOPES)[number];

export type AiProviderMessage = Readonly<{
  role: 'user' | 'assistant';
  text: string;
  images?: readonly AiProviderImage[];
}>;

export type AiProviderImage = Readonly<{
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  /** Raw image bytes encoded as base64, without a data-URL prefix. */
  data: string;
}>;

export type AiGenerateRequest = Readonly<{
  systemInstruction?: string;
  messages: readonly AiProviderMessage[];
  temperature?: number;
  maxOutputTokens?: number;
}>;

export type AiProviderGenerateRequest = AiGenerateRequest &
  Readonly<{
    model: string;
  }>;

/**
 * Provider-neutral billable token usage.
 *
 * `inputTokens` is always the *non-cached* prompt tokens: providers that
 * report cached reads inside their prompt total (Gemini, OpenAI) have them
 * subtracted during normalization, so the four buckets never double-count.
 */
export type AiTokenUsage = Readonly<{
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}>;

export const EMPTY_AI_TOKEN_USAGE: AiTokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
};

export type AiGenerateResponse = Readonly<{
  text: string;
  provider: AiProviderName;
  model: string;
  /** Actual usage reported by the provider — the source of truth for billing. */
  usage: AiTokenUsage;
  providerRequestId?: string;
}>;

export type AiProviderRuntimeSetting = Readonly<{
  scope: AiProviderScope;
  provider: AiProviderName;
  model: string;
  updatedAt: string;
}>;

export type AiProviderCatalogItem = Readonly<{
  provider: AiProviderName;
  label: string;
  available: boolean;
  models: readonly string[];
}>;

export type AdminAiProviderRuntimeSetting = Readonly<{
  adminMemberId: string;
  role: 'dev' | 'owner' | 'admin';
  enabled: boolean;
  provider: AiProviderName;
  model: string;
  updatedAt: string;
}>;

export function isAiProviderName(value: unknown): value is AiProviderName {
  return (
    typeof value === 'string' &&
    AI_PROVIDER_NAMES.includes(value as AiProviderName)
  );
}

export function isAiProviderScope(value: unknown): value is AiProviderScope {
  return (
    typeof value === 'string' &&
    AI_PROVIDER_SCOPES.includes(value as AiProviderScope)
  );
}
