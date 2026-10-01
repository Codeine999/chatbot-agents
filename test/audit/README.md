# Offline chatbot / RAG audit

Run from the repository root:

```bash
bun run test --config test/jest-chatbot-audit.json --runInBand
```

The 2026-10-01 snapshot has 80 cases, 39 passing and 41 failing. Failures assert proposed acceptance conditions; several share a root cause. Some are provider fault injection, product-policy proposals, or boundary probes. They are **not a live-model accuracy score**. See the [Thai report](../../docs/chatbot-core-rag-audit-2026-10-01.th.md) for evidence and priorities.

The opt-in config keeps these unresolved audit expectations out of the existing default test selection. After fixes and agreement on policy, promote the relevant acceptance cases into the normal suite. Do not change expected behavior merely to make a reproduced defect pass.

The suite uses actual chatbot services with synthetic persistence, mocked embeddings, and explicit raw provider responses. It does not send LINE messages or call paid AI providers. Multi-turn cases simulate successful delivery when appending history. Worker ordering cases use service instances with mocked claim/process boundaries, not a real distributed queue.

Running the suite rewrites `docs/audit-artifacts/chatbot-2026-10-01/cases.json`. The Markdown case appendix is a reviewed snapshot; update it when recording a new audit result. It contains shortened long strings, while the JSON preserves captured payloads.
