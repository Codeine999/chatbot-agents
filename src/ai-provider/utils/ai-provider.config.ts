export const AI_GENERATION_CONFIG = {
  temperature: Number(process.env.GEMINI_TEMPERATURE || 0.2),
  maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 500),
  httpOptions: {
    timeout: Number(process.env.GEMINI_ANSWER_TIMEOUT_MS || 12_000),
  },
};
