# Service Flows & Dependency Diagram

> **เอกสารนี้เป็น architecture review รุ่นเก่าและหลายส่วนไม่ตรงกับโค้ดปัจจุบันแล้ว**
> สำหรับ LINE flow ปัจจุบันที่มี signature guard, BullMQ, Redis session/context,
> idempotency และ rate limits ให้ใช้ [line-message-e2e-current.md](./line-message-e2e-current.md)

> Companion docs: [ai-chatbot-architecture.md](./ai-chatbot-architecture.md) · [erd-database.md](./erd-database.md)
>
> The diagrams below are retained as a **historical architecture-review snapshot**. Target behavior from that review is in the architecture doc §7.

---

## 1. Full LINE Message Flow

```mermaid
sequenceDiagram
    autonumber
    participant U as LINE User
    participant LP as LINE Platform
    participant LC as LineController
    participant LW as LineWebhookService
    participant CB as ChatbotService
    participant US as UserSessionService<br/>(in-memory Map)
    participant IR as IntentRouterService
    participant EX as Action executor<br/>(RegistrationFlow / AiChat / Templates)
    participant DB as PostgreSQL
    participant LA as LINE Messaging API

    U->>LP: text message
    LP->>LC: POST /api/line/webhooks
    Note over LC: x-line-signature received<br/>but NOT verified ⚠️
    loop each event (sequential)
        LC->>LW: saveIncomingEvent(event)
        LW->>LA: getProfile (first contact only)
        LW->>DB: upsert LineMember + LineConversation,<br/>insert LineChatHistory (USER)
        LC->>CB: handleTextMessage(userId, text)
        CB->>US: get(userId)
        CB->>IR: resolve({userId, input, session})
        IR-->>CB: RouteDecision {action, intent, confidence, source}
        CB->>EX: execute decision.action
        EX-->>CB: reply text
        CB-->>LC: reply text
        Note over LC: reserveLineReplyCredit()<br/>is commented out ⚠️
        LC->>LA: replyText(replyToken, text)
        alt LINE reply fails
            LC->>DB: refundLineReplyCredit()<br/>(refund without reserve ⚠️)
            LC-->>LP: 500 → LINE retries batch
        end
        LC->>LW: saveSystemReplyMessage(...)
        LW->>DB: insert LineChatHistory (SYSTEM),<br/>update LineConversation
    end
    LC-->>LP: 200 {ok:true}
    LP-->>U: bot reply
```

No dedupe by `lineMessageId`: a LINE redelivery re-runs the whole pipeline, including Gemini calls.

---

## 2. Intent Routing Flow

`IntentRouterService.resolve()` — the decision policy:

```mermaid
flowchart TD
    IN["input text"] --> RULE["RuleIntentService.detect<br/>(deterministic, no I/O)"]
    RULE --> C1{"intent == CANCEL?"}
    C1 -- yes --> A_CANCEL["CANCEL_SESSION<br/>source=RULE, conf=1"]
    C1 -- no --> C2{"session ACTIVE<br/>and flow == REGISTER?"}
    C2 -- yes --> C3{"rule conf ≥ 0.9 and<br/>intent not UNKNOWN/REGISTER?"}
    C3 -- yes --> A_INT["Interrupt: map rule intent to action<br/>source=SESSION<br/>(register session stays ACTIVE)"]
    C3 -- no --> A_CONT["CONTINUE_REGISTER<br/>source=SESSION"]
    C2 -- no --> C4{"rule conf ≥ 0.9?"}
    C4 -- yes --> A_RULE["RULE_MAP intent → action<br/>source=RULE"]
    C4 -- no --> AI["AiIntentClassifierService.analyze<br/>(Gemini, JSON {intent, confidence})"]
    AI --> C5{"ai.confidence < 0.6<br/>or call failed?"}
    C5 -- yes --> A_GEN["GENERAL_QUESTION<br/>source=AI (safe fallback)"]
    C5 -- no --> A_AI["AI_MAP intent → action<br/>source=AI"]

    A_CANCEL --> SW
    A_INT --> SW
    A_CONT --> SW
    A_RULE --> SW
    A_GEN --> SW
    A_AI --> SW
    SW["ChatbotService switch(action)"]
    SW --> X1["CANCEL_SESSION → clear + template"]
    SW --> X2["START_REGISTER / CONTINUE_REGISTER<br/>→ RegistrationFlowService<br/>(gated by CAN_REGISTER)"]
    SW --> X3["ANSWER_KNOWLEDGE → answerKnowLedge"]
    SW --> X4["GENERAL_QUESTION → answerGeneral"]
    SW --> X5["CONTACT_ADMIN → session + socket notify + template"]
    SW --> X6["START_AI_CHAT / CONTINUE_AI_CHAT<br/>(UNREACHABLE — no router path returns these) ⚠️"]
    SW --> X7["default → menu template"]
```

Known routing gaps: menu `3` (offered by the default menu) has no rule → goes to the AI classifier; menu `2` sends the literal `"2"` to `answerGeneral`.

---

## 3. Register Session Flow

```mermaid
stateDiagram-v2
    [*] --> WAITING_REGISTER_FORM : START_REGISTER<br/>session created (ACTIVE)
    WAITING_REGISTER_FORM --> SEND_REGISTER_FORM : immediately —<br/>sends form template
    SEND_REGISTER_FORM --> SEND_REGISTER_FORM : parse + merge fields<br/>missing fields → ask again<br/>invalid phone/bank → error msg
    SEND_REGISTER_FORM --> CURRENT_REGISTER : all fields complete + valid
    CURRENT_REGISTER --> COMPLETED : RegistrationService.register OK<br/>reply username + password<br/>(session NEVER deleted ⚠️)
    CURRENT_REGISTER --> SEND_REGISTER_FORM : register error<br/>(raw error.message shown ⚠️)
    SEND_REGISTER_FORM --> [*] : CANCEL keyword<br/>(session cleared)
    note right of SEND_REGISTER_FORM
        Digression: high-confidence rule intent
        is answered but session stays ACTIVE.
        CONTACT_ADMIN overwrites the session
        and loses form data ⚠️
    end note
    note right of COMPLETED
        PENDING_REGISTER step exists in code
        but is never entered (dead state)
    end note
```

Registration internals: `RegisterParser` reads labeled lines (`ชื่อ: สมชาย`, aliases in Thai/English) and infers unlabeled lines (10-digit phone, 10–12-digit account, bank-name aliases, text-only lines as first/last name). `RegistrationService.register()` checks phone/bank uniqueness, generates `mb{last4}{rand}` username + random hex password (bcrypt-stored), retries on username collision.

---

## 4. Knowledge Answer Flow

`AiChatService.answerKnowLedge()`:

```mermaid
flowchart TD
    Q["user message<br/>(action = ANSWER_KNOWLEDGE)"] --> SET["load active AiSetting<br/>(prompt / tone / fallback,<br/>defaults on miss)"]
    SET --> APS["AnswerPatternService.findMatches<br/>lexical scoring over active patterns:<br/>keywords, examples, intentKey, title,<br/>category, priority tiebreak<br/>min score 2, top 5"]
    APS --> HAS{"matches found?"}
    HAS -- yes --> STRONG{"top score ≥ 5 and<br/>gap to 2nd ≥ 2?"}
    STRONG -- yes --> DIRECT["return stored answer VERBATIM<br/>(no Gemini call)"]
    STRONG -- no --> GROUND["Gemini generateContent<br/>grounded prompt: answer ONLY from<br/>these items, else output fallback"]
    HAS -- no --> VEC["SemanticSearchService.search<br/>(vector fallback)"]
    VEC --> EMPTY["STUB: embeds via Gemini ($)<br/>then always returns [] ⚠️"]
    EMPTY --> FB["AiSetting.fallbackMessage"]
    GROUND --> OK{"Gemini ok?"}
    OK -- yes --> ANS["grounded answer"]
    OK -- no/empty --> FB
```

`answerGeneral()` (small talk) never touches the knowledge base: system prompt + general rules (no business-status claims, don't reveal being an AI) → Gemini → text or fallback.

---

## 5. Vector Fallback Flow — current vs intended

```mermaid
flowchart TD
    subgraph CUR["CURRENT (stub)"]
        A1["knowledge miss"] --> A2["EmbeddingService.embed<br/>Gemini embedding call — paid"]
        A2 --> A3["SemanticSearchService returns []"]
        A3 --> A4["fallbackMessage<br/>(embedding cost wasted ⚠️)"]
    end
    subgraph TGT["INTENDED (Phase 4)"]
        B1["knowledge miss / weak keyword score"] --> B2["embed query once"]
        B2 --> B3["pgvector cosine top-5:<br/>AnswerPatternVector ⋈ AnswerPattern<br/>WHERE active, similarity ≥ ~0.6"]
        B3 --> B4{"hits above floor?"}
        B4 -- yes --> B5["grounded Gemini generation<br/>from matched patterns' answers"]
        B4 -- no --> B6["fallbackMessage — never generate"]
    end
```

Blockers for the intended flow: no migration exists for `AnswerPatternVector` (no `CREATE EXTENSION vector`, no table DDL, no index), and nothing ever writes embeddings (needs embed-on-write in AnswerPattern CRUD + a backfill). `KnowledgeRetrievalService` already sketches the keyword-first/vector-fallback merge but is dead code.

---

## 6. Admin / Contact Handoff Flow

```mermaid
sequenceDiagram
    autonumber
    participant U as LINE User
    participant CB as ChatbotService
    participant US as UserSessionService
    participant NS as NotificationService
    participant NG as NotificationGateway<br/>(socket.io /admin, origin *)
    participant AD as Admin Dashboard
    participant LW as LineWebhookService
    participant LA as LINE API

    U->>CB: "ติดต่อแอดมิน" (rule or AI intent)
    CB->>US: set CONTACT_ADMIN session<br/>(never read by router, never cleared ⚠️)
    CB->>NS: notifyContactAdmin(session)
    NS->>NG: emitContactAdmin
    NG-->>AD: broadcast "CONTACT_ADMIN" event
    CB-->>U: "รับทราบครับ เดี๋ยวแอดมินจะเข้ามาดูแล"
    Note over U,CB: Bot is NOT muted — next user message<br/>is routed normally ⚠️
    AD->>LW: POST /api/line/conversations/:id/messages<br/>(no auth ⚠️)
    LW->>LA: pushText(lineUserId, text)
    LW->>LW: persist ADMIN message + update conversation
    LA-->>U: admin reply
```

Target (architecture doc §5.4/§7): handoff sets `LineConversation.status = 'admin'` in PostgreSQL, the bot mutes while that status holds, and an active register session survives the handoff.

---

## 7. Service Dependency Diagram

```mermaid
flowchart LR
    subgraph LINE["LineModule"]
        LC["LineController"]
        LCC["LineConversationController<br/>(duplicate endpoints)"]
        LWS["LineWebhookService"]
        LS["LineService<br/>(LINE REST client)"]
    end
    subgraph CHAT["ChatbotModule"]
        CB["ChatbotService"]
        IR["IntentRouterService"]
        RI["RuleIntentService"]
        RT["ReplyTemplateService"]
        US["UserSessionService<br/>(in-memory Map ⚠️)"]
    end
    subgraph AIM["AiModule"]
        ACS["AiChatService"]
        AIC["AiIntentClassifierService"]
        APS["AnswerPatternService"]
        SSS["SemanticSearchService<br/>(stub ⚠️)"]
        EMB["EmbeddingService"]
        KRS["KnowledgeRetrievalService<br/>(dead code ⚠️)"]
    end
    subgraph REG["Registration"]
        RF["RegistrationFlowService<br/>(provided by ChatbotModule ⚠️)"]
        RS["RegistrationService"]
        RC["RegistrationController<br/>(public, body:any ⚠️)"]
    end
    subgraph ADM["Admin / Notification"]
        NS["NotificationService"]
        NG["NotificationGateway<br/>(socket.io)"]
    end
    CS["CreditService"]
    PR[("PrismaService<br/>PostgreSQL")]
    RD[("Redis<br/>provisioned, unused ⚠️")]
    GEM[["Gemini API"]]
    LAPI[["LINE Messaging API"]]

    LC --> LWS
    LC --> CB
    LC --> LS
    LC --> CS
    LCC --> LWS
    LWS --> PR
    LWS --> LS
    LS --> LAPI
    CB --> IR
    CB --> US
    CB --> RT
    CB --> RF
    CB --> ACS
    CB --> NS
    IR --> RI
    IR --> AIC
    AIC --> GEM
    ACS --> PR
    ACS --> APS
    ACS --> SSS
    ACS --> GEM
    APS --> PR
    SSS --> EMB
    EMB --> GEM
    KRS -.-> APS
    KRS -.-> SSS
    RF --> US
    RF --> RT
    RF --> RS
    RS --> PR
    RC --> RS
    NS --> NG
    CS --> PR
```

**Prisma access:** `LineWebhookService`, `AiChatService`, `AnswerPatternService`, `RegistrationService`, `CreditService`, `UsersService`.
**External APIs:** `LineService` → LINE; `AiIntentClassifierService`, `AiChatService`, `EmbeddingService` → Gemini (three separate `GoogleGenAI` instances — should be one shared provider).
**Unused infra:** Redis client, BullMQ, Mongoose (required at boot, used by nothing).

**Couplings that should not exist:**
- `LineController` → `CreditService` + `ChatbotService` + `LineWebhookService` + `LineService`: the controller orchestrates; move this into a webhook-handler service and keep the controller thin.
- `ChatbotModule` providing `RegistrationFlowService`/`RegisterParser`/`RegisterValidator` (registration internals): they belong in `RegistrationModule`'s exports.
- `AiChatService` → `AnswerPatternService` + `SemanticSearchService` directly, duplicating `KnowledgeRetrievalService`: retrieval should have exactly one entry point.
- `AiChatService` → Prisma for `AiSetting`: acceptable pragmatically, but a small settings accessor would keep the LLM service free of DB reads.
- `ChatbotService` → `NotificationService` (admin domain): fine as a direct call at this scale, but the handoff state itself belongs in `LineConversation.status`, not the chat session.
