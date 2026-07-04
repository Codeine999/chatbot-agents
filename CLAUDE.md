## Tech Stack

* NestJS
* TypeScript
* Prisma
* PostgreSQL
* LINE Messaging API

---

## Chatbot Architecture

```txt
LINE User Message
  -> LINE Messaging API Webhook
  -> LineController
  -> LineWebhookService
  -> ChatbotService.handleTextMessage(userId, text)
  -> UserSessionService.get(userId)
  -> IntentRouterService.resolve({ userId, input, session })
      -> RuleIntentService.detect(input)
      -> AiIntentClassifierService.analyze(input) // only when rule confidence is low
  -> Route by decision.action
      -> CANCEL_SESSION    -> UserSessionService.clear()
      -> START_REGISTER    -> RegistrationService.start()
      -> START_AI_CHAT     -> UserSessionService.set(AI_CHAT)
      -> CONTINUE_AI_CHAT  -> AiChatService.answerGeneral()
      -> ANSWER_KNOWLEDGE  -> AiChatService.answerCustomer()
      -> ANSWER_GENERAL    -> AiChatService.answerGeneral()
      -> CONTACT_ADMIN     -> ReplyTemplateService.contactAdmin()
      -> CHECK_STATUS      -> ReplyTemplateService.statusUnavailable()
      -> DEFAULT           -> ReplyTemplateService.defaultMessage()
```

---

## Intent Routing Rules

The chatbot uses **rule-first routing**.

```txt
1. Empty message
   -> default reply

2. CANCEL
   -> clear active session immediately

3. Active session
   -> continue current flow

4. High-confidence rule
   -> if rule.confidence >= 0.9
   -> use rule result

5. Low-confidence rule
   -> call AiIntentClassifierService
   -> use AI confidence / flags to decide action
```

---

## AI Routing Rules

AI is used only when rule detection is not confident enough.

```txt
if ai.confidence < 0.6:
  -> ANSWER_GENERAL

if ai.needsBusinessData:
  -> CHECK_STATUS

if ai.needsKnowledgeSearch:
  -> ANSWER_KNOWLEDGE

else:
  -> ANSWER_GENERAL
```

Rules:

* AI only classifies intent; it must not execute business actions.
* AI must not confirm registration, payment, approval, or account status without backend verification.
* Business-related questions must be routed to backend/admin verification.
* Knowledge-base questions must use `AiChatService.answerCustomer()`.
* Casual/general questions must use `AiChatService.answerGeneral()`.

---

## Supported Intents

| Intent             | Description              |
| ------------------ | ------------------------ |
| `REGISTER`         | Customer registration    |
| `AI_CHAT`          | AI support chat          |
| `GENERAL_QUESTION` | General question         |
| `CONTACT_ADMIN`    | Admin handoff            |
| `CHECK_STATUS`     | Customer/status checking |
| `CANCEL`           | Clear current session    |
| `UNKNOWN`          | Fallback intent          |

---

## RouteDecision

`IntentRouterService` returns a normalized decision.

```ts
{
  action: ChatAction;
  intent: ChatIntent;
  confidence: number;
  source: 'RULE' | 'AI' | 'SESSION';
  reason: string;
}
```

`ChatbotService` only routes by `decision.action`.

---

## Database Summary

Database: PostgreSQL
ORM: Prisma

| Entity          | Purpose                                                       |
| --------------- | ------------------------------------------------------------- |
| `Member`        | Customer profile, login, phone, bank info, and account status |
| `Payment`       | Payment records and approval status                           |
| `AiSetting`     | AI prompt, tone, fallback, and behavior configuration         |
| `AnswerPattern` | Knowledge-base answers                                        |
| `CreditWallet`  | Usage credit tracking                                         |
| `LineMember`    | LINE profile linked to a `Member`                             |

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
