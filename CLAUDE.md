# CLAUDE.md

LINE OA customer-support backend: webhook → BullMQ → intent routing → RAG/AI →
delivery, plus registration, admin handoff, commerce, and credit billing.
NestJS 11 (Fastify), Prisma 7, Postgres + pgvector, Redis, zod. Package manager: **bun**.

Production serves one company, but the schema is multi-tenant ready: never weaken
company ownership checks.

**Push to `main` auto-deploys and runs `prisma migrate deploy` on production.**
Never commit or push to main unless asked.

Domain invariants live in `.claude/rules/` and load when you touch matching files.

## Map

- `prisma/` – multi-file schema (`schema.prisma`, `models/**`, `*.prisma`) + `migrations/`
- `src/generated/` – Prisma client, gitignored. Never edit.
- `src/modules/chatbot/` – `chatbot.service.ts` orchestrates; `intent/`, `knowledge/`,
  `answer/` (`AiChatService` is in `answer.service.ts`), `menu/`
- `src/modules/line/` – webhook, queue worker, delivery
- `src/modules/usage/` – pricing, wallet, budget, reservation, ledger
- `src/ai-provider/` – provider adapters; `src/infra/` – embedding, redis, storage
- `test/live/` – real-provider evals (costs money; run only when asked)

Trust order: code/migrations > tests > `docs/*-current.md`, `docs/erd-database.md` >
`docs/feature/*` (targets, not implemented). Report doc drift.

## Rules

- Smallest complete change; trace callers before changing shared types/contracts.
- Reuse existing modules and patterns (NestJS DI, nestjs-zod DTOs, existing errors).
- Ask before adding production dependencies.
- Never call an external provider (AI, LINE, storage) inside a DB transaction.
- Controllers only auth/validate/delegate. `RuleIntentService` does no I/O.
  `KnowledgeRetrievalService` is the only retrieval entry point. Only usage
  services mutate wallet/budget/reservation/ledger.
- Never send registration PII to AI; redact PII in context and logs.
- Never expose secrets, `costThb`, or raw internal errors to users.
- Tests mock LINE/AI and must never send live messages.
- Don't change business behavior just to make a test pass.

## Done

- Run targeted tests, then `bunx tsc --noEmit`, `bun run lint`, `bun run build` as risk warrants.
  Never claim a check passed unless you ran it.
- Update current-flow docs when behavior changes.
- Report: changes, checks run, unverified areas, deploy risks.
