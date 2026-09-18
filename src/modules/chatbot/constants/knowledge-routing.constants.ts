/** Legacy admin diagnostic bands only; customer routing never uses cosine DIRECT. */
export const DIRECT_IMMEDIALY = 0.95;
export const MIN_CONTEXT_SCORE = 0.6;
export const MAX_RAG_CONTEXTS = 3;

/** Internal retrieval limits and score conversion live here to avoid drift. */
export const MAX_RETRIEVAL_CANDIDATES = 20;
export const RRF_RANK_CONSTANT = 60;
/** Starting noise floors, configurable per deployment and subject to Thai eval. */
export const DEFAULT_VECTOR_CANDIDATE_MIN_SIMILARITY = 0.6;
export const DEFAULT_LEXICAL_CANDIDATE_MIN_SCORE = 3;
export const MAX_RAG_EVIDENCE_CHARACTERS = 12_000;

export const INSUFFICIENT_CONTEXT = 'INSUFFICIENT_CONTEXT';
