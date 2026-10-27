# Multi-channel chat: App Message API (phase 1)

สถานะ: **ทำเป็น MVP แล้ว (25 ต.ค. 2026)** · โค้ดจริงต่างจากแผนนี้ตามหัวข้อ 15–16 (ตัด ChatApplication/X-App-Key, lease, ตัวจำกัด turn ฯลฯ) · flow ที่ใช้จริงอยู่ใน [app-message-flow.md](../app-message-flow.md) ซึ่งเชื่อถือได้มากกว่าไฟล์นี้ · Step 14 (แยกงบ AI) และ 15 (frontend) ยังไม่ทำ · ยังไม่ได้ commit/deploy
ไฟล์นี้เขียนให้ AI/นักพัฒนาอ่านแล้วทำตามทีละ Step โดยไม่ต้องเดา ให้ทำตามลำดับและอย่าข้าม "เสร็จเมื่อ" ของแต่ละ Step

---

## 0. วิธีใช้ไฟล์นี้ (อ่านก่อนเริ่ม)

1. อ่านหัวข้อ 1–8 ให้จบก่อน แล้วทำหัวข้อ 9 ทีละ Step
2. ทำทีละ Step ต่อ 1 PR/commit ห้ามรวม Step
3. ก่อนแก้ไฟล์เดิมทุกครั้ง ให้อ่านไฟล์นั้นทั้งไฟล์ และ `grep` หาผู้เรียกใช้
4. ถ้าสิ่งที่เจอในโค้ดไม่ตรงกับแผน **หยุดและถามผู้ใช้** อย่าเดา
5. ช่อง "ผลจริง" ในหัวข้อ 10 ให้ผู้ทำกรอกหลังรันเทสต์: ถ้าเทสต์ **fail แสดงว่าช่องโหว่มีจริง ให้แก้ใน Step เดียวกันทันที** แล้วรันซ้ำจนผ่าน
6. ห้ามบอกว่าเทสต์ผ่านถ้าไม่ได้รันจริง

### กฎที่ต้องไม่ทำผิด (สรุปจาก CLAUDE.md / AGENTS.md)

- **พฤติกรรมของ LINE ต้องเหมือนเดิมทุกอย่าง** ห้ามแก้ตาราง `line*`, `processedLineWebhookEvent`, คิว BullMQ ของ LINE, `LineChannelAdapter`, `LineEventsProcessor` การแก้ไฟล์ core ที่แชร์กัน (หัวข้อ 7.3) ต้องเป็น **optional parameter ที่ค่าเริ่มต้นเท่ากับพฤติกรรมเดิม** และมีเทสต์ยืนยัน
- Controller ทำแค่ auth → validate → เรียก service → ตอบ ไม่มี business logic
- ห้ามเรียก AI/provider/LINE ใน DB transaction
- ห้ามส่ง PII (ข้อความ guest ที่มีเบอร์/อีเมล) ไปที่ AI นอกเหนือจากที่ core เดิมทำอยู่ · ห้าม log token, IP จริง, ข้อความลูกค้าดิบ (log เฉพาะ id และ ipHash)
- ห้ามใช้ `any` กับ request body · validate ด้วย zod (`nestjs-zod` `createZodDto`) ตามแบบ `src/modules/line/dto/line-admin.dto.ts`
- ห้ามคืน error ภายในให้ client · ห้ามคืน `costThb`, สถานะ wallet
- ห้ามแก้ `src/generated/` ด้วยมือ · ห้ามใช้ `prisma db push`
- ใช้ `bun` ไม่ใช่ `npm` · คำสั่งตรวจ: `bunx tsc --noEmit`, `npx eslint <ไฟล์ที่แก้>` (**อย่าใช้ `bun run lint`** เพราะมี `--fix` แก้ไฟล์อื่นของผู้ใช้), `bun run test -- <ชื่อ>`, `bun run build`
- **baseline ก่อนเริ่ม:** รัน `bunx tsc --noEmit` และ `bun run test` บันทึกจำนวน error และ suite ที่ fail อยู่แล้วไว้ (มี suite ที่ fail อยู่ก่อนแล้ว) หลังแต่ละ Step ต้อง **ไม่มี error/fail เพิ่ม**

### โครงสร้างแบบ feature-based (NestJS)

- โค้ดของฟีเจอร์นี้อยู่ใน `src/modules/app-message/` โฟลเดอร์เดียว (kebab-case) มี `app-message.module.ts` เป็นทางเข้า
- ชื่อไฟล์: `<ชื่อ>.controller.ts`, `<ชื่อ>.service.ts`, `<ชื่อ>.guard.ts`, `dto/<ชื่อ>.dto.ts`, เทสต์ `<ชื่อ>.spec.ts` วางข้างไฟล์
- feature อื่นห้าม import ไฟล์ข้างใน `app-message/` ยกเว้นผ่านสิ่งที่ module `exports`
- ของที่ใช้ร่วมหลาย feature อยู่ที่เดิม (`RateLimitService`, `BanService`, `SpamDetectorService`, `MessageProcessorService`, `ChatbotService`) ใช้ผ่าน DI ห้ามสร้างตัวทำซ้ำ
- คอมเมนต์เขียนเฉพาะจุดที่ไม่ชัดจากโค้ด (idempotency, lock, race) ไม่ต้องอธิบายโค้ดตรง ๆ

---

## 1. เป้าหมายและขอบเขต

**ทำใน phase 1**
- REST API ให้ web app / mobile app / ระบบภายนอกส่งข้อความเข้าบอท
- ผู้ใช้เป็น **guest**: ขอ session ก่อน แล้วแนบ token มากับทุกข้อความ
- ตอบแบบ request/response · response มี `meta` และ**ทุกข้อความมี `metadata`** (คำตอบบอท: ข้อมูลจาก server · ข้อความ guest: ข้อมูลจาก client) เผื่อทำฟีเจอร์ใหม่ (หัวข้อ 4.1)
- **ลบประวัติแชตของ guest ที่เก่ากว่า 7 วัน**อัตโนมัติ (หัวข้อ 9 Step 11)
- ข้อความเข้า **core chat เดิม** (router → knowledge/RAG → AI → credit gate) ด้วย logic เดียวกับ LINE
- เก็บประวัติแยกจาก LINE · แอดมินเห็นและตอบได้จากหน้า inbox
- rate limit และกันสแปมหลายชั้น (หัวข้อ 8)
- จัดการ `ChatApplication` ผ่าน REST (ไม่มีหน้า dashboard)

**ไม่ทำใน phase 1**
- สมัครสมาชิกผ่าน app (แต่ **เตรียมคอลัมน์ไว้** ให้ map guest → customer ได้ทีหลัง)
- โหมด server-to-server (secret key + user id ของระบบลูกค้า)
- รูปภาพ, sticker, postback/rich menu บน app
- Product RAG บน app (ข้อความเกี่ยวกับสินค้าจะตอบจาก knowledge เท่านั้น เหมือนที่ core ทำเมื่อไม่มี lineMemberId)
- SaaS หลายบริษัท (ทุกตารางมี `companyId` ไว้แล้ว แต่ระบบยังเป็นบริษัทเดียวต่อ deploy)
- Facebook / Shopee / TikTok (ออกแบบให้เพิ่มได้ ดูหัวข้อ 12)

---

## 2. การตัดสินใจหลัก

| เรื่อง | เลือก | เหตุผล |
|---|---|---|
| ตาราง guest | `ChannelContact` (ไม่ใช่ `Customer`) | `Customer` คือตัวตนที่ยืนยันแล้ว guest สร้างได้ไม่จำกัด · pattern เดียวกับ `LineMember` ที่มี `customerId` nullable |
| ชื่อตาราง | `Channel*` สำหรับสิ่งที่ทุกช่องทางมี · `App*`/`ChatApplication` เฉพาะ app | เพิ่ม Facebook/Shopee ได้โดยไม่ต้องสร้างตารางชุดใหม่ |
| ตาราง LINE | ไม่แตะ | invariant ของ LINE อยู่บนตารางเหล่านั้น |
| ประวัติแชต | ตาราง `ChannelConversation` / `ChannelMessage` ของเราเอง | แอดมินเห็นผ่าน endpoint `/api/admin/app-conversations` |
| session | guest token (opaque) เก็บแค่ sha256 · sliding 30 วัน · เพดานสูงสุด 180 วัน | revoke ได้ ไม่ต้องมี JWT |
| คิว | **ไม่ใช้ BullMQ ใน phase 1** (ดูหัวข้อ 2.1) | |
| retry | `clientMessageId` + lease ใน DB + billing replay ด้วย `turnId` | retry ด้วย id เดิมได้คำตอบเดิม ไม่หักเงินซ้ำ |
| ลำดับข้อความต่อห้อง | lock ใน DB (`activeTurnId`/`activeUntil`) | lock ใน memory ใช้ไม่ได้เมื่อมีหลาย instance |
| เข้า pipeline | `MessageProcessorService.process()` เดิม + `AppChannelAdapter` | path เดียวกับ LINE |
| ฟีเจอร์แฟลก | `APP_MESSAGE_ENABLED` (default `false`) | deploy โค้ดและ migration ได้โดยไม่เปิดใช้ |
| IP | เก็บ/ใช้เฉพาะ `ipHash` (sha256 + salt) | IP เป็นข้อมูลส่วนบุคคล |
| IP จริงหลัง Cloudflare | nginx `real_ip_header CF-Connecting-IP` เฉพาะคำขอจาก IP ของ Cloudflare + เขียนทับ `X-Forwarded-For` · app `TRUST_PROXY_HOPS=1` | production มี Cloudflare (proxy เปิดอยู่ ตรวจจาก DNS แล้ว) → nginx → app (หัวข้อ 8.2) |
| metadata | เก็บใน `ChannelMessage.metadata` ทั้งขาเข้าและขาออก · แอดมินเห็นทั้งคู่ · **ไม่ส่งเข้า AI** | ผู้ใช้ต้องการ metadata ใน response เป็นหลัก และเก็บของ user ไว้ทำฟีเจอร์ใหม่ |
| เก็บประวัติ | ข้อความ guest เก่ากว่า `APP_HISTORY_RETENTION_DAYS` (7) ถูกลบ · ข้อมูล billing ไม่ลบ | ผู้ใช้กำหนด 7 วัน · session ยังอยู่ได้ 30 วัน (ตัวตน/แบนคงอยู่ แต่ประวัติเก่ากว่า 7 วันหาย) |

### 2.1 ต้องใช้คิวไหม

**ไม่ต้องใน phase 1** เพราะ:
- LINE ต้องใช้คิวเพราะต้องตอบ webhook ให้เร็ว แล้วส่งข้อความตามหลัง (push/reply) ส่วน app รอผลใน HTTP response ได้
- คิว LINE (`LineEventJobData`, `processedLineWebhookEvent`) ผูกกับ event ของ LINE ใช้ซ้ำไม่ได้

สิ่งที่ **ต้องมีแทนคิว** (กันปริมาณข้อความมากเกินตัว):
- ตัวจำกัดจำนวน turn ที่กำลังประมวลผลพร้อมกัน (`AppTurnLimiter`, ค่า `APP_MAX_INFLIGHT_TURNS`) เกินแล้ว 429 `APP_BUSY` + `Retry-After`
- lock ต่อห้อง · rate limit ต่อ contact/IP/app (หัวข้อ 8)

**เมื่อไหร่ควรเปลี่ยนเป็นคิว** (ทำภายหลังได้โดยไม่ต้องแก้ schema เพราะมี `status`/`leaseOwner` อยู่แล้ว):
- p95 ของ turn เกิน ~25 วินาที (ชน timeout ของ nginx/client) หรือ `APP_BUSY` เกิดบ่อย
- ต้องการ push ให้ client (WebSocket/SSE)
- วิธี: POST ตอบ `202` + `GET /messages/:id` ดูสถานะ, worker BullMQ queue `app-messages` ใช้ `jobId = inboundMessageId` เรียก `MessageProcessorService.process()` ตัวเดิม

### 2.2 ตัวระบุที่ส่งเข้า core

| ค่า | รูปแบบ | ใช้เป็น |
|---|---|---|
| `userId` | `app:<contactId>` | key ของ session/mute/ban/spam ใน Redis · prefix ไม่ชนกับ LINE (`U…`) และ preview (`preview:…`) |
| `conversationId` | `ChannelConversation.id` | key ของ context ใน Redis · เก็บใน `aiUsageEvents.conversationId` |
| `turnId` | `app:<inboundMessageId>` | billing idempotency (`usage:app:<id>:<hash>`) |
| ban/strike ของ IP | `appip:<ipHash>` | ใช้กับ `BanService` ตัวเดิม |

`lineMemberId` **ไม่ส่ง** (ว่าง) → Product RAG ถูกข้ามตามที่ core ทำอยู่แล้ว ([product-retrieval.service.ts:90](../../src/modules/chatbot/knowledge/product/product-retrieval.service.ts))

---

## 3. Schema

ไฟล์ใหม่: `prisma/models/channel/channel.prisma` (โฟลเดอร์ `prisma/models/*` ถูกโหลดอัตโนมัติ ดูตัวอย่าง `prisma/models/line/lineChannel.prisma`)

```prisma
enum ChatChannel {
  APP
}

enum ChannelMessageSender {
  USER   @map("user")
  ADMIN  @map("admin")
  AI     @map("ai")
  SYSTEM @map("system")
}

/// แอป/เว็บที่เชื่อมเข้ามา 1 แถวต่อ 1 แอป
model ChatApplication {
  id             String   @id @default(uuid()) @db.Uuid
  companyId      String   @db.Uuid
  company        Company  @relation(fields: [companyId], references: [id], onDelete: Restrict)
  name           String   @db.VarChar(100)
  /// เปิดเผยได้ (อยู่ในโค้ดฝั่ง client) ไม่ใช่ความลับ
  publicKey      String   @unique @db.VarChar(64)
  /// Origin ที่ browser ใช้เรียกได้ ว่าง = ไม่อนุญาตคำขอที่มี Origin
  allowedOrigins String[] @default([])
  status         String   @default("ACTIVE") @db.VarChar(20) // ACTIVE | DISABLED
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  contacts ChannelContact[]

  @@index([companyId])
  @@map("chatApplications")
}

/// ผู้ติดต่อบนช่องทางที่ไม่ใช่ LINE (คู่ขนานกับ LineMember) guest = 1 แถว
model ChannelContact {
  id             String           @id @default(uuid()) @db.Uuid
  companyId      String           @db.Uuid
  company        Company          @relation(fields: [companyId], references: [id], onDelete: Restrict)
  channel        ChatChannel
  applicationId  String?          @db.Uuid
  application    ChatApplication? @relation(fields: [applicationId], references: [id], onDelete: Restrict)
  /// id ของผู้ใช้บนแพลตฟอร์มภายนอก (Facebook PSID ฯลฯ) ว่างสำหรับ guest
  externalUserId String?          @db.VarChar(255)
  displayName    String?          @db.VarChar(100)
  /// ข้อมูลเสริมจาก client ไม่น่าเชื่อถือ ห้ามส่งเข้า prompt
  metadata       Json?
  /// เตรียมไว้: ผูกกับบัญชีที่สมัครจริงเมื่อเปิดฟีเจอร์สมัคร (ยังไม่ใช้)
  customerId     String?          @db.Uuid
  customer       Customer?        @relation(fields: [customerId], references: [id], onDelete: Restrict)
  lastActiveAt   DateTime?
  createdAt      DateTime         @default(now())
  updatedAt      DateTime         @updatedAt

  sessions     AppGuestSession[]
  conversation ChannelConversation?
  messages     ChannelMessage[]

  @@unique([applicationId, externalUserId])
  @@index([companyId, channel, lastActiveAt])
  @@index([customerId])
  @@index([createdAt])
  @@map("channelContacts")
}

/// token ของ guest (เฉพาะ App) 1 contact มีได้หลาย session
model AppGuestSession {
  id         String         @id @default(uuid()) @db.Uuid
  companyId  String         @db.Uuid
  company    Company        @relation(fields: [companyId], references: [id], onDelete: Restrict)
  contactId  String         @db.Uuid
  contact    ChannelContact @relation(fields: [contactId], references: [id], onDelete: Cascade)
  /// sha256(hex) ของ token ไม่เก็บ token จริง
  tokenHash  String         @unique @db.VarChar(64)
  /// sha256(ip + salt) ตัดเหลือ 32 ตัว ใช้นับ session ต่อ IP
  ipHash     String         @db.VarChar(32)
  expiresAt  DateTime
  revokedAt  DateTime?
  lastSeenAt DateTime?
  createdAt  DateTime       @default(now())

  @@index([contactId])
  @@index([expiresAt])
  @@index([ipHash, expiresAt])
  @@map("appGuestSessions")
}

model ChannelConversation {
  id            String         @id @default(uuid()) @db.Uuid
  companyId     String         @db.Uuid
  company       Company        @relation(fields: [companyId], references: [id], onDelete: Restrict)
  channel       ChatChannel
  contactId     String         @unique @db.Uuid
  contact       ChannelContact @relation(fields: [contactId], references: [id], onDelete: Cascade)
  status        String         @default("open") @db.VarChar(20) // open | waiting_admin
  lastMessage   String
  lastMessageAt DateTime
  unreadCount   Int            @default(0)
  /// lock ต่อห้อง: มีข้อความที่กำลังตอบอยู่ได้ทีละ 1 (ใน DB ใช้ได้หลาย instance)
  activeTurnId  String?        @db.Uuid
  activeUntil   DateTime?
  createdAt     DateTime       @default(now())
  updatedAt     DateTime       @updatedAt

  messages ChannelMessage[]

  @@index([companyId, channel, lastMessageAt])
  @@index([status])
  /// ใช้หาห้องที่เงียบเกิน retention
  @@index([channel, lastMessageAt])
  @@map("channelConversations")
}

model ChannelMessage {
  id              String               @id @default(uuid()) @db.Uuid
  companyId       String               @db.Uuid
  company         Company              @relation(fields: [companyId], references: [id], onDelete: Restrict)
  conversationId  String               @db.Uuid
  conversation    ChannelConversation  @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  contactId       String               @db.Uuid
  contact         ChannelContact       @relation(fields: [contactId], references: [id], onDelete: Cascade)
  sender          ChannelMessageSender
  messageType     String               @default("TEXT") @db.VarChar(20)
  text            String?
  /// idempotency key จาก client (ข้อความ admin ใช้ "admin:<clientRequestId>")
  clientMessageId String?              @db.VarChar(64)
  /// คำตอบบอทชี้กลับไปข้อความขาเข้า 1:1 (ไม่มี FK ตั้งใจ ใช้ unique กันซ้ำ)
  replyToId       String?              @unique @db.Uuid
  /// ขาเข้า: PROCESSING | ANSWERED | NO_REPLY | FAILED · ขาออก: SENT
  status          String               @db.VarChar(20)
  /// AI | KNOWLEDGE | RULE | SYSTEM | REGISTRATION (จาก ChatResponse.source)
  source          String?              @db.VarChar(20)
  leaseOwner      String?              @db.Uuid
  leaseUntil      DateTime?
  attempts        Int                  @default(0)
  lastError       String?
  sentByAdminId   String?              @db.Uuid
  sentByAdmin     AdminMember?         @relation(fields: [sentByAdminId], references: [id], onDelete: SetNull)
  /// เฉพาะคำตอบบอท: ข้อมูลสำหรับ append context หลังส่งสำเร็จ (เหมือน LineDelivery.context)
  turnContext     Json?
  finalizedAt     DateTime?
  /// ขาเข้า (USER): ค่าจาก client ไม่น่าเชื่อถือ ห้ามเข้า prompt
  /// ขาออก (AI/SYSTEM): สร้างโดย server จาก whitelist เท่านั้น (หัวข้อ 4.1)
  metadata        Json?
  createdAt       DateTime             @default(now())

  @@unique([conversationId, clientMessageId])
  @@index([conversationId, createdAt, id])
  @@index([status, leaseUntil])
  /// ใช้ลบข้อความเก่ากว่า retention
  @@index([createdAt])
  @@map("channelMessages")
}
```

ต้องเพิ่ม relation ฝั่งตารางเดิม (เพิ่มบรรทัดเดียวต่อ model ห้ามแก้อย่างอื่น):
- `Company` ([prisma/schema.prisma](../../prisma/schema.prisma) ใกล้บรรทัด 122): `chatApplications ChatApplication[]`, `channelContacts ChannelContact[]`, `appGuestSessions AppGuestSession[]`, `channelConversations ChannelConversation[]`, `channelMessages ChannelMessage[]`
- `Customer` ([prisma/models/customers/customer.prisma](../../prisma/models/customers/customer.prisma)): `channelContacts ChannelContact[]`
- `AdminMember` ([prisma/models/admin/adminMember.prisma](../../prisma/models/admin/adminMember.prisma)): `sentChannelMessages ChannelMessage[]`

**หมายเหตุสำหรับอนาคต (ไม่ต้องทำตอนนี้):**
- สมัครสมาชิก: ตั้ง `ChannelContact.customerId` = customer ที่สร้าง และเพิ่มแถว `ChannelIdentity` (`channel=WEB`, `connectionKey=<applicationId>`, `externalUserId=<contactId>`) · `LineMember.customerId` มีอยู่แล้วในลักษณะเดียวกัน
- เพิ่ม Facebook: `ALTER TYPE "ChatChannel" ADD VALUE 'FACEBOOK'` + `externalMessageId` สำหรับ dedup (additive ทั้งหมด)

**Migration** (ตารางใหม่ล้วน ไม่ต้อง backfill · rollback = drop 5 ตาราง + 2 enum):
1. ตั้งชื่อโฟลเดอร์ `prisma/migrations/20261026000000_app_message_channel/migration.sql`
2. DB ในเครื่องอาจ drift จนต้อง reset **ห้ามตอบ yes ให้ reset** ให้สร้าง SQL ด้วย:
   `git archive HEAD prisma | tar -x -C <โฟลเดอร์ชั่วคราวใน scratchpad>` แล้ว `bunx prisma migrate diff --from-schema <ชั่วคราว>/prisma --to-schema prisma --script` คัดลอกผลลงไฟล์ migration (ครอบด้วย `BEGIN; … COMMIT;` ตามแบบ migration อื่น)
3. ตรวจ SQL ด้วยตา: ต้องมีแต่ `CREATE TYPE`, `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE … ADD CONSTRAINT` ของตารางใหม่ **ไม่มี `DROP`/`ALTER COLUMN` ของตารางเดิม**
4. `bunx prisma migrate deploy` (เฉพาะ DB ในเครื่อง) แล้ว `bun run db:generate`

---

## 4. API

ทุก endpoint ของ guest ใช้ prefix `/api/app/v1` · header บังคับ: `X-App-Key: pk_…` · ที่เหลือยกเว้นสร้าง session ต้องมี `Authorization: Bearer ags_…` · token ผูกกับ app ที่ออกให้ (ใช้ข้าม app ไม่ได้)

| Method | Path | Body / Query | Response |
|---|---|---|---|
| POST | `/sessions` | `{ displayName?, metadata? }` | 201 `{ sessionToken, guestId, expiresAt }` (token แสดงครั้งเดียว) |
| GET | `/session` | – | `{ guestId, conversationId \| null, botMode, expiresAt }` |
| DELETE | `/session` | – | 204 (revoke) |
| POST | `/messages` | `{ clientMessageId (uuid), text, metadata? }` | ดูด้านล่าง |
| GET | `/messages` | `?after=<cursor>&limit=` (limit 1–100 default 30) | `{ items, nextCursor }` |

POST `/messages` response:
```json
{
  "message": { "id": "…", "sender": "user", "text": "…", "metadata": { "page": "/pricing" }, "createdAt": "…" },
  "replies": [{
    "id": "…", "sender": "ai", "text": "…", "createdAt": "…",
    "metadata": { "v": 1, "source": "KNOWLEDGE", "handoff": false, "products": [] }
  }],
  "meta": { "status": "ANSWERED", "source": "KNOWLEDGE", "handoff": false, "botMode": "auto" }
}
```
- item ใน `GET /messages` มี `metadata` รูปแบบเดียวกัน (ข้อความแอดมิน/ระบบ: `metadata` ของขาออก หรือ `null`)
- `meta.status`: `ANSWERED` (มีคำตอบ) | `NO_REPLY` (ไม่มีคำตอบ เช่น แอดมินรับช่วงอยู่ หรือบอทใช้งานไม่ได้) · `meta.source`: `AI|KNOWLEDGE|RULE|SYSTEM` · `meta.handoff`: ห้อง `waiting_admin` · `meta.botMode`: `auto|admin`
- `meta` มาจาก server เท่านั้น ห้ามมี `costThb`, สถานะเครดิต, id ภายใน (`sentByAdminId` ฯลฯ)
- `conversationId` ใน `GET /session` ว่างจนกว่าจะส่งข้อความแรก (ห้องถูกสร้างตอนข้อความแรก ไม่ใช่ตอนสร้าง session)

รูปแบบ error ทุกกรณี: `{ "code": "APP_…", "message": "…", "retryAfterSec"?: number }` + header `Retry-After` เมื่อมี `retryAfterSec`

| HTTP | code | เมื่อ |
|---|---|---|
| 200 | – | ตอบแล้ว หรือ retry ของข้อความที่ตอบแล้ว (ได้ผลเดิม) |
| 202 | `APP_MESSAGE_IN_PROGRESS` | `clientMessageId` เดิมยังประมวลผลอยู่ |
| 400 | `APP_VALIDATION` | ข้อมูลไม่ถูกต้อง |
| 401 | `APP_KEY_INVALID` / `APP_SESSION_INVALID` | key ไม่ถูกต้องหรือ app ถูกปิด (ตอบเหมือนกัน ไม่บอกว่าอย่างไหน) / token ไม่ถูกต้อง หมดอายุ หรือ revoke |
| 403 | `APP_ORIGIN_NOT_ALLOWED` | Origin ไม่อยู่ใน `allowedOrigins` |
| 404 | – | `APP_MESSAGE_ENABLED=false` |
| 409 | `APP_CONVERSATION_BUSY` | ห้องกำลังตอบข้อความอื่น |
| 409 | `APP_CLIENT_MESSAGE_ID_REUSED` | `clientMessageId` เดิมแต่ข้อความต่าง |
| 413 | – | body เกิน `APP_BODY_LIMIT_BYTES` |
| 429 | `APP_RATE_LIMITED` / `APP_BANNED` / `APP_TOO_MANY_SESSIONS` / `APP_BUSY` | ดูหัวข้อ 8 |
| 503 | `APP_UNAVAILABLE` | Redis/ระบบพื้นฐานใช้ไม่ได้ (rate limit ปิดกั้นเมื่อ Redis ล่ม) หรือ turn ล้มเหลวชั่วคราว (client retry ด้วย id เดิม) |

กฎ input:
- `text`: trim + ตัด control character (เว้น `\n`, `\t`) + normalize NFC · ว่างหลัง trim → 400 · ยาว ≤ `APP_TEXT_MAX_CHARS` (2000)
- `displayName`: ≤ 50 ตัว หลังตัด control character · `metadata`: object, key ตรง `^[a-zA-Z0-9_.-]{1,40}$`, ค่าเป็น string(≤200)/number/boolean, ≤ 20 key, JSON รวม ≤ 2048 ไบต์
- zod ทุก DTO ใช้ `.strict()` (ปฏิเสธ field แปลกปลอม)
- cursor ของ `GET /messages` = base64url(`<createdAt ISO>|<id>`) เรียงตาม `(createdAt, id)` · cursor ผิดรูปแบบ → 400

### 4.1 metadata ของข้อความ

| | ขาเข้า (guest ส่ง) | ขาออก (บอท/แอดมิน/ระบบ) |
|---|---|---|
| ที่มา | `metadata` ใน body ของ `POST /messages` | server สร้างเองด้วย `buildReplyMetadata()` ใน `app-message.metadata.ts` |
| ความน่าเชื่อถือ | **ไม่น่าเชื่อถือ** (client ใส่อะไรก็ได้ตามกฎ input) | เชื่อได้ |
| รูปแบบ | object แบน key/value ตามกฎ input ด้านล่าง | `{ v: 1, source, handoff, products: [{ productId }] }` (ข้อความแอดมิน: `{ v: 1, source: 'ADMIN' }`) |
| เข้า AI/prompt | **ไม่** | ไม่ (มาจากคำตอบอยู่แล้ว) |
| คืนให้ guest | ใช่ (ของตัวเองเท่านั้น) | ใช่ |
| แอดมินเห็น | ใช่ | ใช่ |

กฎของ `buildReplyMetadata(response, handoff)`:
- **สร้างจาก whitelist ทีละ field เท่านั้น** ห้าม spread object ของ core (`...response`) เพราะวันหน้า core อาจเพิ่ม field ภายในแล้วจะรั่วออกไปเอง
- `products` มาจาก `response.catalogRefs` เอาแค่ `productId` (ตัด `companyId` ฯลฯ ออก) ตอนนี้ app ไม่มี Product RAG จึงมักเป็น `[]`
- ห้ามมี `costThb`, เครดิต, `turnId`, id ของแอดมิน, prompt, คะแนน retrieval
- มี `v` (เวอร์ชันของรูปแบบ) เพิ่ม field ใหม่ได้โดยไม่ทำให้ client เดิมพัง · เปลี่ยนความหมายของ field เดิม = เพิ่ม `v`
- ขนาดหลัง `JSON.stringify` ≤ 4096 ไบต์ (เกิน = ตัด `products` ให้เหลือ 20 ตัวแรก)

ความเสี่ยงที่ต้องกัน (มีเทสต์ใน T21, T33):
- metadata ขาเข้าอาจมี `<script>` หรือ `javascript:` → dashboard ต้องแสดงเป็นข้อความธรรมดาเท่านั้น (ดู Step 15)
- metadata ขาเข้าอาจมี PII (เบอร์/อีเมล) → ห้าม log · ถูกลบตาม retention 7 วันพร้อมข้อความ

Admin (ใช้ JWT admin เดิม):

| Method | Path | role | ทำอะไร |
|---|---|---|---|
| GET/POST/PATCH | `/api/admin/chat-applications[/:id]` | owner, dev | จัดการแอป (POST คืน `publicKey`) |
| POST | `/api/admin/chat-applications/:id/rotate-key` | owner, dev | ออก `publicKey` ใหม่ (ของเก่าใช้ไม่ได้ทันที) |
| GET | `/api/admin/app-conversations?status=&cursor=&limit=` | ทุก role | รายการห้อง |
| GET | `/api/admin/app-conversations/:id/messages?before=&after=&limit=` | ทุก role | ประวัติ (รูปแบบเดียวกับ LINE) |
| POST | `/api/admin/app-conversations/:id/messages` | ทุก role | แอดมินตอบ `{ text, clientRequestId? }` |
| POST | `/api/admin/app-conversations/:id/resume-bot` | ทุก role | ให้บอทกลับมาตอบ |

---

## 5. Pipeline: ข้อความ app เข้า core อย่างไร

```
POST /api/app/v1/messages
 → guards (feature flag → app key → session)
 → AppAbuseService (ban, rate limit, spam)             หัวข้อ 8
 → AppMessageService.send
      claim ข้อความขาเข้า (idempotent) + lock ห้อง + จองช่อง turn
 → MessageProcessorService.process(event, AppChannelAdapter, leaseOwner)   ← ตัวเดิม ไม่แก้
      adapter.findDelivery         มีคำตอบแล้ว? → deliver แล้วจบ
      adapter.saveIncomingEvent    คืน thread (ไม่เขียนอะไร เพราะ service เขียนแล้ว)
      context.load(conversationId)
      adapter.toChatTurn           → ChatbotService.handleTextMessage(...)  ← ตัวเดิม
      context.clear ถ้า CLEAR
      adapter.saveReply            ใน transaction: ตรวจ lease → สร้างคำตอบ → ปิดข้อความขาเข้า
      adapter.deliver              append context (ไม่มีการส่งออก)
 → ปลด lock/ช่อง turn (finally) → อ่านผลจาก DB → response
```

### 5.1 `AppInboundEvent` (ชนิดของ event)
```ts
type AppInboundEvent = Readonly<{
  messageId: string;      // ChannelMessage.id ของข้อความขาเข้า
  conversationId: string;
  contactId: string;
  companyId: string;
  text: string;
}>;
type AppThread = Readonly<{ conversationId: string }>;   // extends ConversationThread
```

### 5.2 `AppChannelAdapter implements ChannelAdapter<AppInboundEvent, AppThread>`

| method | ทำอะไร (ละเอียด) |
|---|---|
| `findDelivery(event)` | `channelMessage.findUnique({ where: { replyToId: event.messageId }, select: { id: true } })` → คืน `{ id }` หรือ `null` |
| `saveIncomingEvent(event)` | **ไม่เขียน DB** (service เพิ่มข้อความขาเข้าและ unread ไปแล้วใน transaction เดียวกัน เพื่อให้นับครั้งเดียว) คืน `{ conversationId: event.conversationId }` |
| `toChatTurn(event, thread)` | คืน `{ kind: 'text', contextUserText: event.text, request: { userId: 'app:' + event.contactId, conversationId: thread.conversationId, turnId: 'app:' + event.messageId, text: event.text, channel: 'APP' } }` (**ไม่ใส่** `lineMemberId`, `postbackData`) |
| `saveReply(event, thread, turn, response, claimOwner)` | 1) ถ้า `response.text.trim()` ว่าง หรือ `sessions.isMuted('app:'+contactId)` เป็นจริง → ใน transaction ตรวจ lease แล้วตั้งข้อความขาเข้า `NO_REPLY` คืน `null` 2) ไม่งั้นใน transaction เดียว: **ตรวจ lease** (`updateMany where id=event.messageId, leaseOwner=claimOwner, status='PROCESSING'` เพิ่ม `leaseUntil`; `count===0` → throw `Error('Message lease lost')`) · สร้างคำตอบ `{ sender: response.source==='AI'\|\|'KNOWLEDGE' ? AI : SYSTEM, status:'SENT', source: response.source, text: response.text, replyToId: event.messageId, turnContext: { userText: turn.contextUserText, response }, metadata: buildReplyMetadata(response, <ห้อง waiting_admin หรือไม่ อ่านใน tx เดียวกัน>) }` · อัปเดตห้อง `lastMessage/lastMessageAt` · ตั้งข้อความขาเข้า `ANSWERED` · ถ้า `response.source` เป็น handoff ไม่ต้องทำอะไรเพิ่ม (core เรียก `requestAdmin` เอง) คืน `{ id: reply.id }` · **เช็ก mute นอก transaction ก่อนเข้า transaction** (Redis ไม่อยู่ใน DB tx) |
| `deliver(replyId)` | อ่านคำตอบ; ถ้า `finalizedAt` มีแล้ว → จบ; ถ้า `turnContext.response.contextPolicy==='INCLUDE'` → `LoadContextService.appendTurn({ conversationId, eventId: 'app:'+replyToId, userText, response })` (ฟังก์ชันนี้ idempotent ด้วย `eventId`) แล้วตั้ง `finalizedAt = now` |

หมายเหตุ: ถ้า `appendTurn` ล้มเหลว มันไม่ throw (log เฉยๆ) ตามพฤติกรรมเดิม

### 5.3 `AppMessageService.send(ctx, dto)` ลำดับที่ต้องทำตรงตามนี้

```
0  text = sanitize(dto.text)  // ว่าง → 400
1  gate.assertMessage(ctx, text)                      // 429/503 ตามหัวข้อ 8 (ไม่แตะ DB)
2  conversation = upsert ห้องของ contact (สร้างด้วย lastMessage='', unreadCount=0)  // ยังไม่นับ unread
3  existing = findUnique(conversationId + clientMessageId)
   ถ้ามี:
     text ต่างกัน                         → 409 APP_CLIENT_MESSAGE_ID_REUSED
     status ANSWERED|NO_REPLY             → return ผลเดิม (200)
     status FAILED                        → 503 APP_UNAVAILABLE
     status PROCESSING และ leaseUntil>now → 202 APP_MESSAGE_IN_PROGRESS
     status PROCESSING และ lease หมด      → ไปขั้น 4 พร้อม reclaim=true
4  lock ห้อง: updateMany({ where:{ id, OR:[{activeUntil:null},{activeUntil:{lt:now}}] },
                           data:{ activeTurnId: <ยังไม่มี id → ใช้ uuid ใหม่ที่จะเป็น messageId>, activeUntil: now+LEASE } })
   count=0 → 409 APP_CONVERSATION_BUSY
   (try { 5–8 } finally { 9 })
5  turnLimiter.acquire(messageId) → ไม่ได้ → 429 APP_BUSY
6  ถ้า reclaim: updateMany where id, status='PROCESSING', leaseUntil<=now, attempts<MAX
        set leaseOwner=<owner ใหม่>, leaseUntil=now+LEASE, attempts+1  ; count=0 → 202
      (attempts ≥ MAX → ตั้ง FAILED → 503)
   ไม่ใช่ reclaim: transaction เดียว
        create ข้อความขาเข้า { id: messageId, sender: USER, status:'PROCESSING', leaseOwner, leaseUntil, attempts:1, text, clientMessageId, metadata }
        update ห้อง: lastMessage=text(ตัด 200), lastMessageAt=now, unreadCount+1
        update contact.lastActiveAt
      ชน unique (conversationId, clientMessageId) = race ของคำขอซ้ำ → ปลด lock แล้วกลับไปขั้น 3
7  try { await processor.process(event, adapter, owner) }
   catch { ตั้ง leaseUntil=now ให้ retry ได้ทันที; log (ไม่มี PII); throw 503 APP_UNAVAILABLE }
8  อ่านข้อความขาเข้า + คำตอบ → สร้าง response (meta จาก DB: status, source, handoff จากห้อง, botMode จาก Redis mute)
9  finally: ปลด lock (updateMany where id และ activeTurnId=messageId → set null) และ turnLimiter.release(messageId)
```
ข้อสำคัญ: ขั้น 2–3 อ่านเท่านั้น (ไม่เพิ่ม unread) · การนับ unread และการสร้างข้อความขาเข้าอยู่ transaction เดียวกัน จึง **นับครั้งเดียวต่อ `clientMessageId`** (ตรงกับกฎ "Persist incoming messages and unread increments only once")

### 5.4 จุดที่ต้องแก้ใน core (ดูเต็มที่หัวข้อ 7.3)
ข้อความ app **ไหลเข้า `handleTextMessage` และตอบถามทั่วไปได้โดยไม่ต้องแก้ core** แต่ต้องแก้ 3 จุดเพื่อไม่ให้ทำงานผิดเงียบ ๆ: (C1) สมัครสมาชิก (C2) ขอคุยแอดมิน (C3) แจ้งเตือนแอดมิน

---

## 6. โครงสร้างไฟล์ของ module

```
src/modules/app-message/
  app-message.module.ts
  app-message.config.ts            อ่าน/ตรวจ env ด้วย zod (ล้มตอน boot เมื่อค่าไม่ถูกต้อง)
  app-errors.ts                    AppApiException(status, code, message, retryAfterSec?)
  app-error.filter.ts              ตั้ง header Retry-After + รูปแบบ error ข้างบน
  guards/
    app-feature.guard.ts           APP_MESSAGE_ENABLED=false → 404
    app-key.guard.ts               X-App-Key → ChatApplication ACTIVE + ตรวจ Origin
    app-session.guard.ts           Bearer → session → contact (ผูก app เดียวกับ key)
  client-ip.ts                     clientIpHash(request, salt)  (มี /64 สำหรับ IPv6)
  chat-application.controller.ts   admin CRUD
  chat-application.service.ts
  app-session.controller.ts
  app-session.service.ts
  app-message.controller.ts
  app-message.service.ts
  app-channel.adapter.ts
  app-message.metadata.ts          buildReplyMetadata() + type ของ metadata ขาออก (pure function)
  app-abuse.service.ts             ban + rate limit + spam (ใช้ service เดิม)
  app-turn.limiter.ts              จำกัด turn พร้อมกัน (Redis sorted set + Lua)
  app-handoff.handler.ts           ลงทะเบียนกับ ChannelHandoffRegistry
  app-inbox.controller.ts          admin: app-conversations
  app-inbox.service.ts
  app-maintenance.service.ts       ลบข้อมูลหมดอายุ
  dto/
    app-session.dto.ts  app-message.dto.ts  chat-application.dto.ts  app-inbox.dto.ts
  *.spec.ts                        ข้างไฟล์ที่ทดสอบ
```
`AppMessageModule` imports: `PrismaModule`, `ConfigModule`, `ChatbotModule` (ได้ `UserSessionService`, `ChatbotService`), `MessagingModule` (`MessageProcessorService`), `NotificationModule`, `CompanyModule` (`CompanyService`) · `RateLimitModule`/`AbuseModule` เป็น `@Global` อยู่แล้ว · ลงทะเบียนใน `app.module.ts`

---

## 7. ส่วนของเดิมที่ต้องแก้ (ให้น้อยที่สุด)

### 7.1 สิ่งที่ **ไม่ต้องแก้**
`MessageProcessorService`, `ChannelAdapter` interface, `LineChannelAdapter`, คิว/ตาราง LINE, `LoadContextService`, `BanService`, `SpamDetectorService`, `AiBillingService`, `CreditService`

### 7.2 ใช้ซ้ำของเดิมอย่างไร
- `RateLimitService.consume(key, limit, windowSec, amount)` ใช้ได้ตรง ๆ (Step 2 เพิ่ม option ปิดกั้นเมื่อ Redis ล่ม โดยค่าเริ่มต้นคือพฤติกรรมเดิม)
- `BanService` / `SpamDetectorService` รับ `userId` เป็น string อะไรก็ได้ → ส่ง `app:<contactId>` และ `appip:<ipHash>` (ชื่อ key มีคำว่า `line` แต่ใช้ได้ ห้ามเปลี่ยนชื่อ key เพราะจะทำให้ของ LINE เดิมเสีย)
- limit ของ LINE ในไฟล์ [line-events.processor.ts:168](../../src/modules/line/line-events.processor.ts) เป็น private ของ processor นั้น **ไม่แก้** app มี gate ของตัวเอง (`AppAbuseService`) ที่เรียก service เดียวกัน

### 7.3 แก้ core: ต้องทำ (แต่ละข้อมี default = พฤติกรรมเดิม)

**C1. `channel` ใน ChatRequest + ปิดสมัครสมาชิกสำหรับ app**
- [chat.types.ts](../../src/modules/chatbot/shared/types/chat.types.ts): เพิ่ม `export type ChatChannelKind = 'LINE' | 'APP';` และใน `ChatRequest` เพิ่ม `channel?: ChatChannelKind` (ไม่ระบุ = LINE)
- [chatbot.service.ts](../../src/modules/chatbot/chatbot.service.ts): ดึง `channel` จาก request ใน `answerText`; แก้ `canRegister(preview = false)` เป็น `canRegister(preview = false, channel: ChatChannelKind = 'LINE')` → `!preview && channel === 'LINE' && isRegistrationEnabled(...)` · ส่ง `channel` ที่ 3 จุดที่เรียก `canRegister` (บรรทัด ~113, ~153, ~170)
- ผล: guest พิมพ์ "สมัคร" ได้ข้อความ `registerUnavailable()` ที่มีอยู่แล้ว

**C2. ขอคุยแอดมิน (`requestAdmin`) สำหรับ userId ที่ไม่ใช่ LINE**
ปัจจุบัน [user-session.service.ts:102](../../src/modules/users/session/user-session.service.ts) หา `lineConversation` จาก `lineUserId` ถ้าไม่เจอจะ **เงียบ ไม่แจ้งใคร**
- สร้าง `src/modules/users/session/channel-handoff.registry.ts`:
  ```ts
  export interface ChannelHandoffHandler {
    readonly userIdPrefix: string;                 // 'app:'
    requestAdmin(userId: string): Promise<void>;
  }
  @Injectable() export class ChannelHandoffRegistry {
    private readonly handlers: ChannelHandoffHandler[] = [];
    register(handler: ChannelHandoffHandler) { this.handlers.push(handler); }
    find(userId: string) { return this.handlers.find((h) => userId.startsWith(h.userIdPrefix)); }
  }
  ```
- `ChatbotModule`: เพิ่ม `ChannelHandoffRegistry` ใน `providers` และ `exports` (ที่เดียวกับ `UserSessionService`)
- `UserSessionService`: inject registry; ต้นของ `requestAdmin(userId)` เพิ่ม `const handler = this.handoffs.find(userId); if (handler) return handler.requestAdmin(userId);` แล้วโค้ดเดิมต่อทั้งหมดไม่เปลี่ยน · ค้นทุกที่ที่ `new UserSessionService(` (specs) แล้วแก้ constructor ให้ตรง
- `AppHandoffHandler` (ใน app-message) `onModuleInit` เรียก `registry.register(this)` · `requestAdmin('app:<id>')`: `channelConversation.updateMany({ where:{ contactId, status:{ not:'waiting_admin' } }, data:{ status:'waiting_admin' } })` ถ้า `count>0` → เรียก `NotificationService.notifyChannelAdminRequired(...)` (C3) ใน try/catch (ล้มแล้ว log ห้ามทำให้ turn ล้ม)

**C3. แจ้งเตือนแอดมินสำหรับห้อง app**
- [notification.type.ts](../../src/modules/admin/notification/types/notification.type.ts): `notificationMetadataSchema` เพิ่ม `channel: z.string().nullish()` (nullish = แถวเก่า parse ผ่านเหมือนเดิม)
- [notification.service.ts](../../src/modules/admin/notification/notification.service.ts): เพิ่ม method ใหม่ `notifyChannelAdminRequired({ userId, channel, conversationId, displayName, lastMessage, flow, step, status })` สร้าง `adminNotification` (`type:'CONTACT_ADMIN'`, metadata มี `channel`) แล้ว emit ผ่าน gateway · **ห้ามแก้ `notifyAdminRequired` เดิม**

**C4. (ทำท้ายสุด ดู Step 14) งบ AI แยก scope สำหรับ app**
ตอนนี้ลูกค้าทุกคนใช้ scope `'*'` ([users-ai-provider.service.ts:43](../../src/modules/ai/users-ai-provider.service.ts)) · phase 1 ป้องกันค่าใช้จ่ายด้วย rate limit/โควตารายวัน/ตัวจำกัด turn ก่อน ส่วนเพดานงบแยก scope ต้องส่ง `channel` ลงไปทุกจุดที่ copy context ซึ่งเสี่ยง จึงแยกเป็น Step ท้าย

---

## 8. Rate limit และกันสแปม

หลักการ: **ชั้นถูกก่อนแพง** (ไม่แตะ DB/AI ถ้าไม่จำเป็น) · key ระดับ IP รวมทุก session (กันหมุน session) · endpoint public จึง **ปิดกั้นเมื่อ Redis ล่ม** (fail closed) ต่างจาก LINE ที่ fail open · ตอบ 429 พร้อม `Retry-After` (ต่างจาก LINE ที่ drop เงียบ เพราะ client ต้องรู้)

### 8.1 ชั้นป้องกัน (ค่าเริ่มต้นปรับด้วย env ในหัวข้อ 11)

| # | ตรวจอะไร | key (Redis) | ค่าเริ่มต้น | เมื่อเกิน |
|---|---|---|---|---|
| A1 | IP ถูกแบน | `ban:line:user:appip:<ipHash>` (BanService) | – | 429 `APP_BANNED` |
| A2 | key ผิด/token ผิดต่อ IP | `rl:app:authfail:<ipHash>` | 30/นาที | 429 + strike IP |
| S1 | สร้าง session ต่อ IP | `rl:app:sess:ip10m:<ipHash>` / `…:ip1h:…` | 20/10 นาที · 60/ชม. | 429 `APP_RATE_LIMITED` + strike IP |
| S2 | สร้าง session ต่อ app | `rl:app:sess:app:<appId>` | 300/นาที | 429 |
| S3 | session ที่ยังใช้ได้ต่อ IP | นับใน DB (`ipHash`, ไม่ revoke, ไม่หมดอายุ) | 50 | 429 `APP_TOO_MANY_SESSIONS` + strike IP |
| M1 | contact ถูกแบน | `ban:line:user:app:<contactId>` | – | 429 `APP_BANNED` |
| M2 | ข้อความต่อ contact (burst) | `rl:app:msg:c:<id>:burst` | 10/10 วินาที | 429 + strike contact |
| M3 | ต่อ contact (ชั่วโมง/วัน) | `…:hour` / `…:day` | 60/ชม. · 300/วัน | 429 + strike contact |
| M4 | ต่อ IP รวมทุก session | `rl:app:msg:ip:<ipHash>:min/hour/day` | 30/นาที · 300/ชม. · 2000/วัน | 429 + strike IP |
| M5 | ต่อ app ต่อวัน | `rl:app:msg:app:<appId>:day` | 20000 (0 = ปิดการจำกัด) | 429 |
| M6 | สแปมข้อความซ้ำ/ยาว/ลิงก์เยอะ | `SpamDetectorService.check('app:<id>', text)` | ค่า SPAM_* เดิม | 429 + strike contact |
| M7 | จำนวน turn พร้อมกัน (ทั้งระบบ) | Redis ZSET `app:turns:inflight` | 20 | 429 `APP_BUSY` |
| R1 | อ่านประวัติ (GET) ต่อ session | `rl:app:read:s:<sessionId>` | 60/นาที | 429 |
| R2 | อ่านประวัติต่อ IP | `rl:app:read:ip:<ipHash>` | 300/นาที | 429 |

Strike: ใช้ `BanService.addStrike` เดิม (strike 3 = แบน 5 นาที, 4 = 1 ชม., 5+ = 24 ชม. ตาม env `ABUSE_*`) · **strike ของ IP เกิดเฉพาะเมื่อชน limit ระดับ IP (S1,S3,M4,A2)** ส่วน limit ระดับ contact (M2,M3,M6) strike ที่ contact เท่านั้น เพื่อไม่ให้ลูกค้าคนหนึ่งในเครือข่ายเดียวกัน (NAT/ออฟฟิศ) ทำให้ทุกคนโดนแบน

ลำดับตรวจ `assertMessage`: A1 → M1 → M2 → M3 → M4 → M5 → M6 (ถูกก่อนแพง) · M7 ตรวจใน service หลังได้ lock ห้อง

### 8.2 การหา IP จริง (production: Cloudflare → nginx → app)

เส้นทางจริง: `ลูกค้า → Cloudflare (proxy เปิด) → nginx (docker) → core-api` · DNS ของ `api.keela-agent.online` ชี้ไป IP ของ Cloudflare (ตรวจแล้ว 25 ต.ค. 2026) → TCP peer ที่ nginx เห็นคือ **IP ของ Cloudflare ไม่ใช่ลูกค้า**

ปัญหาตอนนี้:
- [main.ts](../../src/main.ts) **ไม่ได้ตั้ง `trustProxy`** → `request.ip` = IP ของ nginx (ใน docker network) ทุกคำขอ → limit ต่อ IP จะบล็อกทุกคนพร้อมกัน
- ถ้าแก้แค่ฝั่ง app ด้วย hop=1 → ได้ IP ของ Cloudflare edge แทน (คนในจังหวัดเดียวกันใช้ edge ไม่กี่ตัว = ยังโดนบล็อกรวมกัน)
- ถ้าเชื่อ header `CF-Connecting-IP` ตรง ๆ ใน app → ใครรู้ IP ของ VPS ยิงตรงมาแล้วปลอม header นี้ได้

**วิธีที่ใช้: nginx เป็นคนแปลง IP ให้ app เชื่อแค่ 1 hop**

1. nginx (ไฟล์ `./nginx/default.conf` บน VPS ไม่อยู่ใน repo) ระดับ `http` หรือ `server`:
   ```nginx
   # เชื่อ CF-Connecting-IP เฉพาะเมื่อคนต่อเข้ามาคือ Cloudflare จริง
   # รายการจาก https://www.cloudflare.com/ips-v4 และ https://www.cloudflare.com/ips-v6 (ใส่ให้ครบทุกบรรทัด)
   set_real_ip_from 173.245.48.0/20;
   set_real_ip_from 103.21.244.0/22;
   # … ที่เหลือทั้งหมดของ v4 และ v6 …
   real_ip_header CF-Connecting-IP;
   ```
   และใน `location` ที่ proxy ไป core-api:
   ```nginx
   proxy_set_header X-Forwarded-For $remote_addr;   # เขียนทับ ห้ามใช้ $proxy_add_x_forwarded_for
   proxy_set_header X-Real-IP       $remote_addr;
   ```
   ผล: มาจาก Cloudflare → `$remote_addr` = IP ลูกค้า · ยิงตรงไม่ผ่าน Cloudflare → `set_real_ip_from` ไม่ตรง nginx ไม่สนใจ header ที่ปลอม → `$remote_addr` = IP จริงของผู้ยิง · **ปลอมไม่ได้ทั้งสองทาง**
2. app: `TRUST_PROXY_HOPS=1` → Fastify ใช้ค่า `X-Forwarded-For` ตัวท้ายสุด (ซึ่ง nginx เขียนทับแล้วเหลือค่าเดียว)
3. **ห้ามตั้ง `trustProxy: true`** และห้ามอ่าน `cf-connecting-ip` ในโค้ด app (ให้ nginx ทำที่เดียว)
4. ข้อควรระวังของ docker: nginx ต้องเห็น IP ของ Cloudflare เป็น peer ถ้า log ของ nginx แสดง `172.17.x`/`172.18.x` (gateway ของ docker) แปลว่า docker แปลง source IP ทิ้ง → realip ใช้ไม่ได้ ต้องหยุดและแจ้งผู้ใช้ (ทางแก้: ปิด `userland-proxy` ของ docker หรือให้ nginx ใช้ `network_mode: host`) · ช่วง IP ของ Cloudflare `172.64.0.0/13` ไม่ใช่ของ docker อย่าสับสน
5. รายการ IP ของ Cloudflare เปลี่ยนนาน ๆ ครั้ง ให้จดใน deploy notes ว่าต้องตรวจทุก 6 เดือน
6. (ไม่บังคับ, แข็งขึ้น) firewall ให้พอร์ต 80/443 รับเฉพาะ IP ของ Cloudflare เพื่อไม่ให้ใครข้าม Cloudflare มาตรง ๆ · docker เขียน iptables เอง กฎ `ufw` ปกติจึงไม่มีผลกับพอร์ตที่ docker publish ต้องใส่ใน chain `DOCKER-USER` · ทำแยกจากงานนี้ได้
7. (ไม่บังคับ) Cloudflare WAF rate limiting rule กับ `POST /api/app/v1/sessions` เป็นด่านนอกสุด (แพ็กเกจฟรีได้ 1 กฎ)

อื่น ๆ:
- Cloudflare ตัดคำขอที่ origin ตอบช้ากว่า **100 วินาที** (ข้อ 524) → turn ต้องจบก่อนนั้น · nginx `proxy_read_timeout` ตั้ง ≥ 60s และ ≤ 95s
- LINE webhook ผ่าน Cloudflare เส้นเดียวกัน การแก้ nginx ข้างบนไม่กระทบ (ลายเซ็นตรวจจาก body ไม่ใช่ IP) แต่ต้องทดสอบ webhook หลังแก้ nginx ทุกครั้ง (ปุ่มทดสอบในหน้า setting/connection)
- ipHash = `sha256(ip + APP_IP_HASH_SALT)` ตัดเหลือ 32 hex · IPv6 ใช้เฉพาะ prefix /64 ก่อน hash · ไม่เก็บ/ไม่ log IP จริง

**เรื่อง IP ร่วมกันของเครือข่ายมือถือไทย:** ค่ายมือถือใช้ CGNAT (ลูกค้าหลายร้อยคนออก internet ด้วย IPv4 เดียวกัน) และ wifi ร้าน/ออฟฟิศก็เป็น IP เดียว → limit ระดับ IP (S1, S3, M4) ต้องหลวมกว่าระดับ contact มาก และ strike IP เฉพาะเมื่อชน limit ระดับ IP · ผู้ใช้ IPv6 (AIS/True ส่วนใหญ่มี) แยกกันด้วย /64 จึงไม่ค่อยชนกัน

### 8.3 ตัวจำกัด turn พร้อมกัน (`AppTurnLimiter`)
Redis sorted set: member = messageId, score = เวลาหมดอายุ (ms) · acquire/release ด้วย Lua ให้ atomic
```lua
-- acquire: KEYS[1]=set  ARGV[1]=now  ARGV[2]=expiresAt  ARGV[3]=max  ARGV[4]=member
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
redis.call('PEXPIRE', KEYS[1], 300000)
return 1
```
release = `ZREM`. process ที่ตายกลางทางจะหลุดเองเมื่อ score หมดอายุ (ไม่มีตัวนับค้าง) · Redis error → ถือว่าเต็ม (fail closed → 503)

### 8.4 การใช้ของเดิมเติม
- `RateLimitService`: เพิ่ม parameter ตัวที่ 5 `options?: { failOpen?: boolean }` (default `true` = ของเดิม) · `failOpen:false` และ Redis error → คืน `allowed:false` · **callers เดิมไม่ต้องแก้และพฤติกรรมไม่เปลี่ยน**
- ข้อจำกัดที่ต้องรู้: เป็น fixed window (ขอบ window ยิงได้ ~2 เท่าชั่วขณะ) ยอมรับสำหรับ phase 1

### 8.5 log สำหรับปรับค่า limit หลังเปิดใช้จริง
ค่าเริ่มต้นในหัวข้อ 11 เป็นค่าเดา ต้องมีข้อมูลไว้ปรับ:
- ทุกครั้งที่ตอบ 429/503 จาก gate: `logger.warn('app gate blocked layer=<A1|S1|…|M7> app=<appId> ip=<ipHash 8 ตัวแรก> contact=<contactId|->')` · ห้ามมีข้อความ/IP จริง
- ดูได้ด้วย `docker compose logs core-api | grep "app gate blocked" | awk '{print $…}' | sort | uniq -c` (ใส่คำสั่งจริงใน `docs/app-message-flow.md` ตอน Step 13)
- เกณฑ์ปรับ: ชั้นไหนบล็อกจาก `ipHash` หลายสิบตัวที่ต่างกันในเวลาใกล้กัน = ค่าตึงไปสำหรับคนจริง · ชั้นไหนบล็อก `ipHash` เดิมซ้ำ ๆ = ทำงานถูก

---

## 9. ขั้นตอนการทำ (ทำตามลำดับ)

### Step 0 — Preflight
- `git status` สะอาด (หรือรู้ว่ามีงานของผู้ใช้ค้างอะไร ห้ามแตะ)
- อ่าน: `src/modules/events/message/**`, `src/modules/line/line-channel.adapter.ts`, `src/modules/users/session/user-session.service.ts`, `src/modules/admin/userview/admin-userview.service.ts` (ต้นแบบ request/response + lock), `src/modules/usage/rate-limit/rate-limit.service.ts`, `src/modules/abuse/*.ts`
- บันทึก baseline: `bunx tsc --noEmit | grep -c "error TS"` และรายชื่อ suite ที่ fail จาก `bun run test`
- **เสร็จเมื่อ:** มีตัวเลข baseline ในคำอธิบาย PR

### Step 1 — Schema + migration
- สร้าง `prisma/models/channel/channel.prisma` ตามหัวข้อ 3 + เพิ่ม relation ฝั่ง `Company`, `Customer`, `AdminMember`
- สร้าง migration ตามวิธีในหัวข้อ 3 (ตรวจว่ามีแต่การสร้างของใหม่)
- `bunx prisma migrate deploy` (DB ในเครื่องเท่านั้น) → `bun run db:generate` → `bunx tsc --noEmit` ไม่มี error เพิ่ม
- **เสร็จเมื่อ:** `bunx prisma migrate status` = up to date · ตาราง 5 ตารางมีใน DB ในเครื่อง · ไม่มีไฟล์ใน `src/generated/` ถูกแก้ด้วยมือ

### Step 2 — RateLimitService: option fail-closed
- แก้ [rate-limit.service.ts](../../src/modules/usage/rate-limit/rate-limit.service.ts) ตามหัวข้อ 8.4 (แก้เฉพาะ signature และ branch `catch`)
- เทสต์ `rate-limit.service.spec.ts` (ไฟล์ใหม่): (1) นับถึง limit แล้ว `allowed:false` (2) Redis error + ไม่ส่ง option → `allowed:true` (พฤติกรรมเดิม) (3) Redis error + `failOpen:false` → `allowed:false`
- **เสร็จเมื่อ:** เทสต์ผ่าน · ค้น `consume(` ทุกที่ ไม่มี caller เดิมถูกแก้

### Step 3 — Module skeleton, config, errors, feature flag
- สร้าง `app-message.module.ts`, `app-message.config.ts`, `app-errors.ts`, `app-error.filter.ts`, `guards/app-feature.guard.ts`, `client-ip.ts` · เพิ่ม `AppMessageModule` ใน `app.module.ts`
- `AppMessageConfig` อ่านทุก env ในหัวข้อ 11 ด้วย zod (`z.coerce.number().int().min(…)`) ผิดแล้ว throw ตอน boot **เฉพาะเมื่อ `APP_MESSAGE_ENABLED=true`** (ปิดอยู่ต้องไม่บังคับ `APP_IP_HASH_SALT`)
- `clientIpHash`: IPv4 ใช้ทั้งค่า · IPv6 ตัดเหลือ /64 · `sha256(ip + salt).slice(0,32)`
- `AppApiException` extends `HttpException` body `{ code, message, retryAfterSec? }` · filter ตั้ง `Retry-After`
- เทสต์: `client-ip.spec.ts` (IPv4 เดียวกัน = hash เดียวกัน, IPv6 สองที่อยู่ใน /64 เดียวกัน = hash เดียวกัน, salt ต่าง = hash ต่าง, ไม่มี IP จริงในผลลัพธ์), `app-error.filter.spec.ts`
- **เสร็จเมื่อ:** แอปบูตได้เมื่อ `APP_MESSAGE_ENABLED` ไม่ตั้ง · เทสต์ผ่าน

### Step 4 — main.ts: trustProxy, CORS ของ /api/app, body limit
แก้ [main.ts](../../src/main.ts) **เพิ่มเท่านั้น ห้ามเปลี่ยน CORS ของ route เดิม**
1. `new FastifyAdapter({ bodyLimit: …เดิม…, trustProxy: Number(process.env.TRUST_PROXY_HOPS ?? 0) })`
2. `onRoute` hook ตั้ง `route.bodyLimit = APP_BODY_LIMIT_BYTES` เมื่อ `route.url.startsWith('/api/app/')` (ลงทะเบียนก่อน `app.listen`; ตรวจว่าทำงานจริงด้วยเทสต์ขนาด body)
3. เปลี่ยน `app.enableCors({...})` เป็นแบบ delegator: ถ้า url ขึ้นต้น `/api/app/` → ตัวเลือกของ app (`methods: GET,POST,DELETE,OPTIONS`; `allowedHeaders: Content-Type, Authorization, X-App-Key`; `credentials: false`; `origin` = origin ที่อยู่ใน union ของ `allowedOrigins` ของ app ที่ ACTIVE (cache 60 วินาที ใน `ChatApplicationService.allowedOriginsUnion()`)) · url อื่น → ตัวเลือกเดิมทุกตัวอักษร
   (preflight ไม่มี `X-App-Key` จึงตรวจได้แค่ union · การตรวจต่อ app ทำใน `AppKeyGuard`)
- **เสร็จเมื่อ:** curl preflight จาก origin ที่ไม่อยู่ในรายการไม่ได้ `access-control-allow-origin` · route admin เดิมยังตอบ CORS เหมือนเดิม · body 20KB ไป `/api/app/v1/messages` ได้ 413 · body เกิน 16KB ที่ route อื่นยังทำงานตามเดิม

### Step 5 — ChatApplication (admin)
- `chat-application.service.ts` / `.controller.ts` / `dto/chat-application.dto.ts`, `@AdminGuard('owner','dev')`
- `publicKey = 'pk_' + randomBytes(24).toString('base64url')`
- `companyId` ← บริษัทของ admin ผ่าน `CommerceScopeService.forAdmin(admin)` และ **ต้องเท่ากับ `CompanyService.getCompanyId()`** ไม่งั้น 409 (billing ใช้บริษัทหลักเท่านั้น)
- `allowedOrigins`: ≤ 20 รายการ, ตรง `^https?://[a-z0-9.-]+(:\d{1,5})?$` (ตัวพิมพ์เล็ก ไม่มี path, ไม่มี `*`) · normalize แล้ว dedupe
- PATCH เปลี่ยน `status: DISABLED` มีผลภายใน cache TTL (60 วินาที) · `rotate-key` ล้าง cache ทันที
- log `chat application <id> <action> by admin <adminId>` (ไม่มี key)
- เทสต์: role `admin` → 403 · origin `*` หรือมี path → 400 · rotate แล้ว key เก่าไม่ผ่าน
- **เสร็จเมื่อ:** สร้างแอปผ่าน Swagger ได้และได้ `publicKey`

### Step 6 — Guards + Session
- `AppKeyGuard`: header `x-app-key` → cache (60 วินาที) → ไม่เจอ/`DISABLED` → `recordInvalidAuth(ipHash)` แล้ว 401 `APP_KEY_INVALID` · ถ้ามี header `Origin`: ต้องอยู่ใน `app.allowedOrigins` ไม่งั้น 403 · ใส่ `request.appCtx = { app, ipHash }`
- `AppSessionGuard`: `Authorization: Bearer ags_…` → `sha256` → `appGuestSession.findUnique({ where:{tokenHash}, include:{ contact:{ select:{id,companyId,applicationId,displayName} } } })` ตรวจ `revokedAt=null`, `expiresAt>now`, `createdAt + APP_SESSION_MAX_AGE_DAYS > now`, `contact.applicationId === app.id` ไม่ผ่าน → 401 `APP_SESSION_INVALID` + `recordInvalidAuth`
- sliding: ถ้า `lastSeenAt` เก่ากว่า `APP_SESSION_TOUCH_SEC` → `update { lastSeenAt: now, expiresAt: min(now+30d, createdAt+maxAge) }` (ล้มแล้ว log ไม่ล้มคำขอ)
- `AppSessionService.create(app, ipHash, dto)`: `abuse.assertSessionCreate` ก่อน → transaction สร้าง `ChannelContact` + `AppGuestSession` (**ยังไม่สร้างห้อง**) → token = `'ags_' + randomBytes(32).toString('base64url')`
- `revoke`: `revokedAt = now`
- เทสต์ (`app-session.service.spec.ts`, `app-session.guard.spec.ts`): สร้าง session แล้วใช้ได้ · token ผิด/หมดอายุ/revoke → 401 · token ของ app A ใช้กับ key ของ app B → 401 · DB ไม่มี token จริง (มีแต่ hash) · sliding ต่ออายุแต่ไม่เกินเพดาน
- **เสร็จเมื่อ:** `POST /sessions` → `GET /session` → `DELETE /session` ทำงานครบ (ตั้ง `APP_MESSAGE_ENABLED=true` ในเครื่อง)

### Step 7 — Abuse gate + turn limiter
- `app-abuse.service.ts` ตามตารางหัวข้อ 8.1 · เมธอด: `assertSessionCreate(app, ipHash)`, `assertMessage(ctx, text)`, `assertRead(ctx)`, `recordInvalidAuth(ipHash)`
- ทุกการเรียก `RateLimitService.consume` ใช้ `{ failOpen: false }` · Redis ล่ม → `AppApiException(503,'APP_UNAVAILABLE')`
- ban → `AppApiException(429,'APP_BANNED', …, retryAfterSec = BanInfo.expiresInSec)`
- ชน limit ระดับ IP → `banService.addStrike('appip:'+ipHash, reason)` ; ระดับ contact → `addStrike('app:'+contactId, reason)`
- log ทุกครั้งที่บล็อกตามหัวข้อ 8.5
- `app-turn.limiter.ts` ตามหัวข้อ 8.3
- เทสต์ unit (mock `RateLimitService`/`BanService`/`SpamDetectorService`): ลำดับตรวจถูกต้อง · limit IP strike IP ไม่ strike contact · limit contact strike contact ไม่ strike IP · Redis error → 503 ไม่ใช่ผ่าน · ข้อความซ้ำ → spam
- เทสต์ integration (เปิดด้วย `APP_MESSAGE_INTEGRATION_TEST=true`, ใช้ Redis ในเครื่อง): limiter ไม่เกิน max เมื่อเรียกพร้อมกัน 50 ครั้ง · release แล้วได้ช่องคืน · member หมดอายุถูกเก็บกวาด
- **เสร็จเมื่อ:** เทสต์ผ่านทั้งสองชุด

### Step 8 — Adapter + Message service + Controller
- เขียน `app-channel.adapter.ts` ตามหัวข้อ 5.2 และ `app-message.service.ts` ตามหัวข้อ 5.3 ตรงตามลำดับ · `app-message.controller.ts`: `@UseGuards(AppFeatureGuard, AppKeyGuard, AppSessionGuard)`, `@UseFilters(AppErrorFilter)`
- `GET /messages`: หาห้องจาก `contactId` ของ token เท่านั้น (**ห้ามรับ `conversationId`/`guestId` จาก client**) · cursor `(createdAt,id)` · คืนข้อความทั้ง user/ai/admin/system พร้อม `metadata` (ตัด `sentByAdminId`, `leaseOwner`, `turnContext`, `lastError` ออก)
- `app-message.metadata.ts` + `app-message.metadata.spec.ts`: whitelist ตามหัวข้อ 4.1 · เทสต์ว่าใส่ field แปลกใน `response` (เช่น `costThb`, `companyId` ใน catalogRefs) แล้วไม่หลุดออกมา · ขนาดไม่เกิน 4096 ไบต์ · ไม่มีห้อง → `{ items: [], nextCursor: null }`
- `AppMessageService` ต้อง **ไม่ log ข้อความดิบ** (log: messageId, ผลลัพธ์, ระยะเวลา)
- เทสต์ (ใช้ DB จริงถ้ามี `APP_MESSAGE_INTEGRATION_TEST=true` ส่วน AI mock `ChatbotService`):
  - ส่งข้อความ → 200 มีคำตอบ · `unreadCount=1` · ประวัติ 2 แถว · context append แล้ว
  - retry `clientMessageId` เดิม → คำตอบเดิม · `ChatbotService` ถูกเรียก 1 ครั้ง · `unreadCount` ยัง 1
  - `clientMessageId` เดิมแต่ text ต่าง → 409
  - ส่ง 2 ข้อความพร้อมกันในห้องเดียว → 1 ได้ 200 อีก 1 ได้ 409 (`APP_CONVERSATION_BUSY`)
  - lease หมด (process ตาย) → retry claim ใหม่ได้ · เรียก `ChatbotService` ซ้ำได้แต่ `turnId` เดิม
  - response ว่าง (เครดิตหมด) → `NO_REPLY`, `replies: []`, ไม่มีรายละเอียดเครดิต
  - mute ระหว่าง AI คิด (mock ให้ `isMuted` เป็น true ตอน `saveReply`) → ไม่มีคำตอบของบอท
  - GET ด้วย token ของ guest A ไม่เห็นข้อความของ guest B
- **เสร็จเมื่อ:** เทสต์ผ่าน · ยิง curl จริงตามลำดับ session → message → get messages ได้คำตอบจาก core

### Step 9 — แก้ core (C1–C3) + เทสต์ถดถอย LINE
- ทำ C1, C2, C3 ตามหัวข้อ 7.3 · เพิ่ม `AppHandoffHandler`
- เทสต์ถดถอย (ต้องผ่านก่อนและหลังแก้): `requestAdmin('Uline…')` ยังเรียกตรรกะ LINE เดิม · `requestAdmin('app:…')` เรียก handler และไม่แตะ `lineConversation` · `handleTextMessage` ที่ไม่ใส่ `channel` สมัครสมาชิกได้เหมือนเดิม และ `channel:'APP'` ได้ `registerUnavailable` · `notifyAdminRequired` เดิมไม่เปลี่ยน · แถว notification เก่าที่ไม่มี `channel` ยัง parse ได้
- เทสต์ใหม่: guest พิมพ์ขอคุยแอดมิน → ห้อง `waiting_admin` + มี notification ที่ metadata `channel:'APP'` `conversationId` ถูกต้อง
- **เสร็จเมื่อ:** รัน `bun run test -- user-session notification chatbot` ไม่มี fail เพิ่มจาก baseline

### Step 10 — Admin inbox สำหรับ app
- `app-inbox.service.ts` / `.controller.ts` / `dto/app-inbox.dto.ts` (`@AdminGuard()`)
- รายการห้อง: คืนรูปร่างที่ใกล้ `LineConversation` ให้ dashboard ใช้ซ้ำได้: `{ id, channel:'APP', status, lastMessage, lastMessageAt, unreadCount, contact:{ id, displayName, applicationName, metadata }, botMode }`
- ประวัติ: map เป็น `{ id, conversationId, sender, messageType, text, sentStatus, metadata, createdAt }` (ชื่อ field เหมือน `LineChatHistory` + `metadata`) · `before/after` เป็น ISO เหมือน LINE · limit ≤ 100
- แอดมินตอบ: transaction สร้าง `ChannelMessage { sender: ADMIN, status:'SENT', sentByAdminId, clientMessageId:'admin:'+clientRequestId, metadata:{ v:1, source:'ADMIN' } }` + อัปเดตห้อง (`lastMessage`, และ `waiting_admin` → `open`) · `sessions.mute('app:'+contactId)` (หลังเขียน DB สำเร็จ ถ้า mute ล้มเหลว log ไว้) · ซ้ำด้วย `clientRequestId` เดิม → คืนแถวเดิม · text ต่าง → 400
- resume-bot: `sessions.resume`, ห้อง → `open`, `LoadContextService.clear(conversationId)`
- เทสต์: ตอบแล้ว guest เห็นใน `GET /messages` · ตอบ 2 ครั้งด้วย id เดิมได้แถวเดียว · หลังแอดมินตอบ บอทไม่ตอบข้อความถัดไปของ guest (`NO_REPLY`, `botMode:'admin'`) จนกว่าจะ resume หรือ mute หมดอายุ · resume แล้วบอทตอบอีก
- **เสร็จเมื่อ:** เทสต์ผ่าน

### Step 11 — Maintenance job
- `app-maintenance.service.ts`: `setInterval` 10 นาที (`unref`) แบบเดียวกับ [line-events.processor.ts:31](../../src/modules/line/line-events.processor.ts) + Redis lock `SET app:maintenance:lock <id> NX EX 540` กันหลาย instance ทำพร้อมกัน
- ก่อนเขียน: `grep` ตาราง usage/billing (`aiUsageEvent`, ledger, reservation) ว่า**ไม่มีคอลัมน์เก็บข้อความลูกค้า** (ควรมีแค่ `conversationId` เป็น UUID) ถ้ามี ให้หยุดถามผู้ใช้ เพราะ retention จะไม่ครบ
- `cutoff = now - APP_HISTORY_RETENTION_DAYS` (default 7) · ทุกการลบทำเป็นชุด (เลือก `id` `take: 500` แล้ว `deleteMany({ where: { id: { in } } })` วนจนน้อยกว่า 500 หรือใช้เวลาเกิน 60 วินาที) เพื่อไม่ lock ตารางนาน
- งานตามลำดับ (เขียนเป็น method แยกเพื่อเทสต์ทีละอัน):
  1. `purgeStaleConversations`: ลบ `ChannelConversation` ที่ `channel=APP`, `lastMessageAt < cutoff` และ (`activeUntil` null หรือ < now) → ข้อความในห้อง cascade ตาม
  2. `purgeOldMessages`: ลบ `ChannelMessage` ที่ `createdAt < cutoff` และ `status != 'PROCESSING'` และห้องเป็น `channel=APP` (ห้องที่ยังคุยอยู่จะเหลือแค่ 7 วันล่าสุด · `lastMessage` ของห้องไม่ต้องแก้เพราะใหม่กว่า cutoff เสมอ)
  3. `purgeNotifications`: ลบ `AdminNotification` ที่ `userId` ขึ้นต้น `app:` และ `createdAt < cutoff` (แถวเหล่านี้เก็บข้อความล่าสุดของ guest ไว้ใน `message`/`metadata`) · **ห้ามแตะแถวของ LINE**
  4. ลบ `AppGuestSession` ที่ `expiresAt` หรือ `revokedAt` เก่ากว่า 7 วัน
  5. ลบ `ChannelContact` (APP) ที่ไม่มี session และไม่มีห้อง และอายุ > 1 วัน (`displayName`/`metadata` ของ contact หายไปด้วย)
  6. ตั้ง `FAILED` ให้ข้อความขาเข้า `PROCESSING` ที่ `leaseUntil` เก่ากว่า 10 นาทีและ `attempts >= APP_MAX_ATTEMPTS`
- **ไม่ลบ:** `aiUsageEvents`, ledger, wallet (ข้อมูลบัญชี ไม่มีข้อความ) · key ใน Redis (context มี TTL 30 นาทีอยู่แล้ว [load-context.service.ts:14](../../src/modules/chatbot/context/load-context.service.ts), ban/strike/spam มี TTL ของตัวเอง)
- log เฉพาะจำนวนที่ลบต่องาน ห้าม log id ของ contact รายตัว
- เทสต์ (`app-maintenance.service.spec.ts`, DB จริงเมื่อ `APP_MESSAGE_INTEGRATION_TEST=true`):
  - ข้อความอายุ 8 วันถูกลบ · 6 วันอยู่ · ห้องที่เงียบ 8 วันหายทั้งห้อง · ห้องที่คุยวันนี้แต่มีข้อความ 8 วันก่อน เหลือแต่ข้อความใหม่
  - ข้อความ `PROCESSING` และห้องที่ถือ lock อยู่ไม่ถูกลบ
  - notification ของ `app:` อายุ 8 วันถูกลบ · notification ของ LINE อายุ 8 วัน**ยังอยู่**
  - `aiUsageEvents` ที่ชี้ `conversationId` ของห้องที่ถูกลบ**ยังอยู่**
  - ลบเฉพาะ session ที่หมดอายุจริง · ไม่ลบ contact ที่มีห้องหรือ session ที่ใช้ได้
  - lock ทำให้ instance ที่สองข้าม
  - `GET /messages` ด้วย cursor ที่ชี้ข้อความที่ถูกลบไปแล้วยังทำงาน (ได้ข้อความถัดไป ไม่ error)
- **เสร็จเมื่อ:** เทสต์ผ่าน

### Step 12 — ชุดเทสต์ช่องโหว่ (หัวข้อ 10)
- เขียนเทสต์ครบทุกแถวในหัวข้อ 10 ที่ยังไม่มี รันแล้วกรอกคอลัมน์ "ผลจริง" · **ข้อไหน fail = ช่องโหว่จริง แก้ในขั้นนี้เลยและรันซ้ำ**
- ตรวจ grep: ไม่มี `console.log` หรือ log ที่มี token / `x-app-key` / IP จริง / ข้อความดิบ: `grep -rn "console\.\|logger\..*\(text\|token\|ip\)" src/modules/app-message`
- **เสร็จเมื่อ:** ทุกแถวมีผลจริง · ไม่มี fail ค้าง

### Step 13 — Docs + env + deploy notes
- เขียน `docs/app-message-flow.md` (flow จริงหลังทำเสร็จ) และเพิ่มย่อหน้าใน `docs/line-message-e2e-current.md` ว่า app ใช้ `MessageProcessorService` ร่วมและต่างกันตรงไหน
- เพิ่ม env ทั้งหมดใน `.env.example` (ถ้ามี) และรายการในหัวข้อ 11
- แก้ไฟล์นี้: สถานะ → "ทำแล้ว" พร้อมวันที่และสิ่งที่ต่างจากแผน
- **เสร็จเมื่อ:** ผู้ใช้ review เอกสาร

### Step 14 — (ทีหลัง) เพดานงบ AI แยก scope `app` (C4)
ทำเมื่อ Step 1–13 เสร็จและใช้งานจริงแล้ว เพราะต้องแก้หลายจุดของ core
1. เพิ่ม `channel?: ChatChannelKind` ใน `LineAiUsageContext` ([ai-usage.types.ts](../../src/modules/usage/billing/ai-usage.types.ts)) และ `export const APP_AI_BUDGET_SCOPE_KEY = 'app'`
2. ไล่ทุกจุดที่ copy context ทีละฟิลด์แล้วเพิ่ม `channel`: `chatbot.service.ts` (ตัวแปร `usage` ใน `answerText`, image ~บรรทัด 275, sticker ~บรรทัด 318), `answer/answer.service.ts` (~บรรทัด 128), `knowledge/knowledge-retrieval.service.ts` (~บรรทัด 109), `ai/users-ai-provider.service.ts` (~บรรทัด 47) และ `grep -rn "turnId: context.turnId\|turnId: request.turnId" src/modules` ให้ครบ
3. `UsersAiProviderService.generateWithUsage`: `scopeKey = context.channel === 'APP' ? APP_AI_BUDGET_SCOPE_KEY : LINE_AI_BUDGET_SCOPE_KEY`, `requireBudgetLimit` เป็น true เมื่อเป็น app (ต้องตั้ง limit ของ scope `app` ก่อน ไม่งั้น AI ของ app ถูกปิด — ตรวจ endpoint ตั้งงบใน `admin/wallet`)
4. `toChatTurn` ส่ง `channel:'APP'` (ทำไว้แล้วใน Step 8)
5. เทสต์: LINE เรียก AI ยังใช้ scope `'*'` เหมือนเดิม · app ใช้ `'app'` · งบ `app` หมด → app ไม่ตอบ (NO_REPLY) แต่ LINE ยังตอบ
- **เสร็จเมื่อ:** เทสต์ผ่านและตรวจรายงานงบแยก scope ได้

### Step 15 — Frontend (repo `chatbot-dashboard`) วางแผนแยกหลัง backend เสร็จ
- Inbox: รวมรายการ LINE กับ app (`/api/admin/app-conversations`) ในหน้า LineChat พร้อมป้ายช่องทาง · ส่งข้อความ/resume-bot เรียกตาม `channel` · notification ที่ `metadata.channel==='APP'` เปิดห้อง app
- แสดง `metadata` ในห้อง app: ข้อความ guest แสดง metadata ที่ client ส่ง · คำตอบบอทแสดง metadata ของ server · ข้อมูล contact แสดง `contact.metadata`
  - **แสดงเป็นข้อความธรรมดาเท่านั้น** (key: value หรือ `<pre>{JSON.stringify(…, null, 2)}</pre>`) ห้าม `dangerouslySetInnerHTML` ห้ามทำเป็นลิงก์/รูปอัตโนมัติ เพราะ metadata ขาเข้ามาจาก client ใครก็ใส่ได้
- แจ้งในหน้าแชตว่า "ประวัติ guest เก็บ 7 วัน"
- หน้าจัดการ `ChatApplication` (ตอนนี้ใช้ REST/Swagger)
- โครงสร้าง `features/appChat/` (services, hooks) ตามแบบ `features/setting/connection`

---

## 10. สถานการณ์โจมตี/ช่องโหว่ และเทสต์ที่ต้องมี

คอลัมน์ "ผลจริง": ผู้ทำกรอก **OK** (ป้องกันได้) หรือ **FOUND→FIXED** (เจอช่องโหว่ แก้แล้วในคอมมิต …)

| # | สถานการณ์ | จะพังที่ไหน | ป้องกันด้วย | เทสต์ (ชื่อ it) | คาดหวัง | ผลจริง |
|---|---|---|---|---|---|---|
| T1 | สแปมแชตจาก session เดียว | ใช้เครดิต AI/DB โต | M2,M3,M6 + strike contact | `blocks the 11th message within 10s and strikes the contact` | 429 + strike · ครั้งที่ 3 แบน | OK — `app-abuse.service.spec` (ข้อความที่ 11 โดน 429 และ strike เฉพาะ `app:<id>`) · การแบนที่ strike 3 เป็นของ `BanService` เดิม ไม่ได้เทสต์ซ้ำ |
| T2 | สแปม session จาก IP เดียว | DB โตด้วย contact/session ขยะ | S1,S3 | `rejects the 21st session in 10 minutes from one ip` · `rejects when 50 active sessions share an ip` | 429 · strike IP | OK — `app-abuse.service.spec` (ข้อ 21 ใน 10 นาที, 50 session ต่อ IP) |
| T3 | **หมุน session ทุกข้อความ** (สร้างใหม่แล้วส่ง 1 ข้อความ วนไป) | limit ต่อ contact ไม่ทำงานเพราะเป็น contact ใหม่ทุกครั้ง | M4 (นับรวมทุก session ของ IP) + S1 | `ip-level message limit counts across rotating sessions` | ข้อความที่ 31 ในนาทีเดียวกันโดน 429 แม้เป็น session ต่างกัน | OK — `app-abuse.service.spec` (30 contact คนละ session ต่อ IP เดียว ข้อที่ 31 โดนบล็อก) |
| T4 | session สแปม + แชตสแปมสลับกัน | strike ของ contact ถูกทิ้งเมื่อทิ้ง session | strike ระดับ IP (S1/S3/M4) + แบน `appip:` | `ip ban blocks creating new sessions and sending messages` | IP ที่ถูกแบนสร้าง session ไม่ได้ (429 `APP_BANNED`) | OK — IP ถูกแบนผ่าน `assertIpAllowed` ซึ่งเรียกใน `AppKeyGuard` ก่อนตรวจ key จึงครอบทุก route (สร้าง session และส่งข้อความ) |
| T5 | หลาย IP (botnet) ยิงพร้อมกัน | limit ต่อ IP ไม่พอ | M5 โควตาต่อ app/วัน + M7 ตัวจำกัด turn + (phase 2: งบ scope app, captcha) | `app daily quota stops further messages` · `inflight limit rejects over max` | 429 `APP_RATE_LIMITED`/`APP_BUSY` | OK (ส่วนที่ป้องกันได้) — โควตา app/วัน และ turn limiter ผ่านเทสต์ + Redis จริง · botnet หลาย IP ยังใช้โควตา app ได้จนหมดวัน (ข้อจำกัดที่ยอมรับ) |
| T6 | ผู้ใช้จริงหลายคนใช้ IP เดียว (NAT/ออฟฟิศ) ถูกแบนทั้งก้อน | false positive | strike IP เฉพาะ limit ระดับ IP · ค่าปรับด้วย env | `a single noisy contact does not ban the ip` | contact ชน M2 แล้ว IP ยังไม่ถูก strike | OK — `app-abuse.service.spec` |
| T7 | ปลอม `X-Forwarded-For` / `CF-Connecting-IP` เพื่อเลี่ยง limit (ทั้งผ่าน Cloudflare และยิงตรงเข้า IP ของ VPS) | limit ต่อ IP ไร้ผล | nginx realip เฉพาะ IP ของ Cloudflare + เขียนทับ XFF · app `trustProxy`=1 (ไม่ใช่ `true`) · app ไม่อ่าน `cf-connecting-ip` | unit: `uses the proxy-added address, not a spoofed leftmost one` · `ignores cf-connecting-ip header` · ตรวจบน VPS ตาม Deploy checklist ข้อ 3 | IP ที่ใช้ = IP ลูกค้าจริง ไม่ใช่ค่าที่ปลอม | OK — unit (`ignores a spoofed cf-connecting-ip header`) + ตรวจสดบน instance ทดสอบที่ `TRUST_PROXY_HOPS=1`: ค่าซ้ายสุดของ XFF ที่ปลอมไม่เปลี่ยน ipHash, `cf-connecting-ip` ถูกเมิน · **ฝั่ง nginx/Cloudflare ต้องตรวจบน VPS** (Deploy checklist ข้อ 3) |
| T8 | ส่งข้อความเดียวกันซ้ำ (กดซ้ำ/เน็ตกระตุก) | AI ถูกเรียกสองรอบ เสียเงินสองครั้ง | `clientMessageId` unique + replay | `retry with same clientMessageId returns the first answer without calling the bot again` | เรียกบอท 1 ครั้ง | OK — `app-message.service.integration.spec` + ตรวจสดด้วย curl (ส่งซ้ำได้คำตอบเดิม) |
| T9 | `clientMessageId` เดิมแต่ข้อความต่าง | ตอบผิดข้อความ | เทียบ text | `rejects reused clientMessageId with different text` | 409 | OK — integration + curl สด (409) |
| T10 | สุ่ม `clientMessageId` ใหม่ทุกครั้งเพื่อเลี่ยง idempotency | ข้ามการ dedupe | rate limit (ไม่พึ่ง id) | `random ids are still rate limited` | 429 ตามปกติ | OK — `random ids are still rate limited` (gate ไม่ดู clientMessageId) |
| T11 | ส่ง 2 ข้อความพร้อมกันในห้องเดียว | ตอบสลับลำดับ / session Redis ชนกัน | lock ในห้องใน DB | `second concurrent message gets 409 busy` | 1 สำเร็จ 1 ได้ 409 | OK — integration (ข้อความที่สองได้ 409 และห้องว่างหลังจบ) |
| T12 | คำขอซ้ำสองอันพร้อมกัน (id เดียวกัน) | unread นับสองครั้ง / บอทตอบสองครั้ง | unique + ชน P2002 → อ่านแถวเดิม | `parallel identical requests create one inbound row and one unread` | `unreadCount=1`, บอทถูกเรียก 1 ครั้ง | OK — integration (สองคำขอ id เดียวกัน → แถวขาเข้า 1, unread 1, เรียกบอท 1 ครั้ง) |
| T13 | process ตายกลาง turn | ข้อความค้าง PROCESSING | lease + reclaim + billing replay | `expired lease can be reclaimed and bills once` | ตอบได้ ไม่หักซ้ำ (`turnId` เดิม) | OK — integration (lease หมด → reclaim, `turnId` เดิม `app:<id>`, unread ไม่เพิ่ม) |
| T14 | process ตายซ้ำเกิน `MAX_ATTEMPTS` | วนไม่จบ | `FAILED` | `stops reclaiming after max attempts` | 503 และสถานะ FAILED | OK — integration (`APP_MAX_ATTEMPTS=2` → FAILED และเรียกบอทแค่ 2 ครั้ง) + maintenance ปิดข้อความที่ค้าง |
| T15 | แอดมินตอบระหว่างที่บอทกำลังคิด | ลูกค้าได้คำตอบบอททับแอดมิน | เช็ก mute ซ้ำใน `saveReply` | `drops the bot answer when an admin muted the chat meanwhile` | `NO_REPLY` | OK — integration (`isMuted` เป็น true ตอน saveReply → `NO_REPLY`, ไม่ append context) |
| T16 | token ขโมย/ซ้ำ | ใช้แทนตัวตน | sha256 ใน DB, header เท่านั้น, revoke, sliding+เพดาน | `stored only as hash` · `rejects after revoke` · `max age cap` | 401 | OK — เก็บเฉพาะ hash, revoke, เพดานอายุ 180 วัน, sliding ไม่เกินเพดาน (`app-session.service.spec`) |
| T17 | ใช้ token ของ app A กับ key ของ app B | ข้าม app | ผูก `contact.applicationId` | `rejects token with another app key` | 401 | OK — `rejects token with another app key` |
| T18 | อ่านห้องคนอื่น (IDOR) | รั่วข้อมูล | หาห้องจาก token เท่านั้น ไม่รับ id จาก client | `ignores conversationId in query/body` · `guest A cannot read guest B` | ไม่เห็นของ B | OK — query/body ที่มี `conversationId`/`guestId` ถูกปฏิเสธ (strict) · ห้องหาจาก token เท่านั้น · guest A อ่านของ B ไม่ได้ (integration) |
| T19 | body ใหญ่/JSON ลึก/field แปลก | memory, parser | bodyLimit 16KB + zod `.strict()` + จำกัด metadata | `rejects 20KB body` · `rejects unknown fields` · `rejects oversized metadata` | 413/400 | OK — body 20KB → 413 ตรวจสดที่ `/api/app/v1/sessions` และ route อื่นไม่ถูกจำกัด · field แปลก/metadata ใหญ่ถูกปฏิเสธ (unit) · JSON เสียได้ 400 รูปแบบ Fastify (ไม่รั่วรายละเอียด) |
| T20 | ข้อความว่าง/มีแต่ zero-width/control | ผ่านไปถึง AI หรือทำให้สแปมตรวจพลาด | sanitize + trim + ปฏิเสธว่าง | `rejects text empty after sanitizing` | 400 | OK — `app-text.spec` + integration (ไม่สร้างห้อง) |
| T21 | prompt injection ผ่าน `metadata`/`displayName` | ข้อมูลที่ client คุมเข้า prompt | ไม่ส่ง metadata/displayName ให้ core | `core request contains only text, userId, conversationId, turnId, channel` | ไม่มีฟิลด์อื่น | OK — integration (`handleTextMessage` ได้เฉพาะ channel, conversationId, recentMessages, text, turnId, userId) |
| T22 | กด ปลอม/เดา `X-App-Key` | สแกนหา key | limit การพิสูจน์ตัวตนล้มเหลวต่อ IP (A2) + key สุ่ม 192 บิต | `repeated invalid keys trigger throttle` | 429 | OK — `repeated invalid keys trigger throttle` · key รูปแบบผิดไม่ถึง DB |
| T23 | แอปถูกปิด/หมุน key แล้วยังใช้ได้ | สิทธิ์ค้าง | ตรวจ status ทุกคำขอ (cache 60 วินาที) · rotate ล้าง cache | `disabled app is rejected` · `rotated key invalidates old key immediately` | 401 | OK — rotate/ปิดมีผลทันทีบน instance ที่ทำรายการ · ข้าม instance ช้าได้สูงสุด 60 วินาที (cache) — ข้อจำกัดที่บันทึกไว้ |
| T24 | CORS ปลอม Origin | เปิดให้เว็บอื่นเรียกจากเบราว์เซอร์ | `allowedOrigins` ต่อ app (ไม่ใช้เป็นเกราะป้องกัน non-browser) | `rejects origin not in allowedOrigins` · `request without Origin is allowed` | 403 / ผ่าน | OK — `AppKeyGuard` (403 / ไม่มี Origin ผ่าน / ไม่แยกตัวพิมพ์) + ตรวจ preflight สด: origin ที่ไม่อยู่ในรายการไม่ได้ `access-control-allow-origin`, route admin ยังตอบเหมือนเดิม |
| T25 | Redis ล่ม | limit หายเงียบ ๆ | fail closed | `returns 503 when redis is down` | 503 ไม่ใช่ผ่าน | OK — abuse gate คืน 503 เมื่อ `consume`/ban lookup/turn limiter ล้มเหลว |
| T26 | เครดิตหมด/งบหมด | ลูกค้าเห็นรายละเอียดภายใน | core คืนข้อความว่าง → `NO_REPLY` | `does not leak credit details` | ไม่มีข้อความเรื่องเครดิต | OK — `NO_REPLY` ไม่มีข้อความเรื่องเครดิต/wallet/cost ใน response |
| T27 | ขอคุยแอดมินแล้วไม่มีใครรู้ | ลูกค้ารอไม่มีวันจบ | C2 + C3 | `handoff creates waiting_admin and notification for app conversations` | มี notification | OK — unit + ตรวจสด: ห้องเป็น `waiting_admin`, `handoff:true`, สร้าง notification `metadata.channel='APP'` · ไม่แตะ `lineConversation` |
| T28 | พิมพ์ "สมัคร" แล้วเข้า flow สมัครของ LINE | สร้างข้อมูลผิด/error | C1 | `register is unavailable for app channel` | ข้อความ `registerUnavailable` | OK — `channel-registration.spec` + ตรวจสด ('สมัคร' → `registerUnavailable`) · LINE ที่ไม่ส่ง channel ยังเริ่มสมัครได้เหมือนเดิม |
| T29 | ข้อมูลสะสม guest ไม่กลับมา | DB โต | maintenance job | `cleans expired sessions and orphan contacts` | ลบเฉพาะที่หมดอายุ | OK — `app-maintenance.service.integration.spec` (ลบเฉพาะที่หมดอายุ, ไม่ลบ contact ที่มีห้อง/ผูก customer) |
| T30 | poll `GET /messages` ถี่ | ใช้ DB หนัก | R1,R2 + limit ≤100 | `read limit per session and ip` | 429 | OK — `read limit per session and ip` |
| T31 | ข้อความที่ส่งแล้วหลุดจากผู้ใช้ | ต้องดึงซ้ำได้ | GET cursor `(createdAt,id)` | `cursor pagination does not skip or repeat messages with equal timestamps` | ครบ ไม่ซ้ำ | OK — integration (5 ข้อความ timestamp เดียวกัน อ่านทีละ 2 ไม่ข้ามไม่ซ้ำ; cursor ที่ชี้ข้อความที่ถูกลบยังใช้ได้) |
| T32 | ฟีเจอร์ปิดอยู่แต่ route ถูกเรียก | เผยตัวตนของระบบ | `AppFeatureGuard` | `returns 404 when APP_MESSAGE_ENABLED=false` | 404 ทุก route | OK — `AppFeatureGuard` + ตรวจสด: ปิดฟีเจอร์ → ทุก route 404 และแอปบูตได้โดยไม่มี salt |
| T33 | ใส่ `<script>`/`javascript:` ใน `metadata`/`displayName`/`text` (stored XSS โจมตีแอดมิน) | dashboard ของแอดมิน | backend เก็บตามจริงแต่จำกัดขนาด · dashboard แสดงเป็นข้อความเท่านั้น (Step 15) | backend: `stores html-like metadata verbatim and returns it as json string` · frontend: `renders metadata as text, not html` | ไม่มี element ใหม่ใน DOM | Backend OK — เก็บและคืนเป็น string ตามจริง ไม่มีการตีความ · **ฝั่ง dashboard ยังไม่ทำ (Step 15)** ต้องแสดงเป็นข้อความธรรมดา |
| T34 | core เพิ่ม field ภายในใน `ChatResponse` แล้วหลุดไปที่ client ผ่าน metadata | รั่ว `costThb`/id ภายใน | whitelist ใน `buildReplyMetadata` | `reply metadata contains only whitelisted fields` | มีแค่ `v, source, handoff, products[].productId` | OK — `app-message.metadata.spec` (field แปลกใน response/catalogRefs ไม่หลุด) |
| T35 | ประวัติ guest ค้างเกิน 7 วัน (รวมใน notification) | ผิดนโยบายที่ตั้งไว้ / ข้อมูลส่วนบุคคลค้าง | maintenance Step 11 งาน 1–3 | `purges messages, stale conversations and app notifications older than retention` | เหลือแต่ข้อมูลใน 7 วัน | OK — maintenance integration (ข้อความ/ห้อง/notification เก่ากว่า retention ถูกลบ) |
| T36 | งานลบประวัติไปลบของ LINE หรือข้อมูล billing | ข้อมูลสำคัญหาย | where ต้องมี `channel=APP` / `userId` ขึ้นต้น `app:` · ไม่แตะตาราง usage | `retention keeps line notifications and ai usage events` | ของ LINE และ billing อยู่ครบ | OK — maintenance integration (notification ของ LINE และ `aiUsageEvents` ยังอยู่) |
| T37 | ผู้โจมตีส่ง `X-App-Key` มั่ว ๆ จำนวนมากเพื่อให้ cache ของ key จริงถูกล้าง | cache เต็ม 1,000 รายการแล้ว `clear()` → ทุกคำขอจริงยิง DB | **FOUND→FIXED** (Step 12): ไม่ cache key ที่ไม่มีอยู่/ถูกปิด · key ที่ไม่ผ่านรูปแบบไม่ถึง DB · การพยายามเดาโดน A2 | `unknown keys never enter the cache, so scanning cannot evict real keys` | key จริงยังอยู่ใน cache หลังยิง key มั่ว 1,500 ครั้ง | FOUND→FIXED — เจอจากการไล่โค้ดตอนเขียน Step 12 แก้ใน `chat-application.service.ts` |
| T38 | Redis ล่มแล้วถูกตีความเป็น "ชน limit" (ตอบ 429 ผิด และลูกค้าไม่ retry) | แยกไม่ออกระหว่างปฏิเสธเพราะ limit กับเพราะระบบล่ม | **FOUND→FIXED** (Step 7): `RateLimitResult.unavailable` | `returns 503, not a pass, when redis is down` | 503 `APP_UNAVAILABLE` | FOUND→FIXED — เพิ่มฟิลด์ใน `rate-limit.service.ts` (caller เดิมไม่กระทบ) |
| T39 | `core-api` เปิดพอร์ตออกอินเทอร์เน็ตตรง ๆ ข้าม nginx/Cloudflare | `trustProxy=1` เชื่อ `X-Forwarded-For` ที่ client ส่งเอง → ปลอม IP หลบ limit | ตรวจ/ปิดบน VPS (Deploy checklist ข้อ 3) · โค้ดแก้เองไม่ได้ | ตรวจด้วยมือ: `curl http://<IP ของ VPS>:8080/...` ต้องต่อไม่ติด | ต่อไม่ติด | **ยังไม่ได้ตรวจ** (ไม่มี production compose ใน repo) |

ข้อจำกัดที่ยอมรับใน phase 1 (ระบุให้ผู้ใช้รู้ ไม่ใช่ช่องโหว่ที่ซ่อน):
- `publicKey` เห็นได้จากโค้ดเว็บ ใครก็สร้าง guest ได้ → พึ่ง rate limit/โควตา · captcha/app attestation ทำ phase 2
- botnet ที่กระจาย IP มากพอยังใช้โควตาของ app ได้จนหมดวัน (M5 คือเพดานความเสียหาย)
- fixed window: ยิงชิดขอบ window ได้ ~2 เท่าชั่วขณะ
- ไม่มี push: guest ต้อง poll `GET /messages` เพื่อรับข้อความแอดมิน
- guest ที่ token หมดอายุ/หาย = ตัวตนใหม่ ประวัติเดิมเข้าถึงไม่ได้ (แอดมินยังเห็นจนครบ 7 วัน)
- ประวัติเก่ากว่า 7 วันหายทั้งฝั่ง guest และแอดมิน (ตั้งใจ) · ถ้าต้องเก็บหลักฐานนานกว่านี้ต้องเปลี่ยน `APP_HISTORY_RETENTION_DAYS`
- ใครรู้ IP ของ VPS ยิงตรงได้โดยไม่ผ่าน Cloudflare (IP ยังถูกต้อง แต่ไม่ได้รับการป้องกัน DDoS ของ Cloudflare) จนกว่าจะทำ firewall ตามหัวข้อ 8.2 ข้อ 6

---

## 11. Environment variables (ทั้งหมดมีค่าเริ่มต้น)

| ตัวแปร | default | ความหมาย |
|---|---|---|
| `APP_MESSAGE_ENABLED` | `false` | เปิด/ปิดทั้งฟีเจอร์ (ปิด = ทุก route 404) |
| `APP_IP_HASH_SALT` | – (**บังคับเมื่อเปิด**, ≥16 ตัว) | salt ของ ipHash |
| `TRUST_PROXY_HOPS` | `0` | จำนวน proxy หน้า app · production = `1` (Cloudflare ไม่นับ เพราะ nginx แปลง IP ให้แล้ว ดูหัวข้อ 8.2) |
| `APP_HISTORY_RETENTION_DAYS` | `7` | ลบข้อความ/ห้อง/notification ของ guest ที่เก่ากว่านี้ (ขั้นต่ำ 1) |
| `APP_SESSION_TTL_DAYS` | `30` | sliding |
| `APP_SESSION_MAX_AGE_DAYS` | `180` | เพดานสูงสุด |
| `APP_SESSION_TOUCH_SEC` | `3600` | เขียน lastSeenAt ไม่ถี่กว่านี้ |
| `APP_SESSION_CREATE_IP_10M` / `_IP_HOUR` / `_APP_MIN` | `20` / `60` / `300` | S1,S2 |
| `APP_MAX_ACTIVE_SESSIONS_PER_IP` | `50` | S3 |
| `APP_MSG_BURST_LIMIT` / `_BURST_WINDOW_SEC` | `10` / `10` | M2 |
| `APP_MSG_HOURLY_LIMIT` / `_DAILY_LIMIT` | `60` / `300` | M3 |
| `APP_MSG_IP_MIN` / `_IP_HOUR` / `_IP_DAY` | `30` / `300` / `2000` | M4 |
| `APP_MSG_APP_DAY` | `20000` | M5 (`0` = ไม่จำกัด) |
| `APP_MAX_INFLIGHT_TURNS` | `20` | M7 |
| `APP_READ_SESSION_MIN` / `_IP_MIN` | `60` / `300` | R1,R2 |
| `APP_AUTHFAIL_IP_MIN` | `30` | A2 |
| `APP_TEXT_MAX_CHARS` | `2000` | ความยาวข้อความ |
| `APP_BODY_LIMIT_BYTES` | `16384` | ขนาด body |
| `APP_TURN_LEASE_SEC` | `120` | lease ของ turn/lock |
| `APP_MAX_ATTEMPTS` | `5` | จำนวนครั้ง reclaim |

---

## 12. เพิ่มช่องทางใหม่ (Facebook / Shopee / TikTok) ในอนาคต

1. เพิ่มค่า enum `ChatChannel` (migration `ALTER TYPE … ADD VALUE`) และคอลัมน์ `externalMessageId` (unique ต่อ channel) สำหรับ dedup ของ webhook
2. สร้าง module `src/modules/<channel>-message/` ของตัวเอง: webhook controller (ตรวจลายเซ็น raw body), คิว BullMQ ของช่องนั้น (ต้องใช้คิวเพราะ webhook ต้องตอบเร็ว), `<Channel>ChannelAdapter implements ChannelAdapter` ที่ `deliver()` ส่งออกผ่าน API ของแพลตฟอร์ม
3. ใช้ `ChannelContact`/`ChannelConversation`/`ChannelMessage` ร่วมกัน (`channel` ต่างกัน) และ `MessageProcessorService` ตัวเดิม
4. ลงทะเบียน handler กับ `ChannelHandoffRegistry` ด้วย prefix ของช่องนั้น (`fb:`, `shopee:`)
5. ทำ `InboxService` กลางรวมทุกช่องทาง (ตอนนี้ dashboard รวม LINE กับ app ฝั่ง client)
6. ใช้ `channel` ใน `ChatRequest` ต่อเพื่อเปิด/ปิดความสามารถ (สมัครสมาชิก ฯลฯ) ต่อช่องทาง

---

## 13. Definition of done (ทั้ง phase 1)

- ทุก Step 1–13 เสร็จ · เทสต์ทุกแถวในหัวข้อ 10 มีผลจริง · ไม่มี fail เพิ่มจาก baseline · `bunx tsc --noEmit`, `npx eslint <ไฟล์ที่แก้>`, `bun run build` ผ่าน
- LINE ทำงานเหมือนเดิม: รันชุดเทสต์ LINE/chatbot เดิมทั้งหมดแล้วผลเท่า baseline
- เอกสารอัปเดต · สรุปท้ายงานระบุ: สิ่งที่ทำ, เช็กอะไรไปแล้ว, สิ่งที่ยังไม่ได้ตรวจ, ความเสี่ยงตอน deploy

### Deploy checklist
1. merge เข้า main = migration ขึ้น production ทันที (ตารางใหม่ล้วน เสี่ยงต่ำ) · `APP_MESSAGE_ENABLED` ยังเป็น `false`
2. ตั้ง env บน VPS: `APP_IP_HASH_SALT` (สุ่ม ≥16 ตัว เก็บแยก), `TRUST_PROXY_HOPS=1`
3. nginx (ทำก่อนเปิดฟีเจอร์ ทำตามหัวข้อ 8.2) · **ก่อนอื่นตรวจว่า `core-api` ไม่ได้ publish พอร์ตออกนอก** (`docker compose ps` ต้องไม่มี `0.0.0.0:8080->8080` และ `ss -ltnp | grep 8080` บน VPS ต้องไม่ listen ที่ `0.0.0.0` จากภายนอก) ไม่งั้น `trustProxy=1` เชื่อ `X-Forwarded-For` ที่ client ปลอมได้ (T39):
   - ก่อนแก้: ดู `docker compose logs nginx --tail 20` ว่า IP ต้นบรรทัดเป็นช่วงของ Cloudflare (`104.16–31.x`, `172.64–71.x`, `162.158.x`, `141.101.x` ฯลฯ) **ถ้าเป็น `172.17–31.x` ของ docker ให้หยุดแก้ docker ก่อน**
   - ใส่ `set_real_ip_from` ครบทุกช่วงของ Cloudflare + `real_ip_header CF-Connecting-IP` + `proxy_set_header X-Forwarded-For $remote_addr` · `client_max_body_size 16k` สำหรับ `location /api/app/` · `proxy_read_timeout 90s`
   - `docker compose exec nginx nginx -t` ผ่าน → reload
   - หลังแก้: log ของ nginx ต้องเป็น IP ของคนจริง (เปิดเว็บจากมือถือ 4G แล้วดูว่าไม่ใช่ IP ของ Cloudflare)
   - ทดสอบปลอม: `curl -H "CF-Connecting-IP: 1.2.3.4" --resolve api.keela-agent.online:443:<IP ของ VPS> https://api.keela-agent.online/...` → log ต้อง**ไม่ใช่** `1.2.3.4`
   - กดทดสอบ webhook LINE ในหน้า setting/connection → ต้องผ่าน
4. เปิด `APP_MESSAGE_ENABLED=true` → สร้าง `ChatApplication` ผ่าน Swagger → ทดสอบ session → message ด้วย curl → ดู log ว่าเห็น `ipHash` ที่ต่างกันต่อผู้ใช้ (ไม่ใช่ค่าเดียวกันทุกคำขอ)
5. ใช้ค่า limit เริ่มต้นตามหัวข้อ 11 แล้วดู log ตามหัวข้อ 8.5 ทุกวันในสัปดาห์แรก ปรับผ่าน env (ไม่ต้อง deploy โค้ดใหม่ แค่ restart container)
6. แจ้งเจ้าของเว็บ/แอปที่เชื่อมว่าประวัติแชตเก็บ 7 วัน (ใส่ใน privacy notice ของเขา)

---

## 14. คำถามที่ผู้ใช้ตอบแล้ว (25 ต.ค. 2026)

1. **ค่า limit เริ่มต้น** → ใช้ค่าในหัวข้อ 11 ไปก่อน ปรับด้วย env จาก log ตามหัวข้อ 8.5 หลังเปิดใช้จริง
2. **Cloudflare/load balancer** → มี Cloudflare (proxy เปิด) + nginx → ใช้วิธีในหัวข้อ 8.2, `TRUST_PROXY_HOPS=1`
3. **metadata** → เก็บทั้งขาเข้าและขาออก แอดมินเห็นทั้งคู่ เน้น metadata ของ response (หัวข้อ 4.1)
4. **เก็บประวัติ guest** → 7 วันแล้วลบ (Step 11, `APP_HISTORY_RETENTION_DAYS`)

ต่อคน (session)	10 ข้อความ/10 วินาที, 300/วัน
ต่อ IP	50 ข้อความ/นาที
ทั้งแอปต่อวัน	5,000 ข้อความ

---

## 15. บันทึกการทำจริง (25 ต.ค. 2026)

### สถานะแต่ละ Step
| Step | สถานะ | หมายเหตุ |
|---|---|---|
| 0 | ทำแล้ว | baseline: tsc 13 error, jest 8 suite / 25 test fail (ของเดิม ไม่ได้มาจากงานนี้) |
| 1 | ทำแล้ว | migration `20261026000000_app_message_channel` ใช้บน DB ในเครื่องแล้ว (production ขึ้นตอน merge เข้า main) |
| 2–11 | ทำแล้ว | ดูด้านล่างสำหรับส่วนที่ต่างจากแผน |
| 12 | ทำแล้ว | T1–T36 + T37–T39 ที่เจอเพิ่ม (หัวข้อ 10) |
| 13 | ทำแล้ว | [app-message-flow.md](../app-message-flow.md), หัวข้อ 7.2 ใน `line-message-e2e-current.md` · ไม่มี `.env.example` ในโปรเจกต์ |
| 14, 15 | **ยังไม่ทำ** | ตามแผน |

### เช็กอะไรไปแล้ว
- `bunx tsc --noEmit`: 13 error เท่า baseline (ไม่มีเพิ่ม) · `tsc -p tsconfig.build.json` ไม่มี error
- `npx eslint` ไฟล์ที่เขียนใหม่ผ่านหมด · ไฟล์เดิมที่แก้ (`chatbot.service.ts`, `main.ts`) มี lint เดิมค้างอยู่ที่ HEAD เท่าเดิม ไม่เพิ่ม
- เทสต์ใหม่ทั้งหมดผ่าน (รวม integration กับ Postgres/Redis ในเครื่อง)
- ตรวจสดด้วย curl บน instance ทดสอบ (พอร์ต 8081) ทั้งโหมดปิด/เปิด: session, message, ส่งซ้ำ, 409, handoff, notification, CORS, body limit, XFF spoof
- **ยังไม่ได้ตรวจ:** nginx/Cloudflare จริงบน VPS · การเรียก AI จริงผ่าน app (ใช้เฉพาะข้อความที่ rule ตอบ) · ฝั่ง dashboard · แอดมินเรียก `/api/admin/app-conversations` ผ่าน HTTP จริง (ตรวจแค่ว่า route ถูก register และตอบ 401 โดยไม่มี token; ตัว service ผ่าน integration)

### คำสั่งรันเทสต์
```bash
bun run test -- app-message app-handoff app-session app-guards app-abuse app-turn app-text app-inbox app-maintenance chat-application client-ip app-error user-session channel-registration notification
# integration (ต้องมี Postgres/Redis ในเครื่อง; ปฏิเสธถ้า DATABASE_URL ไม่ใช่ localhost; ลบข้อมูลที่สร้างเองเมื่อจบ)
DATABASE_URL=… REDIS_HOST=… REDIS_PORT=… REDIS_PASSWORD=… APP_MESSAGE_INTEGRATION_TEST=true NODE_OPTIONS=--experimental-vm-modules npx jest app-message
```
(Prisma ใน jest ต้องใช้ `--experimental-vm-modules`)

### ต่างจากแผน
1. **A1 (ban ของ IP) อยู่ใน `AppKeyGuard`** ไม่ใช่ใน `assertMessage` — ครอบทุก route รวมสร้าง session และกันการเดา key ของ IP ที่ถูกแบน · `assertMessage` ตรวจ ban ของ contact (M1) ต่อ
2. **`RateLimitResult.unavailable`** เพิ่มจากแผน (T38) เพื่อแยก Redis ล่มออกจากชน limit
3. **ไม่ cache key ที่ไม่มี/ถูกปิด** (T37)
4. `GET /messages` ไม่มีข้อความใหม่ → คืน `nextCursor = after` เดิม (ไม่ใช่ null) เพื่อให้ poll ต่อได้
5. admin ตอบ: `clientMessageId` = `admin:` + sha256(adminId|clientRequestId)[0:40] (ใส่ id สองตัวตรง ๆ เกิน 64 ตัว)
6. inbox ซ่อนห้องที่ `lastMessage = ''` (ห้องที่สร้างแล้วแต่ข้อความแรกยังไม่ถูกบันทึก เช่นชน `APP_BUSY`)
7. maintenance ปิดข้อความที่ค้าง PROCESSING เกิน 1 วันเป็น FAILED ด้วย (แผนมีแค่กรณี attempts ครบ) เพื่อไม่ให้ค้างถาวรเพราะ purge ข้าม PROCESSING
8. `AppMaintenanceService` ทำงานแม้ปิดฟีเจอร์ (ให้ retention ยังบังคับใช้หลังปิด)
9. เตือนตอนบูตเมื่อเปิดฟีเจอร์แต่ `TRUST_PROXY_HOPS=0`
10. `main.ts`: `app.listen(8080)` → `app.listen(port)` (ใช้ `PORT` ที่ประกาศไว้แล้ว ค่า `.env` เดิมคือ 8080 จึงไม่เปลี่ยนพฤติกรรม) เพื่อรัน instance ทดสอบคู่กับ dev server ได้
11. `DELETE /session` ห้ามส่ง `Content-Type: application/json` โดยไม่มี body (Fastify ตอบ 400) · JSON เสียและ body ใหญ่ได้ error รูปแบบ Fastify ไม่ใช่ `{code,message}`

### สิ่งที่พบนอกขอบเขต (ไม่ได้แก้)
- `chatbot.service.ts:75` `this.logger.warn('user session ${session}')` พิมพ์ `[object Object]` ทุกข้อความ (เป็น warn) — noise ของเดิม
- debug log ของ core พิมพ์ข้อความลูกค้า (หลัง redact) — เป็นพฤติกรรมเดิมที่ app ใช้ร่วม
- usage ของ app ถูกบันทึกเป็น `LINE_AI_REPLY` scope `*` (Step 14)
- `main.ts` CORS ของ route อื่น: origin ที่ไม่อนุญาตได้ 500 ไม่ใช่ 403 (เดิม)


---

## 16. ปรับเป็น MVP (25 ต.ค. 2026) — สิ่งที่ตัดออกหลังทำ Step 0–13

ผู้ใช้ขอให้ lean ลงเหลือ MVP โดยความปลอดภัยต้องไม่ลด หัวข้อ 3–9 ข้างบนยังอ้างของที่ถูกตัดแล้ว ให้ถือหัวข้อนี้และ [app-message-flow.md](../app-message-flow.md) เป็นหลัก

| ตัดออก | เหตุผล | ความปลอดภัยที่ยังเหลือ |
|---|---|---|
| ตาราง `chatApplications`, `X-App-Key`, admin API `/api/admin/chat-applications`, cache ของ key | key อยู่ในโค้ดฝั่ง client ใครก็ดึงไปใช้ได้ จึงไม่ใช่การป้องกันจริง · 1 deploy = 1 ร้าน | Origin จาก env `APP_ALLOWED_ORIGINS` (guard + CORS), rate limit/ban ต่อ IP และต่อ guest, เพดานรายวันทั้งระบบ, token 256 บิตเก็บแค่ hash |
| `leaseOwner/leaseUntil/attempts/lastError/finalizedAt`, สถานะ FAILED, 202 IN_PROGRESS, `RACE_LOST` | ซ้ำกับ lock ของห้องและ unique `replyToId` | lock ของห้องเป็น claim ของ turn: turn ที่เสีย lock บันทึกคำตอบไม่ได้ · ส่งซ้ำ = คำตอบเดิม · ล้มกลางทาง = ทำใหม่ด้วย `turnId` เดิม |
| `AppTurnLimiter` (Redis ZSET + Lua จำกัด turn พร้อมกัน) | เพดานค่าใช้จ่ายคือ `APP_MSG_DAILY_TOTAL` อยู่แล้ว | เพดานรายวัน + limit ต่อ IP/guest |
| maintenance แบบ Redis lock + batch + failStuck | `deleteMany` ทำซ้ำพร้อมกันได้ไม่เสียหาย ปริมาณข้อมูล 7 วันเล็ก | retention 7 วันยังบังคับ ทุกชั่วโมง |
| cursor/status filter/botMode ของรายการห้องแอดมิน | ทำแบบเดียวกับ inbox LINE | ผูกบริษัทของแอดมินทุก query |
| `externalUserId` ของ contact | ยังไม่มี Facebook/Shopee (เพิ่มคอลัมน์ได้ทีหลังแบบ additive) | – |
| env 26 ตัว → 11 ตัว | ค่าที่ไม่ค่อยปรับย้ายเป็น `APP_LIMITS` ในโค้ด | – |
| limit S2 (สร้าง session ต่อแอป), M3 ราย ชม., R1 (อ่านต่อ session) | ซ้ำกับ limit ที่เหลือ | สร้าง session ต่อ IP/ชม. + session ที่ใช้งานอยู่ต่อ IP ≤ 50, อ่านต่อ IP |

migration `20261026000000_app_message_channel` ถูกเขียนใหม่ (ยังไม่เคยขึ้น production) เหลือ 4 ตาราง

แถว T22, T23, T37 ในหัวข้อ 10 (key ปลอม/หมุน key/cache ของ key) ไม่เกี่ยวแล้วเพราะไม่มี key · T5, T14 เปลี่ยนเป็นเพดานรายวันและ "ส่งซ้ำได้ไม่จำกัดแต่ติด rate limit" · เทสต์ใหม่: `a turn that lost its lock cannot store an answer`, `a crashed turn is redone once its lock expires, with the same turn id and no second unread`
