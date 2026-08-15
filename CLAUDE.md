## Tech Stack

* NestJS (Fastify adapter)
* TypeScript
* Prisma + PostgreSQL (pgvector)
* Redis (session, chat context, rate limits, bans) + BullMQ
* LINE Messaging API
* Multi-provider AI: `GEMINI` | `OPENAI` | `ANTHROPIC`

Detailed docs live in `docs/`: `architecture.html` (endpoints + ERD + data shapes),
`line-message-e2e-current.md` (field-level flow), `service-flow.md`, `erd-database.md`.

---

## Chatbot Architecture

```txt
LINE User Message
  -> LINE Messaging API Webhook
  -> LineController               // LineSignatureGuard + ingress limit, replies 200 {ok:true}
  -> BullMQ queue "line-events"   // jobId = webhookEventId
  -> LineEventsProcessor          // per-user ordering, stale/ban/burst/hourly/spam, DB claim
  -> LineWebhookService.processEvent()
       -> saveIncomingEvent()     // LineMember / LineConversation / LineChatHistory(USER)
       -> LoadContextService.load(conversationId)
  -> ChatbotService.handleTextMessage({ userId, text, recentMessages })
       -> UserSessionService.get(userId)
       -> IntentRouterService.resolve({ userId, input, session, recentMessages })
            -> RuleIntentService.detect(input)
            -> KnowledgeRetrievalService.retrieve(input)          // when rules are not decisive
            -> AiIntentClassifierService.classifyLowConfidence()  // only on LOW_CONFIDENCE
  -> Route by decision.action
       -> CANCEL_SESSION     -> UserSessionService.clear()
       -> START_REGISTER     -> RegistrationFlowService.start()
       -> CONTINUE_REGISTER  -> RegistrationFlowService.handle()
       -> ANSWER_KNOWLEDGE   -> AiChatService.answerKnowledge()
       -> GENERAL_QUESTION   -> decision.generatedResponse ?? AiChatService.answerFallback()
       -> CONTACT_ADMIN      -> session + NotificationService + contactAdmin()/fallback
       -> DEFAULT            -> ReplyTemplateService.defaultMessage()
  -> LineService.replyText(replyToken)
  -> saveSystemReplyMessage() + apply ChatResponse.contextPolicy
```

`START_AI_CHAT`, `CONTINUE_AI_CHAT` and `FALLBACK` exist in `ChatAction` but no router path
returns them. Do not build on them without wiring a route first.

---

## Intent Routing Rules

The chatbot uses **rule-first, then retrieval-first** routing. The LLM never classifies
before the knowledge base has been searched.

```txt
0. Empty message            -> default menu
   Message longer than AI_MAX_MESSAGE_LENGTH -> messageTooLong(), no AI call

1. CANCEL keyword           -> clear session immediately (top priority)

2. Active REGISTER session
   -> rule.confidence >= 0.9 and intent not UNKNOWN/REGISTER -> answer that rule (session stays ACTIVE)
   -> otherwise                                              -> CONTINUE_REGISTER

3. rule.confidence >= 0.9
   -> action != ANSWER_KNOWLEDGE -> use it directly
   -> action == ANSWER_KNOWLEDGE -> remember it, continue to retrieval

4. KnowledgeRetrievalService.retrieve(input)
   -> DIRECT | RAG      -> ANSWER_KNOWLEDGE
   -> LOW_CONFIDENCE    -> step 5

5. AiIntentClassifierService.classifyLowConfidence(input)
   -> GENERAL   -> GENERAL_QUESTION with the classifier's own response
   -> BUSINESS  -> CONTACT_ADMIN with businessFallback = true
```

An `ANSWER_KNOWLEDGE` answer that comes back with `insufficientContext` re-enters step 5
instead of returning a bare fallback.

---

## Knowledge Retrieval Rules

```txt
per pass: AnswerPattern cache (RAM) -> AnswerPattern DB -> embedding + pgvector -> merge & rank

decide():
  no candidate                                   -> LOW_CONFIDENCE (NO_SEARCH_RESULTS)
  exact match, or score >= 0.95 and gap >= 0.1   -> DIRECT   (answer verbatim, no LLM call)
  any candidate with score >= 0.6                -> RAG      (<= 3 contexts, temperature 0)
  otherwise                                      -> LOW_CONFIDENCE (BELOW_MIN_CONTEXT_SCORE)
```

* One bounded second pass is allowed (`MAX_RETRIEVAL_ATTEMPTS = 3`): follow-up questions are
  rewritten without an LLM; anything else costs one planner call.
* Queries produced by the planner may never answer verbatim — the second `decide()` runs with
  `allowDirect: false`.
* Retrieval failures set `fallbackReason: 'RETRIEVAL_ERROR'` and must not trigger another search.

Rules:

* AI must not execute business actions.
* AI must not confirm registration, payment, approval, or account status without backend verification.
* Business-related questions must be routed to backend/admin verification.
* Knowledge-base questions must go through `AiChatService.answerKnowledge()` (grounded on retrieved context only).
* Casual/general questions must use `AiChatService.answerGeneral()`.
* Every external AI call must pass `AiBudgetService.tryConsume()` first, and over-budget callers must fall back without an AI call.

---

## Supported Intents

`ChatIntent` in `src/modules/chatbot/types/chat.types.ts`:

| Intent             | Description                                  |
| ------------------ | -------------------------------------------- |
| `REGISTER`         | Customer registration                        |
| `REGISTER_HOW_TO`  | "how do I register" — answered from knowledge |
| `ANSWER_KNOWLEDGE` | Knowledge-base question                      |
| `GENERAL_QUESTION` | General question / small talk                |
| `CONTACT_ADMIN`    | Admin handoff                                |
| `CANCEL`           | Clear current session                        |
| `UNKNOWN`          | Fallback intent                              |

---

## RouteDecision

`IntentRouterService` returns a normalized decision.

```ts
{
  action: ChatAction;
  intent: ChatIntent;
  confidence: number;
  source: 'SESSION' | 'RULE' | 'CACHE' | 'DATABASE' | 'EMBEDDING' | 'AI';
  reason?: string;
  resolvedQuery?: string;
  retrieval?: KnowledgeRetrievalResult;   // passed on so AiChatService never re-searches
  generatedResponse?: string;             // GENERAL verdict may carry the answer itself
  businessFallback?: boolean;
  fallbackReason?: string;
}
```

`ChatbotService` only routes by `decision.action`, and always returns a `ChatResponse`
(`{ text, source, contextPolicy }`) — `contextPolicy` decides whether the turn is written to,
skipped by, or clears the Redis chat context.

---

## Database Summary

Database: PostgreSQL · ORM: Prisma · full ERD in `docs/erd-database.md`

| Entity                      | Purpose                                                       |
| --------------------------- | ------------------------------------------------------------- |
| `Member`                    | Customer profile, login, phone, bank info, and account status |
| `Payment`                   | Payment records and approval status                           |
| `AdminMember`               | Back-office account (`dev` / `owner` / `admin`) for JWT auth  |
| `AdminAiProviderSetting`    | Per-admin provider/model + allow list                         |
| `AiProviderSetting`         | Provider/model per scope (`USER`) for customer-facing calls   |
| `AiSetting`                 | AI prompt, tone, fallback, and behavior configuration         |
| `AnswerPattern`             | Knowledge-base answers                                        |
| `AnswerPatternVector`       | pgvector `vector(1536)` index derived from `AnswerPattern`    |
| `CreditWallet`              | Usage credit tracking                                         |
| `LineMember`                | LINE profile, optionally linked to a `Member`                 |
| `LineConversation`          | One open thread per `LineMember`                              |
| `LineChatHistory`           | Every inbound/outbound message                                |
| `ProcessedLineWebhookEvent` | Webhook idempotency claim                                     |

---

## Coding Rules

* Keep controllers thin.
* Put business logic in services.
* Use session state for multi-step flows.
* Keep intent detection deterministic.
* Do not expose secrets, tokens, or credentials.
* Do not run destructive commands unless explicitly requested.
* Do not change the Prisma schema unless explicitly requested.
* Do not let AI confirm business actions without backend verification.
