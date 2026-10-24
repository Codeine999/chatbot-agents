---
paths:
  - "src/modules/chatbot/**"
  - "src/modules/line/**"
  - "src/modules/admin/**"
  - "src/modules/registration/**"
---

# Conversation and admin handoff

- Redis sessions are temporary workflow state with a TTL; clear on completion/cancel.
- Context is bounded and PII-redacted.
- Registration state survives allowed digressions. Don't overwrite registration
  data to represent handoff.
- `waiting_admin` = durable "admin requested", NOT an AI mute; AI keeps replying.
  A real admin reply sets a separate Redis mute (TTL); expiry re-enables AI.
  When LINE accepts the admin reply, `waiting_admin` → `open`.
  Resume-bot clears the mute, sets `open`, and clears chat context.
- Respect `AdminMember.aiEnabled`.
- `AdminChatRequest.clientRequestId` makes admin AI turns idempotent; retries
  must not append duplicate messages.
- Admin routes need JWT + role guards; Socket.IO only for authenticated admins
  and approved origins.
