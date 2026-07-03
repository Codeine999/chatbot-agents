NestJS
TypeScript
Prisma
PostgreSQL
LINE Messaging API

Chatbot Architecture

End-to-End Chat Flow
LINE User Message
  -> LINE Messaging API Webhook
  -> LineController
  -> LineWebhookService
  -> ChatbotService.handleTextMessage(userId, text)
  -> UserSessionService.get(userId)
  -> IntentRouterService.resolve({ userId, input, session })
      -> Rule-based intent detection
      -> AiIntentClassifierService
      -> confidence / source / reason
  -> Route by decision.action
      -> CANCEL_SESSION       -> UserSessionService.clear()
      -> CONTINUE_REGISTER    -> RegistrationService.handle()
      -> START_REGIST
ER       -> RegistrationService.start()
      -> START_AI_CHAT        -> UserSessionService.set(AI_CHAT)
      -> CONTINUE_AI_CHAT     -> AiChatService.answerGeneral()
      -> ANSWER_KNOWLEDGE     -> AiChatService.answerCustomer()
      -> ANSWER_GENERAL       -> AiChatService.answerGeneral()
      -> CONTACT_ADMIN        -> ReplyTemplateService.contactAdmin()
      -> CHECK_STATUS         -> ReplyTemplateService.statusUnavailable()
      -> DEFAULT              -> ReplyTemplateService.defaultMessage()
Chat Flow Rules

Empty messages return the default reply.
CANCEL_SESSION clears the active session immediately.
Active sessions must be passed into IntentRouterService.resolve().
The router decides whether to continue a session or start a new flow.
Do not restart REGISTER if the user is already in an active REGISTER session.
RegistrationService handles registration state and steps.
AiChatService.answerCustomer() is for grounded knowledge-base answers.
AiChatService.answerGeneral() is for casual or general AI replies.
AI must not confirm business actions unless backend data verifies them.
ChatbotService only routes by decision.action; business logic stays in services.


The chatbot supports the following intents:

Intent	Description
REGISTER	Customer registration flow
AI_CHAT	AI support chat
GENERAL_QUESTION	General user questions
CONTACT_ADMIN	Planned admin handoff
CHECK_STATUS	Planned customer/payment/status checking
CANCEL	Clear current session
UNKNOWN	Fallback intent
Database Summary

Database: PostgreSQL
ORM: Prisma

Main entities:

Entity	Purpose
Member	Customer profile, login, phone, bank info, and account status
Payment	Payment records and approval status
AiSetting	AI prompt, tone, fallback, and behavior configuration
AnswerPattern	knowledge-base answers
CreditWallet	Usage credit tracking
LineMember	LINE profile linked to a Member


Coding Rules
Keep controllers thin.
Put business logic in services.
Use session state for multi-step flows.
Keep intent detection deterministic.
Do not expose secrets, tokens, or credentials.
Do not run destructive commands unless explicitly requested.
Do not change the Prisma schema unless explicitly requested.
Do not let AI confirm registration, payment, approval, or account status without backend verification.