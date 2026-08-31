import { Buffer } from 'node:buffer';
import { DEFAULT_AI_MAX_OUTPUT_TOKENS } from './ai-provider.constants';
import { AiGenerateRequest, AiTokenUsage } from '../types/ai-provider.types';

const MESSAGE_ENVELOPE_TOKEN_RESERVE = 256;

/**
 * Upper bound for one image, in tokens.
 *
 * Vision billing is a function of pixel dimensions, not file size: every
 * provider downscales before tokenizing, so a large photo and a small one
 * settle at a similar cost (Anthropic caps around 1.6k tokens per image,
 * OpenAI high-detail around 1.1k, Gemini 258 per 768px tile). Reserving the
 * decoded byte count instead would hold millions of credits' worth of tokens
 * for a single photo and bounce it as insufficient credit.
 */
const IMAGE_TOKEN_RESERVE = 4_000;

/** Provider counters are optional and occasionally absent — never NaN a bill. */
export function toTokenCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

/**
 * Builds normalized usage from raw provider counters.
 *
 * `promptTokens` may or may not already include cached reads; pass
 * `cachedInPrompt: true` for providers that bundle them (Gemini, OpenAI) so
 * the cached bucket is subtracted instead of billed twice.
 */
export function normalizeTokenUsage(input: {
  promptTokens: unknown;
  cachedInputTokens?: unknown;
  cacheWriteTokens?: unknown;
  outputTokens: unknown;
  cachedInPrompt: boolean;
  cacheWriteInPrompt?: boolean;
}): AiTokenUsage {
  const promptTokens = toTokenCount(input.promptTokens);
  const cachedInputTokens = toTokenCount(input.cachedInputTokens);
  const cacheWriteTokens = toTokenCount(input.cacheWriteTokens);
  const bucketedPromptTokens =
    cachedInputTokens + (input.cacheWriteInPrompt ? cacheWriteTokens : 0);

  return {
    inputTokens: input.cachedInPrompt
      ? Math.max(0, promptTokens - bucketedPromptTokens)
      : promptTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens: toTokenCount(input.outputTokens),
  };
}

export function estimateMaxTokenUsage(
  request: AiGenerateRequest,
): AiTokenUsage {
  const textBytes =
    Buffer.byteLength(request.systemInstruction ?? '', 'utf8') +
    request.messages.reduce(
      (total, message) => total + Buffer.byteLength(message.text, 'utf8'),
      0,
    );
  const envelopeTokens =
    (request.messages.length + (request.systemInstruction ? 1 : 0)) *
    MESSAGE_ENVELOPE_TOKEN_RESERVE;
  const imageTokens = request.messages.reduce(
    (total, message) =>
      total + (message.images?.length ?? 0) * IMAGE_TOKEN_RESERVE,
    0,
  );

  return {
    inputTokens: textBytes + envelopeTokens + imageTokens,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: Math.max(
      0,
      Math.ceil(request.maxOutputTokens ?? DEFAULT_AI_MAX_OUTPUT_TOKENS),
    ),
  };
}
