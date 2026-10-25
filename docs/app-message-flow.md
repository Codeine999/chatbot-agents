# App Message API — flow จริง (MVP, 25 ต.ค. 2026)

ช่องทางให้ web app / mobile app คุยกับบอทผ่าน REST โดยใช้ core chat ตัวเดียวกับ LINE แล้วเก็บห้องแชตให้แอดมินตอบจากหลังบ้าน
โค้ด: [src/modules/app-message/](../src/modules/app-message/) · ปิดไว้เป็นค่าเริ่มต้น (`APP_MESSAGE_ENABLED=false` ทุก route ของ guest ตอบ 404)
แผนเดิมและเหตุผลการออกแบบ: [feature/multi-chat.md](feature/multi-chat.md) (หัวข้อ 16 บอกสิ่งที่ตัดออกตอนทำเป็น MVP)

## 1. API

**Guest (public, ไม่มี role):** prefix `/api/app/v1`

| Method | Path | Header | ทำอะไร |
|---|---|---|---|
| POST | `/sessions` | – | สร้าง guest + `sessionToken` (แสดงครั้งเดียว) · body `{ displayName?, metadata? }` |
| GET | `/session` | `Authorization: Bearer ags_…` | `{ guestId, conversationId \| null, botMode, expiresAt }` |
| DELETE | `/session` | Bearer | revoke · อย่าส่ง `Content-Type: application/json` ถ้าไม่มี body (Fastify ตอบ 400) |
| POST | `/messages` | Bearer | `{ clientMessageId (uuid), text, metadata? }` → `{ message, replies[], meta }` |
| GET | `/messages?after=&limit=` | Bearer | ประวัติของห้องตัวเอง เก่า→ใหม่ · `nextCursor` = cursor ของข้อความล่าสุดที่ได้ (ไม่มีใหม่ = คืน `after` เดิม ใช้ poll ต่อได้) |

**Admin (JWT ทุก role, ผูกกับบริษัทของแอดมิน):** `GET /api/admin/app-conversations` (waiting_admin ก่อน แล้วใหม่สุด, 200 ห้อง) ·
`GET|POST /api/admin/app-conversations/:id/messages` (รูปแบบเดียวกับ LINE: `before`/`after`, `{ text, clientRequestId? }`) · `POST …/:id/resume-bot`

error ของ guest: `{ code, message, retryAfterSec? }` + `Retry-After` · ยกเว้น JSON เสียและ body เกิน 16KB ที่ Fastify ตัดก่อนถึง controller (`{ statusCode, message }`, ไม่มีรายละเอียดภายใน)

## 2. เส้นทางของข้อความ

```
POST /messages
 → AppClientGuard   ฟีเจอร์ปิด 404 · IP ถูกแบน 429 · Origin ไม่อยู่ใน APP_ALLOWED_ORIGINS 403
 → AppSessionGuard  token → sha256 → session ที่ยังไม่หมดอายุ/ไม่ถูก revoke (token ผิดนับเข้างบความผิดพลาดของ IP)
 → AppMessageService.send
      sanitize → AppAbuseService.assertMessage (ban contact → burst → รายวัน → ต่อ IP นาที/วัน → รวมทั้งระบบ/วัน → spam)
      → สร้างห้องถ้ายังไม่มี → clientMessageId เคยตอบแล้ว? คืนผลเดิม
      → lock ห้อง (activeTurnId = id ของข้อความ, หมดอายุ 120 วิ) ไม่ได้ = 409 BUSY
      → transaction: ข้อความขาเข้า + unread+1 (ครั้งเดียวต่อ clientMessageId)
 → MessageProcessorService.process(event, AppChannelAdapter, claim = id ของข้อความ)   ← ตัวเดียวกับ LINE
      ChatbotService.handleTextMessage(channel:'APP') → saveReply (transaction: ยัง lock อยู่ไหม + mute → คำตอบ + ปิดขาเข้า)
      → deliver = append context
 → ปลด lock → response จาก DB
```

ส่งเข้า core แค่ `userId=app:<contactId>`, `conversationId`, `turnId=app:<inboundId>`, `text`, `channel:'APP'` (metadata/displayName ไม่เข้า prompt)

**ล้มกลางทาง:** ข้อความขาเข้าค้าง `PROCESSING` · lock หมดอายุเอง · client ส่ง `clientMessageId` เดิมซ้ำ → ทำ turn ใหม่ด้วย `turnId` เดิม (billing ไม่หักซ้ำ) · turn เก่าที่ช้าจนเสีย lock บันทึกคำตอบไม่ได้

## 3. ต่างจาก LINE

| เรื่อง | LINE | App |
|---|---|---|
| คิว | BullMQ + webhook | ไม่มี ตอบใน HTTP response |
| ลำดับต่อห้อง | Map ใน process | lock ใน DB (`channelConversations.activeTurnId/activeUntil`) |
| กันซ้ำ | `ProcessedLineWebhookEvent`, `LineDelivery.key` | unique `(conversationId, clientMessageId)` + `replyToId` unique |
| ชน rate limit | ทิ้งเงียบ | 429 + `Retry-After` |
| Redis ล่ม | ผ่าน (fail open) | 503 (fail closed) |
| สมัครสมาชิก | ได้ | ปิด (`registerUnavailable`) |
| Product RAG | ใช้เมื่อมี `lineMemberId` | ข้าม |
| ขอคุยแอดมิน | `requestAdmin` หา `lineConversation` | `ChannelHandoffRegistry` → `AppHandoffHandler` (prefix `app:`) |
| ประวัติ | `line*` | `channel*` · **ลบหลัง `APP_HISTORY_RETENTION_DAYS` (7)** |

## 4. ข้อมูลและ retention

ตาราง: `channelContacts` (guest, `customerId` เตรียมไว้ผูกสมาชิกในอนาคต), `appGuestSessions`, `channelConversations`, `channelMessages`

`AppMaintenanceService` ทุก 1 ชม. (ทำงานแม้ปิดฟีเจอร์): ลบห้องที่เงียบเกิน retention (ยกเว้นห้องที่ถือ lock), ข้อความเก่ากว่า retention, notification ของ `app:*` ที่เก่ากว่า retention, session ที่หมดอายุ/revoke, guest ที่ไม่มี session และห้อง (ยกเว้นที่ผูก `customerId`)
**ไม่แตะ:** ตาราง `line*`, notification ของ LINE, `aiUsageEvents`/ledger/wallet

## 5. Environment

| ตัวแปร | default | |
|---|---|---|
| `APP_MESSAGE_ENABLED` | `false` | เปิดฟีเจอร์ |
| `APP_IP_HASH_SALT` | – | บังคับเมื่อเปิด (≥16 ตัว) |
| `APP_ALLOWED_ORIGINS` | ว่าง | โดเมนเว็บที่เรียกจากเบราว์เซอร์ได้ คั่นด้วย `,` (ว่าง = เบราว์เซอร์เรียกไม่ได้ แอปมือถือ/server ได้) |
| `TRUST_PROXY_HOPS` | `0` | production หลัง nginx = `1` (ดูหัวข้อ 8.2 ของแผนเรื่อง Cloudflare) |
| `APP_SESSION_TTL_DAYS` | 30 | sliding (เพดาน 180 วันฝังในโค้ด) |
| `APP_HISTORY_RETENTION_DAYS` | 7 | |
| `APP_SESSION_CREATE_PER_IP_HOUR` | 30 | |
| `APP_MSG_BURST_PER_CONTACT` | 10 | ต่อ 10 วินาที |
| `APP_MSG_DAILY_PER_CONTACT` | 300 | |
| `APP_MSG_PER_IP_MIN` / `APP_MSG_DAILY_PER_IP` | 30 / 2000 | รวมทุก session ของ IP |
| `APP_MSG_DAILY_TOTAL` | 20000 | เพดานทั้งระบบต่อวัน (`0` = ไม่จำกัด) |

ค่าคงที่ในโค้ด (`APP_LIMITS`): session ต่อ IP ที่ใช้งานอยู่ 50, อ่านประวัติ 120/นาที/IP, token ผิด 30/นาที/IP, ข้อความยาวสุด 2000 ตัว, body 16KB, lock 120 วินาที

## 6. จุดที่แก้ core (ค่าเริ่มต้น = พฤติกรรมเดิม)

- `ChatRequest.channel?: 'LINE'|'APP'` → `ChatbotService.canRegister(preview, channel)`
- `ChannelHandoffRegistry` + `UserSessionService.requestAdmin` ส่งต่อ userId ที่มี prefix ของช่องอื่น
- `NotificationService.notifyChannelAdminRequired` (ใหม่) + `channel` ใน metadata ของ notification
- `RateLimitService.consume(..., { failOpen })` + ฟิลด์ `unavailable`
- `main.ts`: `trustProxy` จาก `TRUST_PROXY_HOPS`, body limit 16KB เฉพาะ `/api/app/*`, CORS ของ `/api/app/*` จาก `APP_ALLOWED_ORIGINS` (route อื่นใช้ตัวเลือกเดิม), `app.listen(port)`

## 7. ข้อจำกัดที่รู้

- usage ของ app ถูกบันทึกเป็น `LINE_AI_REPLY` scope `*` ปนกับ LINE (ยังไม่แยกงบ)
- ใครก็สร้าง guest ได้ (เหมือน chat widget ทั่วไป) · การป้องกันคือ rate limit/ban/เพดานรายวัน · botnet หลาย IP ใช้เพดานทั้งระบบได้จนหมดวัน
- ค่ายมือถือไทยใช้ CGNAT: IP เดียวอาจมีหลายคน → ดู log `app gate blocked layer=…` แล้วปรับ `APP_MSG_*_IP`
- fixed-window rate limit · ไม่มี push (client poll `GET /messages`)
- dashboard ยังไม่มีหน้า app: notification ที่ `metadata.channel === 'APP'` ต้องเปิดผ่าน `/api/admin/app-conversations`
- ต้องตรวจบน VPS: nginx/Cloudflare ส่ง IP จริง และ `core-api` ไม่ publish พอร์ตออกนอก (ไม่งั้นปลอม `X-Forwarded-For` ได้)

ดู log เพื่อปรับ limit:
```
docker compose logs core-api | grep "app gate blocked" | sed -E 's/.*layer=([a-z-]+) ip=([0-9a-f]+).*/\1 \2/' | sort | uniq -c | sort -rn | head
```
