# Offline chatbot / RAG audit

Run from the repository root:

```bash
bun run test --config test/jest-chatbot-audit.json --runInBand
```

The 2026-10-01 snapshot has 80 cases, 39 passing and 41 failing. Failures assert proposed acceptance conditions; several share a root cause. Some are provider fault injection, product-policy proposals, or boundary probes. They are **not a live-model accuracy score**. See the [Thai report](../../docs/chatbot-core-rag-audit-2026-10-01.th.md) for evidence and priorities.

The opt-in config keeps these unresolved audit expectations out of the existing default test selection. After fixes and agreement on policy, promote the relevant acceptance cases into the normal suite. Do not change expected behavior merely to make a reproduced defect pass.

The suite uses actual chatbot services with synthetic persistence, mocked embeddings, and explicit raw provider responses. It does not send LINE messages or call paid AI providers. Multi-turn cases simulate successful delivery when appending history. Worker ordering cases use service instances with mocked claim/process boundaries, not a real distributed queue.

Running the suite rewrites `docs/audit-artifacts/chatbot-2026-10-01/cases.json`. The Markdown case appendix is a reviewed snapshot; update it when recording a new audit result. It contains shortened long strings, while the JSON preserves captured payloads.

# Live product / e-commerce audit (paid)

`chat-product-ecom.audit.ts` is different: 80 fashion-store cases (single questions, multi-turn journeys, safety, fault injection, system events) through the **real** model, embeddings, product search, CommerceTurn, billing and Redis context. It is skipped unless started by its runner, which creates a disposable PostgreSQL + Redis, applies every migration and seeds a synthetic store through the real admin services:

```bash
npm run test:product-audit
PRODUCT_AUDIT_FILTER='^(A|J)' npm run test:product-audit   # subset by id or group
PRODUCT_AUDIT_JUDGE=0 npm run test:product-audit          # no LLM judge
```

Each turn is graded deterministically on the RAG decision (planner used or skipped, plan mode/operation/asks/options, search status, LLM slots, catalogRefs, handoff) and on the answer (required facts, forbidden claims, numbers that are not store data, PII reaching a provider). After each conversation a second model (default `anthropic/claude-sonnet-5.5` via OpenRouter, a different family from the chat model) scores every reply and the whole conversation for correctness, grounding, helpfulness, naturalness, tone, context memory and handoff. The judge is advisory unless `PRODUCT_AUDIT_JUDGE_GATE=1`.

Output goes to `$PRODUCT_AUDIT_OUT` (default `<tmpdir>/product-ecom-audit/<run>`): `report.md` (group results, judge averages, event coverage of the product flow, failures), `conversations.md` (readable transcripts for human or LLM review) and `results.json`. Model overrides: `PRODUCT_AUDIT_PROVIDER`, `PRODUCT_AUDIT_MODEL`, `PRODUCT_AUDIT_JUDGE_PROVIDER`, `PRODUCT_AUDIT_JUDGE_MODEL`.
