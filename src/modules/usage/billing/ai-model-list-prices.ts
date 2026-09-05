import type { AiProviderName } from '../../../ai-provider/types/ai-provider.types';

export type AiModelListPrice = Readonly<{
  provider: AiProviderName;
  model: string;
  inputUsdPerMillTokens: number;
  /** Zero for input-only models — see `inputOnly`. */
  outputUsdPerMillTokens: number;
  /**
   * Embedding models return vectors, not tokens: they bill input only and
   * never produce a billable output token. Their output rate is therefore 0,
   * which `isBillableListPrice` accepts and a chat model's never is.
   */
  inputOnly?: boolean;
  cachedInputUsdPerMillTokens?: number;
  cacheWriteUsdPerMillTokens?: number;
  longContext?: Readonly<{
    thresholdTokens: number;
    inputMultiplier: number;
    outputMultiplier: number;
    cachedInputMultiplier?: number;
    cacheWriteMultiplier?: number;
  }>;
}>;

/** GPT-5.6 bills 2x input / 1.5x output for the whole request past 272k. */
const GPT_5_6_LONG_CONTEXT = {
  thresholdTokens: 272_000,
  inputMultiplier: 2,
  outputMultiplier: 1.5,
  cachedInputMultiplier: 2,
} as const;

/**
 * Verified against each provider's official pricing page on 2026-08-30.
 *
 * Standard (non-batch, non-priority) tier only — every adapter in this module
 * makes synchronous request/response calls.
 *
 * Sources:
 * - https://ai.google.dev/gemini-api/docs/pricing
 * - https://developers.openai.com/api/docs/pricing
 * - https://platform.claude.com/docs/en/about-claude/pricing
 *
 * Known expiry: Gemini 3.x standard rates hold through 2026-12-31 and double
 * on 2027-01-01. Re-run the pricing seed after that date.
 */
export const AI_MODEL_LIST_PRICES: readonly AiModelListPrice[] = [
  // --- Google Gemini ---------------------------------------------------
  {
    provider: 'GEMINI',
    model: 'gemini-3.7-flash',
    inputUsdPerMillTokens: 0.75,
    outputUsdPerMillTokens: 3.75,
    cachedInputUsdPerMillTokens: 0.075,
  },
  {
    provider: 'GEMINI',
    model: 'gemini-3.6-flash',
    inputUsdPerMillTokens: 0.75,
    outputUsdPerMillTokens: 3.75,
    cachedInputUsdPerMillTokens: 0.075,
  },
  {
    provider: 'GEMINI',
    model: 'gemini-3.5-flash',
    inputUsdPerMillTokens: 1.5,
    outputUsdPerMillTokens: 9,
    cachedInputUsdPerMillTokens: 0.15,
  },
  {
    provider: 'GEMINI',
    model: 'gemini-3.5-flash-lite',
    inputUsdPerMillTokens: 0.3,
    outputUsdPerMillTokens: 2.5,
    cachedInputUsdPerMillTokens: 0.03,
  },
  {
    provider: 'GEMINI',
    model: 'gemini-3.1-flash-lite',
    inputUsdPerMillTokens: 0.25,
    outputUsdPerMillTokens: 1.5,
    cachedInputUsdPerMillTokens: 0.025,
  },
  {
    provider: 'GEMINI',
    model: 'gemini-3.1-pro-preview',
    inputUsdPerMillTokens: 2,
    outputUsdPerMillTokens: 12,
    cachedInputUsdPerMillTokens: 0.2,
    longContext: {
      thresholdTokens: 200_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
      cachedInputMultiplier: 2,
    },
  },
  {
    provider: 'GEMINI',
    model: 'gemini-3-flash-preview',
    inputUsdPerMillTokens: 0.5,
    outputUsdPerMillTokens: 3,
    cachedInputUsdPerMillTokens: 0.05,
  },
  {
    provider: 'GEMINI',
    model: 'gemini-2.5-flash',
    inputUsdPerMillTokens: 0.3,
    outputUsdPerMillTokens: 2.5,
    cachedInputUsdPerMillTokens: 0.03,
  },

  // --- MaxPlus ----------------------------------------------------------
  // Model ids come from `GET https://api.maxplus-ai.cc/v1/models` (channel
  // `gpt-native-up`). Reseller rates are not published per model, so all of
  // them bill at the same tier as the configured Gemini default
  // (`gemini-3.1-flash-lite`) until MaxPlus publishes its own list price.
  {
    provider: 'MAXPLUS',
    model: 'gpt-5.6-sol',
    inputUsdPerMillTokens: 0.25,
    outputUsdPerMillTokens: 1.5,
    cachedInputUsdPerMillTokens: 0.025,
  },
  {
    provider: 'MAXPLUS',
    model: 'gpt-5.6-terra',
    inputUsdPerMillTokens: 0.25,
    outputUsdPerMillTokens: 1.5,
    cachedInputUsdPerMillTokens: 0.025,
  },
  {
    provider: 'MAXPLUS',
    model: 'gpt-5.5',
    inputUsdPerMillTokens: 0.25,
    outputUsdPerMillTokens: 1.5,
    cachedInputUsdPerMillTokens: 0.025,
  },

  // --- OpenAI -----------------------------------------------------------
  {
    provider: 'OPENAI',
    model: 'gpt-5.6-sol',
    inputUsdPerMillTokens: 4,
    outputUsdPerMillTokens: 20,
    cachedInputUsdPerMillTokens: 0.4,
    longContext: GPT_5_6_LONG_CONTEXT,
  },
  {
    provider: 'OPENAI',
    model: 'gpt-5.6-terra',
    inputUsdPerMillTokens: 2,
    outputUsdPerMillTokens: 12,
    cachedInputUsdPerMillTokens: 0.2,
    longContext: GPT_5_6_LONG_CONTEXT,
  },
  {
    provider: 'OPENAI',
    model: 'gpt-5.6-luna',
    inputUsdPerMillTokens: 0.2,
    outputUsdPerMillTokens: 1.2,
    cachedInputUsdPerMillTokens: 0.02,
    longContext: GPT_5_6_LONG_CONTEXT,
  },
  {
    provider: 'OPENAI',
    model: 'gpt-5',
    inputUsdPerMillTokens: 1.25,
    outputUsdPerMillTokens: 10,
    cachedInputUsdPerMillTokens: 0.125,
  },
  {
    provider: 'OPENAI',
    model: 'gpt-5-mini',
    inputUsdPerMillTokens: 0.25,
    outputUsdPerMillTokens: 2,
    cachedInputUsdPerMillTokens: 0.025,
  },
  {
    provider: 'OPENAI',
    model: 'gpt-5-nano',
    inputUsdPerMillTokens: 0.05,
    outputUsdPerMillTokens: 0.4,
    cachedInputUsdPerMillTokens: 0.005,
  },

  // --- Anthropic --------------------------------------------------------
  // Cache write is the 5-minute rate (1.25x input); cache read is 0.1x input.
  {
    provider: 'ANTHROPIC',
    model: 'claude-fable-5',
    inputUsdPerMillTokens: 10,
    outputUsdPerMillTokens: 50,
    cachedInputUsdPerMillTokens: 1,
    cacheWriteUsdPerMillTokens: 12.5,
  },
  {
    provider: 'ANTHROPIC',
    model: 'claude-opus-5',
    inputUsdPerMillTokens: 5,
    outputUsdPerMillTokens: 25,
    cachedInputUsdPerMillTokens: 0.5,
    cacheWriteUsdPerMillTokens: 6.25,
  },
  {
    provider: 'ANTHROPIC',
    model: 'claude-sonnet-5',
    inputUsdPerMillTokens: 2,
    outputUsdPerMillTokens: 10,
    cachedInputUsdPerMillTokens: 0.2,
    cacheWriteUsdPerMillTokens: 2.5,
  },
  {
    provider: 'ANTHROPIC',
    model: 'claude-haiku-4-5-20251001',
    inputUsdPerMillTokens: 1,
    outputUsdPerMillTokens: 5,
    cachedInputUsdPerMillTokens: 0.1,
    cacheWriteUsdPerMillTokens: 1.25,
  },

  // --- Embeddings (input-only) -----------------------------------------
  // Billed per input token with no output; `GEMINI_EMBEDDING_MODEL` selects
  // which one the knowledge base writes and searches with.
  {
    provider: 'GEMINI',
    model: 'gemini-embedding-001',
    inputUsdPerMillTokens: 0.15,
    outputUsdPerMillTokens: 0,
    inputOnly: true,
  },
  {
    provider: 'GEMINI',
    model: 'gemini-embedding-2',
    inputUsdPerMillTokens: 0.15,
    outputUsdPerMillTokens: 0,
    inputOnly: true,
  },
];

/**
 * A price is billable once it charges for the tokens the model actually
 * produces: input always, output only for models that emit any. Shared by the
 * seeder and the back-office gap report so both agree on which provider/model
 * pairs are still blocked.
 */
export function isBillableCreditRates(
  rates: {
    inputCreditPerMillTokens: { greaterThan(value: number): boolean };
    outputCreditPerMillTokens: { greaterThan(value: number): boolean };
  },
  options: { inputOnly?: boolean } = {},
): boolean {
  return (
    rates.inputCreditPerMillTokens.greaterThan(0) &&
    (options.inputOnly === true ||
      rates.outputCreditPerMillTokens.greaterThan(0))
  );
}

export function findListPrice(
  provider: AiProviderName,
  model: string,
): AiModelListPrice | undefined {
  return AI_MODEL_LIST_PRICES.find(
    (price) => price.provider === provider && price.model === model,
  );
}
