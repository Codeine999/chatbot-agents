- NestJS
- TypeScript
- Prisma
- PostgreSQL
- LINE Messaging API

## Chat Flow Rules

Message priority:

1. CANCEL clears the current session.
2. ACTIVE sessions must continue the current flow.
3. New intents are handled only when there is no active session.
4. Do not restart REGISTER if the user is already in an active REGISTER flow.
5. AI must not perform or confirm business actions unless backend data verifies them.

Main flow:

User message -> IntentService -> ChatbotService -> UserSessionService -> RegistrationFlowService or AiChatService -> ReplyTemplateService

## Intents

- REGISTER: customer registration
- AI_CHAT: AI support chat
- GENERAL_QUESTION: general question
- CONTACT_ADMIN: planned admin handoff
- CHECK_STATUS: planned status check
- CANCEL: clear session
- UNKNOWN: fallback

## Database Summary

PostgreSQL via Prisma.

Main entities:

- Member: customer profile, login, phone, bank info, account status
- Payment: payment records and approval status
- AiSetting: AI prompt/tone/fallback config
- AnswerPattern: FAQ/knowledge-base answers
- CreditWallet: usage credit tracking
- LineMember: LINE profile linked to Member
- LineConversation: conversation summary
- LineChatHistory: full chat logs

Relations:

- Member -> many Payments
- Member -> many LineMembers
- LineMember -> one LineConversation
- LineMember/LineConversation -> many LineChatHistories

## Coding Rules

- Keep controllers thin.
- Put business logic in services.
- Use session state for multi-step flows.
- Keep intent detection deterministic.
- Do not expose secrets.
- Do not run destructive commands unless explicitly requested.
- Do not change Prisma schema unless requested.