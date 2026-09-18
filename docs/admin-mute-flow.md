# Admin assistance and timed mute

## Contract

- A request for an admin sets durable `LineConversation.status=waiting_admin` and exposes `requireAdmin=true`. It does not mute AI or replace registration data.
- The transition to waiting_admin emits `ADMIN_NOTIFICATION` to authenticated sockets on `/admin`, title `มีลูกค้าต้องการคำตอบจากแอดมินในขณะนี้`. Repeated requests while waiting do not send duplicates. Delivery is best-effort; the persisted waiting queue remains available if socket notification fails.
- `POST /api/line/conversations/:conversationId/messages` (also `/api/conversations/:conversationId/messages`) requires an admin JWT and validated message DTO. Use the same `clientRequestId` on retry.
- Before each actual admin PUSH attempt, write `chat:control:<lineUserId>=ADMIN` with `SET EX`. `AUTO_MUTE_WHEN_REPLY=10m` defaults to ten minutes; integer values are seconds, `s` and `m` suffixes supported. Restart processes after changing environment.
- Redis reads never refresh control TTL. Each push resets the whole TTL, without accumulation. Ordinary workflow session TTL is independent.
- ADMIN/PAUSE blocks text (including empty, long and cancel), image and sticker processing before AI/RAG. Automatic queued delivery checks the mute again before sending; suppressed deliveries are FAILED with an explicit reason.
- Expiry means effective controlMode=AI on the next read. No cron or mutation of registration is necessary. A waiting assistance request stays visible until resolved.
- `POST /api/line/conversations/:conversationId/resume-bot` requires admin authentication, deletes the control key, marks the request open and clears AI context. Registration is retained.
- cancel/ยกเลิก/ออก clears only active registration. It never releases mute. Outside registration it acknowledges cancel without changing stored state.

## Failure and deployment notes

- If Redis cannot set mute, admin delivery does not send and the durable delivery retry policy applies. A rejected/uncertain push keeps mute until expiry or explicit resume; this avoids prematurely restarting automation.
- Accepted delivery replay does not resend or extend mute. Automatic REPLY-to-PUSH fallback does not mute.
- Old workflow `controlMode=ADMIN` and legacy `requiAdmin` are not authorities for mute after rollout. Existing waiting_admin rows become requests only; new control keys establish timed mute. Deploy all workers together to avoid mixed policy.
- This remains the existing single-company deployment; no ownership or billing model migration is performed.
- A provider/LINE call already in flight cannot be recalled; a small interval between the final mute check and the network send remains. This is not a distributed exclusion lock.
- Socket authentication is present. The existing gateway uses wildcard CORS; tightening origin configuration is a separate outstanding audit finding.

## Verification

Automated tests mock external boundaries: workflow preservation, duplicate requests, TTL refresh/expiry, manual resume, cancel scope, mute-before-push, Redis failure, automatic delivery suppression and ordinary automatic PUSH. No live LINE or AI calls are used.
