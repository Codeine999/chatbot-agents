import { AiGenerateRequest } from '../types/ai-provider.types';
import {
  estimateMaxTokenUsage,
  normalizeTokenUsage,
  toTokenCount,
} from './token-usage.utils';

describe('toTokenCount', () => {
  it('never turns a missing or malformed counter into NaN', () => {
    expect(toTokenCount(undefined)).toBe(0);
    expect(toTokenCount(null)).toBe(0);
    expect(toTokenCount('not-a-number')).toBe(0);
    expect(toTokenCount(-5)).toBe(0);
    expect(toTokenCount('120')).toBe(120);
    expect(toTokenCount(12.6)).toBe(13);
  });
});

describe('normalizeTokenUsage', () => {
  it('subtracts cached reads bundled inside the prompt total (Gemini/OpenAI)', () => {
    const usage = normalizeTokenUsage({
      promptTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 200,
      cachedInPrompt: true,
    });

    expect(usage).toEqual({
      inputTokens: 600,
      cachedInputTokens: 400,
      cacheWriteTokens: 0,
      outputTokens: 200,
    });
  });

  it('keeps the prompt total as-is when cache reads are reported separately (Anthropic)', () => {
    const usage = normalizeTokenUsage({
      promptTokens: 1_000,
      cachedInputTokens: 400,
      cacheWriteTokens: 50,
      outputTokens: 200,
      cachedInPrompt: false,
    });

    expect(usage).toEqual({
      inputTokens: 1_000,
      cachedInputTokens: 400,
      cacheWriteTokens: 50,
      outputTokens: 200,
    });
  });

  it('clamps to zero rather than reporting negative input tokens', () => {
    const usage = normalizeTokenUsage({
      promptTokens: 100,
      cachedInputTokens: 400,
      outputTokens: 0,
      cachedInPrompt: true,
    });

    expect(usage.inputTokens).toBe(0);
  });
});

describe('estimateMaxTokenUsage', () => {
  const request = (
    override: Partial<AiGenerateRequest> = {},
  ): AiGenerateRequest => ({
    messages: [{ role: 'user', text: 'สวัสดีครับ' }],
    ...override,
  });

  it('stays above the real token count for plain text', () => {
    const estimate = estimateMaxTokenUsage(
      request({ systemInstruction: 'ตอบสุภาพ', maxOutputTokens: 300 }),
    );

    expect(estimate.inputTokens).toBeGreaterThan(0);
    expect(estimate.outputTokens).toBe(300);
    expect(estimate.cachedInputTokens).toBe(0);
    expect(estimate.cacheWriteTokens).toBe(0);
  });

  it('bounds an image by a flat per-image ceiling, not by file size', () => {
    const oneMegabyte = 'A'.repeat(4 * 1024 * 1024); // ~3MB decoded
    const withImage = estimateMaxTokenUsage(
      request({
        messages: [
          {
            role: 'user',
            text: 'นี่รูปอะไร',
            images: [{ mediaType: 'image/jpeg', data: oneMegabyte }],
          },
        ],
      }),
    );

    // A megabyte-scale photo must not hold megabyte-scale credit: vision
    // billing is driven by resized dimensions, so the reserve stays small.
    expect(withImage.inputTokens).toBeLessThan(10_000);
  });

  it('scales the image reserve with the number of images, not their bytes', () => {
    const image = { mediaType: 'image/png' as const, data: 'A'.repeat(1_024) };
    const one = estimateMaxTokenUsage(
      request({ messages: [{ role: 'user', text: 'x', images: [image] }] }),
    );
    const two = estimateMaxTokenUsage(
      request({
        messages: [{ role: 'user', text: 'x', images: [image, image] }],
      }),
    );

    expect(two.inputTokens - one.inputTokens).toBe(4_000);
  });
});
