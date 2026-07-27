export const AI_PROVIDER_NAMES = ['GEMINI', 'OPENAI', 'ANTHROPIC'] as const;

// Admin provider selection is stored per AdminMember, not in a shared scope.
export const AI_PROVIDER_SCOPES = ['USER'] as const;

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

/** A provider/model choice that applies only to one admin request. */
export type AdminAiGenerateRequest = AiGenerateRequest &
  Readonly<{
    provider?: AiProviderName;
    model?: string;
  }>;

export type AiProviderGenerateRequest = AiGenerateRequest &
  Readonly<{
    model: string;
  }>;

export type AiGenerateResponse = Readonly<{
  text: string;
  provider: AiProviderName;
  model: string;
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
  enabled: boolean;
  allowedProviders: readonly AiProviderName[];
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
