import { DEFAULT_AI_MAX_OUTPUT_TOKENS } from './ai-provider.constants';

export const AI_GENERATION_CONFIG = {
  temperature: Number(process.env.GEMINI_TEMPERATURE || 0.5),
  maxOutputTokens: DEFAULT_AI_MAX_OUTPUT_TOKENS,
  httpOptions: {
    timeout: Number(process.env.GEMINI_ANSWER_TIMEOUT_MS || 12_000),
  },
};
