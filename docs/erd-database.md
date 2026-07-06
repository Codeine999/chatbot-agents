# Database ERD

> Source: `prisma/schema.prisma` (PostgreSQL, Prisma 7). Companion docs: [ai-chatbot-architecture.md](./ai-chatbot-architecture.md) · [service-flow.md](./service-flow.md)

## Entity-Relationship Diagram

```mermaid
erDiagram
    Member {
        uuid uuid PK
        string username UK "generated mb+last4+rand"
        string password "bcrypt hash"
        string firstname
        string lastname
        string phone UK
        string bankname
        string banknumber UK
        string statusaccount "free text, default 'pending' — not an enum"
    }

    Payment {
        uuid uuid PK
        string username FK "references Member.username (not uuid)"
        PaymentType paymentType
        PaymentStatus status "default pending"
        datetime createdAt
        uuid approveBy "nullable — no Admin table to reference"
        datetime approvedAt "nullable"
    }

    LineMember {
        uuid id PK
        uuid memberId FK "nullable, onDelete SetNull"
        string lineUserId UK "LINE platform user id"
        string displayName
        string pictureUrl "nullable"
        string statusMessage "nullable"
        datetime lastActiveAt "nullable, indexed"
        datetime profileSyncedAt "nullable"
        datetime createdAt
        datetime updatedAt
    }

    LineConversation {
        uuid id PK
        uuid lineMemberId FK "unique — enforces 1:1"
        string status "free text, default 'open'"
        string lastMessage "denormalized preview"
        LineChatMessageType lastMessageType
        datetime lastMessageAt "indexed"
        int unreadCount "default 0"
        datetime createdAt
        datetime updatedAt
    }

    LineChatHistory {
        uuid id PK
        uuid conversationId FK "indexed with createdAt"
        uuid lineMemberId FK "denormalized shortcut, indexed"
        LineChatSender sender
        LineChatMessageType messageType
        string text "nullable"
        string lineMessageId "nullable, indexed but NOT unique"
        string replyToken "nullable"
        string stickerPackageId "nullable"
        string stickerId "nullable"
        string stickerResourceType "nullable"
        string mediaUrl "nullable"
        string postbackData "nullable"
        json rawEvent "nullable, full LINE payload"
        string sentStatus "free text, default 'received'"
        datetime createdAt
    }

    AnswerPattern {
        uuid id PK
        string title
        string description "nullable"
        string category "nullable"
        string intentKey "nullable"
        string_array keywords "default []"
        string_array questionExamples "default []"
        string answer "admin-authored canonical answer"
        int priority "default 0, tiebreak in scoring"
        boolean active "default true"
        datetime createdAt
        datetime updatedAt "no @updatedAt — only default(now)"
    }

    AnswerPatternVector {
        uuid id PK
        uuid answerPatternId FK "unique — 1:1, cascade delete"
        vector embedding "pgvector Unsupported type"
        string embeddingModel "nullable — for re-embedding"
        boolean active "default true, indexed"
        datetime createdAt
        datetime updatedAt "no @updatedAt"
    }

    AiSetting {
        uuid id PK
        string systemPrompt
        string tone "nullable"
        string fallbackMessage "nullable"
        boolean active "default true — multiple actives possible"
        datetime createdAt
        datetime updatedAt "no @updatedAt"
    }

    CreditWallet {
        uuid id PK
        CreditWalletType type UK "one wallet per type"
        int balance "default 0"
        int usedTotal "default 0"
        boolean active "default true"
        datetime createdAt
        datetime updatedAt
    }

    Member ||--o{ Payment : "payments"
    Member |o--o{ LineMember : "lineMembers"
    LineMember ||--o| LineConversation : "conversation 1:1"
    LineMember ||--o{ LineChatHistory : "chatHistories"
    LineConversation ||--o{ LineChatHistory : "chatHistories"
    AnswerPattern ||--o| AnswerPatternVector : "vector 1:1"
```

## Enums

| Enum | Values | Used by |
|---|---|---|
| `PaymentType` | `QRcode`, `Slip` | `Payment.paymentType` |
| `PaymentStatus` | `pending`, `success`, `fail`, `reject` | `Payment.status` |
| `CreditWalletType` | `LINE_MESSAGE`, `AI_USAGE`, `ADMIN_AI_QUERY` | `CreditWallet.type` |
| `LineChatSender` | `USER`, `ADMIN`, `AI`, `SYSTEM` (db-mapped lowercase) | `LineChatHistory.sender` |
| `LineChatMessageType` | `TEXT`, `IMAGE`, `STICKER`, `POSTBACK` (db-mapped lowercase) | `LineChatHistory.messageType`, `LineConversation.lastMessageType` |

## Relations Summary

| Relation | Cardinality | On delete | Notes |
|---|---|---|---|
| `Member` → `Payment` | 1 : N | default (restrict) | FK is `username`, **not** `uuid` |
| `Member` → `LineMember` | 1 : N (optional) | `SetNull` | LINE profile can exist before linking to a Member |
| `LineMember` → `LineConversation` | 1 : 1 | default | `lineMemberId` unique |
| `LineMember` → `LineChatHistory` | 1 : N | default | denormalized alongside `conversationId` — convenient, consistency not DB-enforced |
| `LineConversation` → `LineChatHistory` | 1 : N | default | composite index `(conversationId, createdAt)` fits pagination |
| `AnswerPattern` → `AnswerPatternVector` | 1 : 1 | `Cascade` | vector is a derived index of the pattern |

## Missing / Suspicious — findings

1. **`AnswerPatternVector` has no migration.** `prisma/migrations/` ends at `20260621001000_add_user_line_chat_sender`; nothing creates the `vector` extension, the table, or any ANN index. Schema and database have drifted — a fresh deploy from migrations will not have this table. Needs a hand-written migration (`CREATE EXTENSION IF NOT EXISTS vector`, table DDL, HNSW/ivfflat index), since Prisma can't generate DDL for `Unsupported("vector")`.
2. **`Payment.approveBy` is a dangling UUID** — there is no Admin/Staff table to reference. Either add one (also needed for dashboard auth) or document what it points to.
3. **`Payment` → `Member` joins on `username`**, a business-visible field, instead of the immutable `uuid` PK. Works because `username` is unique, but renaming a user breaks history semantics. `Payment` also lacks an **amount/currency** and any slip reference — unusual for a payment record.
4. **Free-text status columns**: `Member.statusaccount` (`'pending'`), `LineConversation.status` (`'open'`), `LineChatHistory.sentStatus` (`'received'`) are strings, while `Payment.status` is a proper enum. Inconsistent; typos become silent states. `LineConversation.status` is the natural home for the admin-takeover flag (`open`/`admin`/`closed`) — worth making an enum when that lands.
5. **`LineChatHistory.lineMessageId` is indexed but not unique** — the schema anticipates webhook dedupe, but nothing enforces or checks it. A partial unique index (where not null) would make redelivery idempotent at the DB level.
6. **No session/conversation-state table** — chat sessions live only in process memory (see architecture doc §6); fine once Redis holds them, but worth stating that the DB intentionally does not persist flow state.
7. **Multiple active `AiSetting` rows are possible**; code picks `findFirst(active, orderBy updatedAt desc)`. A partial unique index on `active = true` (or a singleton row convention) would remove the ambiguity.
8. **`updatedAt` without `@updatedAt`** on `AiSetting`, `AnswerPattern`, `AnswerPatternVector` — the column never updates unless set manually, which breaks the "newest active setting wins" ordering above.
9. **Credentials at rest**: `Member.password` is bcrypt-hashed (good), but the register-success chat reply containing the *plaintext* password is persisted into `LineChatHistory.text` (see architecture doc §6, finding 2). A data-model-adjacent leak worth fixing at the application layer.
10. **`CreditWallet` is global** (unique per type, no tenant/member FK) — correct for a single-OA deployment; becomes a remodel if multi-tenant is ever planned.
