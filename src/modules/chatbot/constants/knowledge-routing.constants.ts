export const DIRECT_IMMEDIALY = 0.95;
export const MIN_CONTEXT_SCORE = 0.6;
export const CLEAR_WINNER_GAP = 0.1;
export const MAX_RAG_CONTEXTS = 3;

/** Internal retrieval limits and score conversion live here to avoid drift. */
export const MAX_RETRIEVAL_CANDIDATES = 20;
/** One original search plus at most two rewritten/decomposed searches. */
export const MAX_RETRIEVAL_ATTEMPTS = 3;
export const MAX_REWRITTEN_QUERIES = MAX_RETRIEVAL_ATTEMPTS - 1;
export const KEYWORD_SCORE_NORMALIZER = 5;

export const INSUFFICIENT_CONTEXT = 'INSUFFICIENT_CONTEXT';
