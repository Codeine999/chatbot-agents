/** Legacy admin diagnostic bands only; customer routing never uses cosine DIRECT. */
export const DIRECT_IMMEDIALY = 0.95;
export const MIN_CONTEXT_SCORE = 0.6;
export const MAX_RAG_CONTEXTS = 3;

/** Internal retrieval limits and score conversion live here to avoid drift. */
export const MAX_RETRIEVAL_CANDIDATES = 20;
export const RRF_RANK_CONSTANT = 60;
/** Starting noise floors, configurable per deployment and subject to Thai eval. */
export const DEFAULT_VECTOR_CANDIDATE_MIN_SIMILARITY = 0.6;
export const DEFAULT_LEXICAL_CANDIDATE_MIN_SCORE = 0.1;
/**
 * RAG without the BUSINESS/GENERAL classifier needs a vector hit this close;
 * a shared word (BM25) is not enough. Calibrated 2026-10-02 on
 * gemini-embedding-2 (1536 dims): small talk 0.56–0.71, KB questions median
 * 0.80. Recalibrate whenever the embedding model changes.
 */
export const DEFAULT_RAG_MIN_VECTOR_SIMILARITY = 0.75;
export const MAX_RAG_EVIDENCE_CHARACTERS = 12_000;

export const INSUFFICIENT_CONTEXT = 'INSUFFICIENT_CONTEXT';
export const CLARIFY_MESSAGE = 'ช่วยอธิบายเพิ่มเติมหน่อยได้มั้ยครับ';
