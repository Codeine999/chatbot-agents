import { Buffer } from 'node:buffer';
import { DEFAULT_AI_MAX_OUTPUT_TOKENS } from './ai-provider.constants';
import { AiGenerateRequest, AiTokenUsage } from '../types/ai-provider.types';

const MESSAGE_ENVELOPE_TOKEN_RESERVE = 256;
const IMAGE_TOKEN_RESERVE_FLOOR = 16_384;

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
}): AiTokenUsage {
  const promptTokens = toTokenCount(input.promptTokens);
  const cachedInputTokens = toTokenCount(input.cachedInputTokens);

  return {
    inputTokens: input.cachedInPrompt
      ? Math.max(0, promptTokens - cachedInputTokens)
      : promptTokens,
    cachedInputTokens,
    cacheWriteTokens: toTokenCount(input.cacheWriteTokens),
    outputTokens: toTokenCount(input.outputTokens),
  };
}

/**
 * Conservative provider-neutral upper bound used only while reserving credit.
 *
 * UTF-8 bytes are an upper bound for byte-fallback text tokenizers. Message
 * envelope headroom covers provider-added role/content framing. Images use
 * their decoded byte count with a floor because image billing depends on
 * dimensions rather than text tokenization. Settlement always uses the actual
 * counters returned by the provider, never this estimate.
 */
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
      total +
      (message.images ?? []).reduce((imageTotal, image) => {
        const decodedBytes = Buffer.byteLength(image.data, 'base64');
        return imageTotal + Math.max(decodedBytes, IMAGE_TOKEN_RESERVE_FLOOR);
      }, 0),
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
