/** Legacy admin diagnostic bands only; customer routing never uses cosine DIRECT. */
export const DIRECT_IMMEDIALY = 0.95;
export const MIN_CONTEXT_SCORE = 0.6;
export const MAX_RAG_CONTEXTS = 4;

/** Internal retrieval limits and score conversion live here to avoid drift. */
export const MAX_RETRIEVAL_CANDIDATES = 20;
export const RRF_RANK_CONSTANT = 60;
/** Starting noise floors, configurable per deployment and subject to Thai eval. */
export const DEFAULT_VECTOR_CANDIDATE_MIN_SIMILARITY = 0.6;
export const DEFAULT_LEXICAL_CANDIDATE_MIN_SCORE = 0.1;
/**
 * A keyword-only candidate after the first one must cover at least this share
 * (IDF-weighted) of the question's content terms to take an evidence slot.
 * BM25 scores are unbounded, so the score floor above cannot reject a hit on one
 * generic word. The top item is exempt; 0 disables the check.
 */
export const DEFAULT_LEXICAL_MIN_COVERAGE = 0.5;
/**
 * RAG without the BUSINESS/GENERAL classifier needs a vector hit this close;
 * a shared word (BM25) is not enough. Calibrated 2026-10-02 on
 * gemini-embedding-2 (1536 dims): small talk 0.56–0.71, KB questions median
 * 0.80. Recalibrate whenever the embedding model changes.
 */
export const DEFAULT_RAG_MIN_VECTOR_SIMILARITY = 0.75;
export const MAX_RAG_EVIDENCE_CHARACTERS = 12_000;

/**
 * A knowledge row with this `intentKey` only anchors routing: a match means the
 * customer asked for a human, so the system hands off for real (requestAdmin).
 * Its stored answer is never shown or fed to the model, because text cannot
 * promise an action the system did not take.
 */
export const HANDOFF_INTENT_KEY = 'contact.admin';

export const INSUFFICIENT_CONTEXT = 'INSUFFICIENT_CONTEXT';
export const CLARIFY_MESSAGE = 'ช่วยอธิบายเพิ่มเติมหน่อยได้มั้ยคะ';
