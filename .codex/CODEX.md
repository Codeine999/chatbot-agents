## Project overview

This project is a NestJS chatbot API for handling customer messages from LINE OA.

Current main feature:

* Receive LINE webhook events.
* Process incoming text messages.
* Detect user intent.
* Handle customer registration flow.
* Reply to the user through LINE Messaging API.

Future features:

* AI chat support for product/service questions.
* Facebook and Telegram support.
* Admin dashboard.
* Chat history and customer status lookup.

Project folder:

```text
CHATBOT-API
```

---

## Tech stack

```text
Runtime: Bun
Framework: NestJS + TypeScript
HTTP Adapter: Fastify
Main DB: PostgreSQL + Prisma
Chat History DB: MongoDB + Mongoose
Session/State: Redis
API Docs: Swagger
Validation: Zod / nestjs-zod
Local Infra: docker-compose
```

---

## Database responsibility

Use each database for a clear purpose.

```text
PostgreSQL = source of truth for business data
MongoDB = chat history and raw webhook events
Redis = active conversation/session state
```

PostgreSQL should store:

```text
customers
registrations
generated username/password records
product/service data
admin/dashboard business data
```

MongoDB should store:

```text
LINE raw webhook events
incoming/outgoing chat messages
AI conversation history
message payload snapshots
```

Redis should store:

```text
active user sessions
current conversation flow
current registration step
temporary registration data
```

If data conflicts, trust PostgreSQL first.

---

## Main registration flow

When a LINE user sends:

```text
สมัครสมาชิก
```

the bot should start a registration session.

Required fields:

```text
firstName
lastName
bankName
bankAccount
```

Optional future field:

```text
phoneNumber
```

The bot should ask for missing data until complete.

Example missing field reply:

```text
ข้อมูลยังไม่ครบครับ ขาด:
- นามสกุล
- เลขบัญชี

กรุณาส่งข้อมูลที่ขาดมาเพิ่มเติม
```

When all data is complete:

1. Confirm the data with the user.
2. If user sends `ยืนยัน`, call registration service.
3. Create customer in PostgreSQL.
4. Generate username and password.
5. Reply username, password, and website URL to LINE.
6. Clear or complete the session.

Username rule:

```text
username = firstName
if duplicate, append number
```

Example:

```text
somchai
somchai1
somchai2
```

Password rule:

```text
Generate random password
```

Do not store plain passwords in production.

---

## Conversation behavior

User can cancel anytime with:

```text
ยกเลิก
cancel
ออก
```

On cancel:

```text
clear session
reply cancellation message
```

Registration flow must be deterministic and rule-based.

Do not let AI control critical registration steps.

---

## AI chat behavior

Future AI feature should answer product/service questions from real backend data.

Example questions:

```text
สินค้านี้ราคาเท่าไร
มีขนาดอะไรบ้าง
บริการนี้ทำยังไง
สมัครสมาชิกยังไง
```

AI must retrieve real product/service data before answering.

AI must not invent:

```text
prices
product details
bank information
registration credentials
```

Routing rule:

```text
If user is in active REGISTER flow:
  continue registration flow

If user wants to register:
  start rule-based registration flow

If user asks product/service question:
  route to AI/product-service Q&A
```

---

## Suggested project structure

```text
src/
├─ modules/
│  ├─ chatbot/
│  │  ├─ chatbot.module.ts
│  │  ├─ chatbot.service.ts
│  │  ├─ intent.service.ts
│  │  ├─ reply-template.service.ts
│  │  ├─ user-session.service.ts
│  │  └─ types/
│  │
│  ├─ line/
│  │  ├─ dto/
│  │  ├─ line.controller.ts
│  │  ├─ line.module.ts
│  │  ├─ line-reply.service.ts
│  │  └─ line-webhook.service.ts
│  │
│  ├─ pipeline/
│  │  ├─ pipeline.controller.ts
│  │  ├─ pipeline.module.ts
│  │  ├─ pipeline.service.ts
│  │  └─ types/
│  │
│  └─ registration/
│     ├─ registration.controller.ts
│     ├─ registration.module.ts
│     ├─ registration.service.ts
│     └─ types/
│
├─ app.module.ts
└─ main.ts
```

---

## Module responsibility

### line module

Responsible for LINE-specific logic.

```text
receive webhook
parse LINE event
extract userId and text
call chatbot/pipeline service
send reply to LINE
```

Controller must stay thin.

### chatbot module

Responsible for conversation routing.

```text
detect intent
read/update user session
route to registration flow
route to AI/general question flow
return reply text
```

### registration module

Responsible for registration business logic.

```text
start registration
collect required fields
validate input
detect missing fields
confirm data
create customer
generate username/password
return success response
```

### pipeline module

Responsible for future multi-channel message processing.

```text
normalize incoming events
store raw events
route messages to chatbot
support LINE/Facebook/Telegram later
```

---

## Important types

```ts
export type ConversationFlow =
  | 'REGISTER'
  | 'CHECK_STATUS'
  | 'CONTACT_ADMIN'
  | 'GENERAL_QUESTION';

export type ConversationStatus =
  | 'ACTIVE'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface ConversationSession<TData = Record<string, any>> {
  userId: string;
  flow: ConversationFlow;
  step: string;
  status: ConversationStatus;
  data: TData;
}
```

Current development may use in-memory `Map`.

Production should use Redis.

---

## Important rules for coding agents

When modifying this project:

```text
Keep controllers thin.
Put business logic in services.
Do not break LINE webhook support.
Use ConfigService for environment variables.
Use Prisma for PostgreSQL.
Use Mongoose for MongoDB chat history.
Use Redis for session state when available.
Use PostgreSQL as source of truth.
Use MongoDB only for chat logs/raw events.
Keep registration flow rule-based.
Use AI only for product/service Q&A unless explicitly changed.
Keep Thai customer replies natural and polite.
```

---

## Bootstrap notes

The app uses:

```text
NestJS Fastify adapter
Swagger at /docs
ZodValidationPipe
ConfigService
```

Use configured port:

```ts
const port = configService.get<number>('PORT') || 8080;
await app.listen(port, '0.0.0.0');
```

Do not hardcode:

```ts
await app.listen(8080, '0.0.0.0');
```

For PostgreSQL health check with Prisma:

```ts
await prisma.$connect();
await prisma.$queryRaw`SELECT 1`;
```

For MongoDB health check with Mongoose:

```ts
const mongoConnection = app.get<Connection>(getConnectionToken());
await mongoConnection.asPromise();
```

---

## Development priority

```text
1. Keep LINE webhook working.
2. Setup PostgreSQL with Prisma.
3. Setup MongoDB for chat history.
4. Setup Redis for session state.
5. Implement ChatbotService routing.
6. Implement RegistrationFlowService.
7. Save customer registration in PostgreSQL.
8. Save chat history in MongoDB.
9. Add AI product/service Q&A later.
10. Add admin dashboard APIs later.
```
