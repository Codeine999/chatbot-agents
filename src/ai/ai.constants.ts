export const AI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

export const AI_GENERATION_CONFIG = {
  minimumOutputTokens:Number(process.env.GEMINI_MINIMUM_OUTPUT_TOKENS || 0.3),
  maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 500)
};