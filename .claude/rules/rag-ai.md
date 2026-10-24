---
paths:
  - "src/modules/chatbot/**"
  - "src/modules/ai/**"
  - "src/modules/admin/knowledge/**"
  - "src/ai-provider/**"
  - "src/infra/embedding/**"
---

# RAG and AI

- `ChatbotService` orchestrates; `IntentRouterService` only decides.
  `AiChatService` does grounded generation, not retrieval scoring.
- Cancel/menu/active-flow handling is deterministic; every displayed menu
  option needs deterministic handling.
- Classifier/provider failure fails safe. No adequate evidence → configured
  safe fallback, never an invented business answer.
- Price, stock, balance, and account status come from DB/API, never vector text.
- `AnswerPattern` is source, `AnswerPatternVector` is derived: content changes
  must update/invalidate the vector. Embedding model/dimension changes need a
  migration + reindex.
- Retrieval enforces active, language, and company filters.
- Changing scoring, prompts, embeddings, thresholds, or query rewrite requires
  retrieval tests with realistic **Thai** queries.
- All model calls go through the shared provider abstraction. Adapters own
  timeouts, usage normalization, and errors. Persist provider request IDs.
- Don't double-count input / cached-input / cache-write / output / reasoning tokens.
