# แผน: Import ประวัติแชท LINE OA เข้า backend

> สถานะ: implement แล้วบน branch `importLineChat` (2026-11-26) — ดู §12 · แผน v2 2026-11-25 (แก้ตามรีวิว — ดู §11)
> เป้าหมาย: แอดมินเห็นประวัติแชทก่อนเชื่อมต่อระบบ เพื่อตอบลูกค้าได้ถูก
> ขนาดที่ต้องรองรับ: ผู้ใช้ 10k–100k คน, ห้องแชทหลายแสน (LINE export ได้สูงสุด ~100,000 ห้องล่าสุด)

---

## 0. คำตอบสั้น: ท่า "สร้าง lineMember + ห้อง + ประวัติให้เลย" ถูกไหม

**ถูกทิศ แต่มีเงื่อนไข**: `lineMember.lineUserId` เป็น `@unique` NOT NULL และเป็น key ที่ webhook ใช้หา member (`findOrCreateLineMember` ใน `channels/line/line-member.repository.ts`)
ไฟล์ export จาก LINE OA **น่าจะไม่มี userId** (Zaapi จับคู่ด้วยชื่อ; ยังไม่ยืนยัน ต้องดูไฟล์จริง)

| สถานการณ์ | ทำอะไร |
|---|---|
| ได้ userId (followers API — OA ต้อง verified/premium — หรือถ้า CSV มีจริง) | สร้าง `lineMember` + `lineConversation` + `lineChatHistory` ให้เลย |
| ไม่มี userId (บล็อกแล้ว / OA ไม่ verified / ชื่อชน / เปลี่ยนชื่อ) | **ห้ามสร้าง lineMember ด้วย userId ปลอม** → เก็บ thread พักไว้ ผูกอัตโนมัติตอนลูกค้าทักมาครั้งแรก หรือแอดมินผูกเอง |

ทำไมห้าม userId ปลอม: ลูกค้าตัวจริงทักมา → webhook หา `lineUserId` จริงไม่เจอ → สร้าง member + ห้องใหม่ → ห้องซ้ำ 2 ห้อง; แอดมินกดตอบห้องปลอม PUSH fail

ไม่ใช้ LLM ในกระบวนการนี้ (parse + match deterministic, ไม่มี billing)

**ความจริงเชิงธุรกิจ** (บอกเจ้าของ OA ก่อนลงทุนทำเต็ม):
- OA ไม่ verified → `followers/ids` 403 → สร้าง lineMember ล่วงหน้าไม่ได้ ใช้ lazy + ผูกมือเท่านั้น
- จับคู่ด้วยชื่อบน LINE ไทยชนเยอะ (นก, เมย์, บอย, ".") → auto-link อาจได้แค่ราวครึ่งเดียว (ประมาณการ ยังไม่วัด — วัดจริงด้วย dryRun ใน Phase 2)

---

## 1. ไฟล์ที่ได้จาก LINE OA

### ยืนยันแล้ว
- OA Manager (เว็บ) → แชท → ⚙️ ตั้งค่า → แท็บ "พื้นฐาน" → ล่างสุด "Chat history backup" → Create new → Download
- ต้องมี Chat Pro (หรือแพ็กเกจแชทที่ LINE ไทยเรียก) · สร้างได้ **1 ครั้ง/สัปดาห์** · ดาวน์โหลดซ้ำได้
- **.zip** ข้างในเป็น **CSV แยกไฟล์ละ 1 ลูกค้า** · **เฉพาะข้อความ** (ไม่มีรูป/วิดีโอ/ไฟล์)
- ไม่มีตัวเลือกช่วงวันที่ — ได้ทุกอย่างในช่วงที่ LINE เก็บ (≤100k ห้องล่าสุด)

### ยังไม่ยืนยัน (Phase 0)
- ชื่อไฟล์ (น่าจะ display name; บล็อกแล้ว = `Unknown.csv`) และ OS-unsafe chars ถูกแทนที่ยังไง
- header / ชื่อคอลัมน์ / ภาษา / รูปแบบวันที่ / **เวลามีวินาทีไหม** / encoding
- ค่า "ผู้ส่ง" แยกลูกค้ากับบัญชี OA อย่างไร · placeholder ของสติกเกอร์/รูป
- มี userId / chat id ไหม · ขนาดไฟล์จริงต่อจำนวนห้อง

### โครงสร้างที่คาดไว้ (สมมติฐาน ไม่ใช่สเปก)

```
line_oa_backup_20261125.zip
├── สมชาย ใจดี.csv
├── Nok🌸.csv
├── Unknown.csv
└── ...
```

```csv
<metadata 0..n บรรทัด เช่น ชื่อบัญชี, วันที่บันทึก>
sender_type, sender_name, date,       time,  content
User,        สมชาย ใจดี,   2026/05/01, 10:12, สินค้านี้มีสีดำไหมคะ
Account,     MyShop,      2026/05/01, 10:15, มีค่ะ ราคา 590 บาท
User,        สมชาย ใจดี,   2026/05/01, 10:16, [Sticker]
```

**หลักการ parser**:
- หา header row ด้วยชุดชื่อคอลัมน์ที่รู้จัก (หลายภาษา) ใน config `LINE_IMPORT_COLUMN_ALIASES` ไม่ fix บรรทัด
- ตัด BOM, UTF-8 ก่อน; ถ้าไฟล์จริงไม่ใช่ค่อยเพิ่ม `iconv-lite`
- เวลาตีความเป็น `Asia/Bangkok`
- **ชื่อลูกค้า: ใช้ `sender_name` ของแถวฝั่งลูกค้าในเนื้อไฟล์เป็นหลัก** ชื่อไฟล์เป็นแค่ fallback (ชื่อไฟล์อาจถูกตัด/แทนที่ตัวอักษรต้องห้าม)
- แถว parse ไม่ได้ → `errorRows` + ตัวอย่าง ≤20 ใน batch (ไม่ทำทั้งไฟล์ fail)
- parser เป็น pure function ไม่มี I/O และ yield event loop ทุก N แถว (ไม่ block worker)

---

## 2. ภาพรวม flow

```
แอดมิน
  │ 1. POST /chat-imports/uploads        → presigned PUT URL (R2, key ที่ server สร้าง)
  │ 2. PUT zip ตรงขึ้น R2 (ต้องตั้ง CORS บน bucket)
  │ 3. POST /chat-imports {uploadId, options} → server HeadObject ตรวจ → 202 {batchId}
  ▼
BullMQ queue `line-chat-import` (แยกจาก `chat-events`, concurrency 1, งานแตกเป็น chunk)
  ├─ SYNC_FOLLOWERS  (ถ้า OA รองรับ) ทีละหน้า 1,000 ids → profile (throttle) → upsert lineMember
  ├─ PARSE           R2 stream → LINE_IMPORT_TMP_DIR → unzip → csv → lineChatImportThread (ทีละ ≤500 entries/job)
  ├─ MATCH           normalize ชื่อ → LINKED / UNMATCHED / AMBIGUOUS / SKIPPED
  └─ MATERIALIZE     ทีละ thread: upsert lineConversation + dedupe overlap + createMany lineChatHistory
  ▼
ต่อเนื่อง
  └─ ลูกค้าใหม่ทักมา → findOrCreateLineMember (สาขา "ไม่เจอ member") → enqueue LINK_NEW_MEMBER
แอดมิน
  └─ หน้า "รอผูก" → link / relink / unlink
```

---

## 3. Data model (Prisma)

### 3.1 แก้ `LineChatHistory`

```prisma
enum LineChatHistorySource {
  LIVE   @map("live")
  IMPORT @map("import")
}

model LineChatHistory {
  // ...ของเดิม
  source        LineChatHistorySource @default(LIVE)
  importBatchId String?               @db.Uuid
  importThreadId String?              @db.Uuid
  importKey     String?               @db.VarChar(32)   // 128-bit hex
  @@index([importThreadId])
  @@index([lineMemberId, sender])     // ให้ _count ใน users.service เร็วขึ้น
}
```

Migration SQL เพิ่มเอง (Prisma schema แสดง partial index ไม่ได้):

```sql
CREATE UNIQUE INDEX "lineChatHistory_importKey_key"
  ON "lineChatHistory" ("importKey") WHERE "importKey" IS NOT NULL;
```
`createMany({ skipDuplicates: true })` → `ON CONFLICT DO NOTHING` ใช้กับ partial unique index ได้

ไม่ต้องเพิ่ม index `(conversationId, createdAt, id)` — มี `(conversationId, createdAt)` อยู่แล้วและเราทำให้ `createdAt` ไม่ชนกันใน thread เดียว (ข้อ 4) จึงไม่ต้องพึ่ง `id` ในการเรียง

UI ใช้ `GET /api/line/conversations/:id/messages` เดิม แค่ response มี `source` ให้ frontend วาดเส้นคั่น/สีจาง

> ขนาด: ≤100k ห้อง × ~20–50 ข้อความ ≈ 2–5 ล้านแถว (ประมาณการ) — วัดจริงใน Phase 6; ถ้าเกิน ~50 ล้านแถวค่อยแยกตาราง

### 3.2 แก้ `LineConversation` / `LineMember`

```prisma
model LineConversation {
  // ...
  importedAt DateTime?   // มีประวัติ import (badge/filter ใน inbox)
}
model LineMember {
  // ...
  source String @default("webhook")   // "webhook" | "followers_sync"
}
```

### 3.3 ตารางใหม่

```prisma
enum LineChatImportStatus {
  UPLOADED SYNCING_FOLLOWERS PARSING MATCHING MATERIALIZING
  COMPLETED FAILED CANCELLED
}

model LineChatImportBatch {
  id            String   @id @default(uuid()) @db.Uuid
  createdById   String   @db.Uuid
  uploadKey     String                       // server สร้างเอง line-imports/<batchId>.zip
  fileName      String
  fileSize      BigInt                       // จาก HeadObject ไม่ใช่จาก client
  fileSha256    String?
  status        LineChatImportStatus @default(UPLOADED)
  options       Json                         // {fromDate,toDate,syncFollowers,dryRun}
  cursor        Json?                        // checkpoint: followers `next`, entry index
  totalEntries     Int @default(0)
  parsedEntries    Int @default(0)
  totalMessages    Int @default(0)
  skippedByDate    Int @default(0)
  skippedOverlap   Int @default(0)
  errorRows        Int @default(0)
  linkedThreads    Int @default(0)
  unmatchedThreads Int @default(0)
  ambiguousThreads Int @default(0)
  errorSamples  Json?
  errorMessage  String?
  startedAt     DateTime?
  finishedAt    DateTime?
  expiresAt     DateTime?                    // ลบ staging ทั้ง batch เมื่อถึง
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  threads       LineChatImportThread[]
  @@index([status])
  @@map("lineChatImportBatch")
}

enum LineChatImportThreadStatus {
  PENDING MATCHED_PENDING_WRITE MATERIALIZED UNMATCHED AMBIGUOUS SKIPPED
}

model LineChatImportThread {
  id             String @id @default(uuid()) @db.Uuid
  batchId        String @db.Uuid
  batch          LineChatImportBatch @relation(fields: [batchId], references: [id], onDelete: Cascade)
  entryName      String
  rawName        String                 // จาก sender_name ในไฟล์ (fallback ชื่อไฟล์)
  normalizedName String
  status         LineChatImportThreadStatus @default(PENDING)
  lineMemberId   String? @db.Uuid
  conversationId String? @db.Uuid
  createdConversation Boolean @default(false)  // ห้องนี้ import สร้างเอง (ใช้ตอน unlink)
  matchMethod    String?                // followers_name | lazy_first_message | admin_manual
  linkedById     String? @db.Uuid
  messageCount   Int
  firstAt        DateTime
  lastAt         DateTime
  lastText       String?
  messages       Json                   // staging: [{s:"U"|"A", t:ISO(ms), x:text, h:contentHash}]
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  @@unique([batchId, entryName])
  @@index([normalizedName, status])
  @@index([batchId, status])
  @@map("lineChatImportThread")
}
```

- `messages` **เก็บไว้จนกว่า batch หมดอายุ** (ไม่ null หลัง materialize) → unlink/relink ไม่ทำข้อมูลหาย (แก้ C2)
- query list/match/candidates **ห้าม select `messages`** — ใช้ `select` ระบุ field เสมอ; อ่าน `messages` เฉพาะ preview และ MATERIALIZE

---

## 4. Mapping CSV → ตารางเรา

| CSV (คาดไว้) | ปลายทาง | กฎ |
|---|---|---|
| `sender_name` ฝั่งลูกค้า (fallback ชื่อไฟล์) | `thread.rawName` → `normalizedName` | NFC, trim, ยุบช่องว่าง, lower-case, ตัด zero-width; **ไม่ fuzzy** |
| sender_type = ลูกค้า | `sender = USER` | |
| sender_type = บัญชี OA | `sender = ADMIN`, `sentByAdminId = null` | แยก AI/auto-reply/คนไม่ได้ |
| date + time | `createdAt` | ดูกฎเวลาด้านล่าง |
| content | `text` | ตัดเกิน 5,000 ตัว |
| placeholder สติกเกอร์/รูป/ไฟล์ | `messageType = TEXT`, `text = "[สติกเกอร์]"` / `"[รูปภาพ]"` | ไม่มี stickerId/ไฟล์จริง |
| — | `lineMessageId/replyToken/deliveryId/rawEvent = null` | `rawEvent` ไม่เก็บ (F8) |
| — | `sentStatus = "imported"`, `source = IMPORT`, `importBatchId`, `importThreadId` | |

**กฎเวลา (แก้ C3 — ลำดับข้อความ)**: ถ้า CSV ละเอียดแค่นาที ทุกข้อความใน 10:16 จะได้ `createdAt` เท่ากัน แล้ว `line-webhook.service.ts` เรียง tie-break ด้วย `id` (UUID v4 สุ่ม) → ลำดับมั่ว
→ ตอน PARSE: `createdAt = minuteStart + seqInMinute × 10ms` (seq ตามลำดับแถวใน CSV ภายในนาทีเดียวกัน, สูงสุด 5,999 ต่อนาที) — ลำดับตรงกับไฟล์เป๊ะ
ถ้าไฟล์มีวินาทีอยู่แล้ว ใช้หลักการเดียวกันระดับวินาที (`+ seq × 1ms`)

**กฎ key กันซ้ำ (แก้ C3 — importKey)**:
- PARSE (ยังไม่รู้ member): `contentHash = sha256(sender, originalMinute, text, ordinalOfSameTriple)` โดย `ordinalOfSameTriple` นับต่อ `(minute, sender, text)` → ข้อความ "ค่ะ" 2 ครั้งในนาทีเดียวกันไม่ชนกัน
- MATERIALIZE: `importKey = sha256(lineMemberId, contentHash)[0:32]`
- import ไฟล์ export ใหม่ที่ทับช่วงเดิม → key เดิม → `ON CONFLICT DO NOTHING`

**กฎรอยต่อกับแชท LIVE (แก้ C3 — overlap)**: ถ้าเชื่อม webhook แล้ว N วันค่อย import ข้อความช่วงนั้นจะมีทั้ง LIVE และ IMPORT
ตอน MATERIALIZE ต่อห้อง หา `firstLiveAt = MIN(createdAt) WHERE source='live'`:
- ข้อความ import ที่ `createdAt < firstLiveAt − 1 นาที` → ลงปกติ
- ข้อความ import ในช่วง `≥ firstLiveAt − 1 นาที` → ลงเฉพาะที่ **ไม่มี** LIVE แถวที่ sender class ตรงกัน (USER ↔ USER, ADMIN ↔ ADMIN/AI/SYSTEM) + text เหมือนกัน + เวลาห่าง ≤ 1 นาที; ที่ตรงกันนับเป็น `skippedOverlap`
- เหตุผลที่ไม่ตัดทิ้งทั้งช่วง: ข้อความที่แอดมินตอบจากแอป LINE OA หลังเชื่อมแล้ว **ไม่มี webhook** — มีแค่ใน export นี้ ถ้าตัดทิ้งหมดจะหายไป
- option `overlapMode: "dedupe" (default) | "skipAfterFirstLive"`

**`lineConversation` ตอน materialize**:
- ยังไม่มีห้อง → create (`lastMessage*` = ข้อความ import ล่าสุด, `unreadCount = 0`, `status = "open"`, `importedAt = now`), thread `createdConversation = true`
- มีห้องแล้ว → **ไม่ทับ** `lastMessage*` ถ้า `lastMessageAt` เดิมใหม่กว่า, ไม่แตะ `unreadCount`, set `importedAt`

---

## 5. Endpoints

ทั้งหมด `@AdminGuard()` role `dev` / `owner` · prefix `api/line/admin/chat-imports` · flag `LINE_IMPORT_ENABLED`
**ต้องใช้ `STORAGE_DRIVER=r2`** (ค่า default คือ `local`) — ถ้าไม่ใช่ r2 → endpoint ตอบ 409 `IMPORT_REQUIRES_R2` (เส้นทาง local multipart ทำทีหลังถ้าจำเป็น)

### 5.1 `POST /uploads` — ขอ URL อัปโหลด
```jsonc
// req
{ "fileName": "backup.zip", "fileSize": 734003200 }
// res 201
{ "uploadId": "<uuid>", "uploadUrl": "https://…r2…", "expiresAt": "…" }
```
- **server สร้าง key เอง** `line-imports/<uploadId>.zip` client ไม่ได้เลือก key
- presigned PUT ผูก `ContentLength` + `ContentType: application/zip`, หมดอายุ 1 ชม.
- ไฟล์ > 100 MB → ใช้ **S3 multipart upload** (`POST /uploads/:id/parts` คืน presigned URL ต่อ part, `POST /uploads/:id/complete`) เพื่อให้หลุดกลางทางแล้วต่อได้
- ตั้ง **CORS บน R2 bucket**: `AllowedOrigins` = origin ของ admin web, `AllowedMethods: PUT`, `ExposeHeaders: ETag` (multipart ต้องใช้ ETag)

### 5.2 `POST /` — เริ่ม import
```jsonc
// req
{
  "uploadId": "<uuid>",
  "options": {
    "fromDate": "2026-01-01", "toDate": null,
    "syncFollowers": true,
    "overlapMode": "dedupe",
    "dryRun": false
  }
}
// res 202
{ "batchId": "…", "status": "UPLOADED" }
```
- server สร้าง key จาก `uploadId` เอง + `isSafeObjectKey()` + ตรวจ prefix `line-imports/` → `HeadObject` เช็คว่ามีอยู่จริง, ขนาด ≤ `LINE_IMPORT_MAX_ZIP_BYTES` → `fileSize` เก็บจาก HeadObject
- ห้ามรับ key ใดๆ จาก client ตรงๆ (ไม่งั้นอาจชี้ไฟล์อื่นใน bucket เช่นรูปสลิป แล้วโดนลบหลัง parse)
- 409 ถ้ามี batch อื่นยังไม่จบ · 409 ถ้า `fileSha256` ซ้ำ batch COMPLETED (`force: true` ได้ — ปลอดภัยเพราะ importKey)

### 5.3 `GET /` และ `GET /:batchId` — สถานะ / progress
```jsonc
{
  "id": "…", "status": "PARSING",
  "progress": { "parsedEntries": 41230, "totalEntries": 98000 },
  "stats": { "totalMessages": 1830211, "skippedByDate": 120400, "skippedOverlap": 82,
             "errorRows": 12, "linkedThreads": 0, "unmatchedThreads": 0, "ambiguousThreads": 0 },
  "errorSamples": [{ "entry": "x.csv", "line": 18, "reason": "BAD_DATE" }],
  "startedAt": "…", "finishedAt": null, "expiresAt": "…"
}
```

### 5.4 `GET /:batchId/threads?status=&q=&cursor=` — รายการ thread (ไม่ select `messages`)
```jsonc
{ "items": [{ "id": "…", "rawName": "Nok🌸", "status": "AMBIGUOUS",
              "messageCount": 37, "firstAt": "…", "lastAt": "…", "lastText": "…",
              "candidates": [{ "lineMemberId": "…", "displayName": "Nok🌸", "pictureUrl": "…",
                               "conversationId": "…", "lastMessageAt": "…" }] }],
  "nextCursor": "…" }
```

### 5.5 `GET /threads/:threadId/preview?limit=50`

### 5.6 `POST /threads/:threadId/link` — ผูก (ใช้ได้ทั้ง UNMATCHED/AMBIGUOUS)
```jsonc
{ "lineMemberId": "…" }   // 202 → enqueue MATERIALIZE
```
409 ถ้า thread ผูกอยู่แล้ว (ใช้ relink) หรือ member นั้นมี thread อื่นใน batch เดียวกันผูกอยู่

### 5.7 `POST /threads/:threadId/relink` — แก้ผูกผิดคน (แก้ C2)
```jsonc
{ "lineMemberId": "<คนที่ถูก>" }
```
ทำใน 1 tx:
1. ลบ `lineChatHistory WHERE importThreadId = :id AND source = 'import'`
2. ห้องเดิม: ถ้า `createdConversation = true` และไม่มีแถว LIVE เหลือ → ลบ `lineConversation`; ไม่งั้นคำนวณ `lastMessage*` ใหม่จากแถวที่เหลือ และถ้าไม่มี import เหลือ `importedAt = null`
3. thread → `MATCHED_PENDING_WRITE` กับ member ใหม่ → หลัง commit enqueue MATERIALIZE (อ่านจาก `thread.messages` ที่ยังอยู่)

### 5.8 `POST /threads/:threadId/unlink` — ปลดผูกเฉยๆ
ข้อ 1–2 เหมือน relink แล้ว thread → `UNMATCHED` (ข้อมูลยังอยู่ใน `thread.messages` ผูกใหม่ได้)

### 5.9 `POST /:batchId/cancel` และ `DELETE /:batchId`
DELETE ลบ `source=IMPORT, importBatchId=…` ทีละ 5k + ห้องที่ import สร้างเองที่ไม่มี LIVE + threads

### 5.10 ฝั่งหน้าแชท
- `GET /api/line/conversations/:id/messages` — เพิ่ม `source` ใน response
- `GET /api/line/conversations/:id/import-candidates` — thread UNMATCHED/AMBIGUOUS ที่ `normalizedName` ตรงกับลูกค้าห้องนี้

---

## 6. Jobs

**ทั่วไป**: ทุก job ทำงานเป็น chunk สั้น (≤ ~1–2 นาที) แล้ว enqueue chunk ถัดไปพร้อม checkpoint ใน `batch.cursor` — resume/cancel ได้ และไม่ block event loop นาน (BullMQ ต่อ lock อัตโนมัติก็จริง แต่ถ้า parse CPU หนักจน event loop ค้างเกิน `lockDuration` job จะ stall แล้วถูกรันซ้ำ) · ทุก chunk idempotent

### 6.1 SYNC_FOLLOWERS (optional)
1. chunk ละ 1 หน้า: `GET /v2/bot/followers/ids?limit=1000&start=<cursor>` → 403 = OA ไม่รองรับ → ข้าม job ทั้งหมด ใช้ lazy
2. userId ที่ยังไม่มีใน `lineMember` → `GET /v2/bot/profile/{userId}`
   - throttle `LINE_IMPORT_PROFILE_RPS` **default 10** (ใช้ token เดียวกับแชทจริง ห้ามแย่ง quota) + 429 → backoff ตาม `Retry-After` และลด rate ลงครึ่ง
   - **ต้องแก้ `getJson` / `getProfile`** ให้คืน status (ตอนนี้ทุก non-ok โยน `InternalServerErrorException` เหมือนกันหมด แยก 404 ไม่ได้) → 404 = skip (บล็อก/ลบบัญชี), 429/5xx = retry
   - 100k คนที่ 10 rps ≈ 2.8 ชม. — รับได้เพราะทำเบื้องหลังครั้งเดียว
3. `lineMember.upsert` by `lineUserId` (`source = "followers_sync"`) · ไม่สร้าง `lineConversation` ตรงนี้
4. checkpoint `next` ใน `batch.cursor`

### 6.2 PARSE
1. **ดาวน์โหลดแบบ stream**: เพิ่ม method ใหม่ใน R2 adapter `getStream()` → `GetObjectCommand` → `pipeline(Body, fs.createWriteStream)` — **ห้ามใช้ `get()` เดิม** (โหลดทั้งไฟล์เป็น Buffer + `REQUEST_TIMEOUT_MS = 20s` → OOM/timeout); ใช้ client แยกที่ไม่มี request timeout สั้น
2. เขียนลง `LINE_IMPORT_TMP_DIR` (ไม่ใช่ `/tmp` ของระบบ) · เช็คพื้นที่ว่าง (`fs.statfs`) ≥ fileSize × 1.2 ก่อนโหลด ไม่พอ → FAILED `INSUFFICIENT_DISK`
3. **กันไฟล์อันตราย**: entries ≤ `LINE_IMPORT_MAX_ENTRIES`, uncompressed รวม ≤ `LINE_IMPORT_MAX_UNCOMPRESSED_BYTES`, ratio ≤ 100×, ข้าม `..`/absolute/ไม่ใช่ .csv, ไม่เขียนไฟล์ตามชื่อใน zip (อ่าน stream ตรงจาก `yauzl`)
4. chunk ละ ≤500 entries: ถ้ามี `(batchId, entryName)` แล้ว → ข้าม · strip BOM → `csv-parse` stream → map → กรองวันที่ → กฎเวลา + contentHash (ข้อ 4) → insert thread
5. `Unknown.csv` / 0 ข้อความ → `SKIPPED`
6. ครบทุก entry → ลบ zip จาก R2 + tmp (PII) · `finally` ลบ tmp เสมอแม้ fail

### 6.3 MATCH (in-DB)
1. โหลด map `normalize(displayName) → [lineMemberId]` (select แค่ `id, displayName`)
2. candidate 1 คน และ member นั้นไม่ถูก thread อื่นใน batch ชี้ → `MATCHED_PENDING_WRITE (followers_name)` · 0 → `UNMATCHED` · >1 → `AMBIGUOUS`
3. หลาย thread ชี้ member เดียวกัน → ทั้งหมด `AMBIGUOUS`

### 6.4 MATERIALIZE (ทีละ thread, idempotent)
1. นอก tx: อ่าน `thread.messages`, หา `firstLiveAt` + แถว LIVE ช่วงรอยต่อ → คำนวณรายการที่จะลง (กฎ overlap ข้อ 4)
2. tx สั้นต่อ thread (ไม่มี network ใน tx — invariant #2): `lineConversation.upsert` → `createMany({ skipDuplicates: true })` chunk 1,000 → thread `MATERIALIZED`, เก็บ `conversationId`
3. chunk ละ ~100 threads ต่อ job · `dryRun` → ข้าม

### 6.5 LINK_NEW_MEMBER (lazy)
- hook ใน `findOrCreateLineMember` **ในสาขาที่ `existingMember` เป็น null** (ก่อน upsert) — upsert เองไม่บอกว่า create หรือ update
- enqueue หลัง upsert สำเร็จ: `queue.add('link-new-member', {lineMemberId}, {jobId: 'link:'+lineMemberId})` (dedupe race ที่ 2 webhook สร้างพร้อมกัน) · ไม่ทำใน hot path
- job idempotent: หา thread `UNMATCHED` ที่ `normalizedName` ตรง → 1 ตัว → MATERIALIZE (`lazy_first_message`) · หลายตัว → `AMBIGUOUS`
- ข้อความ import อาจโผล่หลังข้อความแรกของลูกค้าไม่กี่วินาที — frontend refresh ด้วย socket/polling เดิม

---

## 7. ผลกระทบต่อโค้ดเดิม / invariants

### 7.1 ส่วนที่อ่าน `lineChatHistory` / `lineMember` (ตรวจทั้ง `src/` แล้ว)

| ที่ | กระทบไหม | ต้องทำ |
|---|---|---|
| `admin/analytics/admin-analytics.repository.ts` `chatActivity()` | **กระทบ** — นับทุกแถวไม่กรอง source → กราฟย้อนหลังจะมีข้อความ import ปน | เพิ่ม `AND h."source" = 'live'` |
| `users/users.service.ts` `listLineUsers` | **กระทบ** — list มี pagination แล้ว (ไม่บวมต่อหน้า) แต่ `total` นับคน `followers_sync` ที่ไม่เคยทัก และ `messageCount` (`_count` USER) จะรวมข้อความ import | ตัดสินใจ: default ซ่อน `source='followers_sync'` ที่ไม่มีห้อง + filter แสดงได้; `messageCount` นับ LIVE อย่างเดียว (เพิ่ม `source: LIVE` ใน `_count.where`) + index `(lineMemberId, sender)` |
| `users/users.service.ts:80` `lineMember.count({memberId: null})` | **กระทบ** — ตัวเลข "LINE ที่ยังไม่ลงทะเบียน" จะพองด้วย followers_sync | กรองเหมือนข้างบน |
| `channels/line/line-webhook.service.ts:77` inbox search `displayName contains insensitive` | ช้าลงเมื่อ lineMember 100k (seq scan) — เป็นปัญหาเดิมที่ใหญ่ขึ้น | เพิ่ม `pg_trgm` GIN index บน `lineMember.displayName` (Phase 6 หรือเมื่อวัดแล้วช้า) |
| `channels/line/line-webhook.service.ts` getConversationMessages | ตั้งใจให้แสดง | เพิ่ม `source` ใน response |
| `admin/ai-chat/admin-ai-usage.service.ts` | ไม่กระทบ — กรอง `sentByAdminId` (import = null) | — |
| `admin/richMenu/rich-menu.service.ts` | ไม่กระทบ — นับ POSTBACK (import = TEXT) | — |
| `line-channel.adapter.ts`, `line-delivery.service.ts`, `line-image-archive.service.ts` | ไม่กระทบ — lookup ด้วย `lineMessageId`/`deliveryId`/`id` | — |
| AI / chatbot / `LoadContextService` | ไม่กระทบ — ไม่อ่านตารางนี้ (บริบทมาจาก Redis `chat:context`) | **ห้ามเปลี่ยน**: ประวัติ import ห้ามเข้า prompt |

### 7.2 กฎ

| เรื่อง | กฎ |
|---|---|
| Redis | ไม่แตะ `chat:context` / `chat:session` / `chat:control` |
| Delivery / outbox | ไม่สร้าง `lineDelivery`, ไม่ส่งอะไรหา LINE |
| Unread / notification | ไม่เพิ่ม `unreadCount`, ไม่สร้าง `AdminNotification`, ไม่ส่ง socket "ข้อความใหม่" |
| Decision log / billing | ไม่เกี่ยว (ไม่มี LLM) |
| tx | ไม่มี network ใน tx |
| การผูก | ไม่ fuzzy, ไม่เดา — ผูกผิด = แอดมินเห็นแชทคนอื่น (PII) |
| PII / retention (F8) | ลบ zip หลัง parse · staging (`thread.messages`) ลบทั้ง batch ที่ `expiresAt` (default 180 วัน; ก่อนลบ unlink/relink ได้) · ข้อความที่ materialize แล้วอยู่ตาม retention ของแชทปกติ |
| คิว | `line-chat-import` แยก ไม่ใช้ `chat-events` |
| LINE quota | profile API ใช้ token เดียวกับแชทจริง → rate ต่ำ + backoff 429 |

---

## 8. Env ใหม่

`LINE_IMPORT_ENABLED` · `LINE_IMPORT_MAX_ZIP_BYTES` · `LINE_IMPORT_MAX_ENTRIES` · `LINE_IMPORT_MAX_UNCOMPRESSED_BYTES` · `LINE_IMPORT_TMP_DIR` · `LINE_IMPORT_PROFILE_RPS` (10) · `LINE_IMPORT_STAGING_RETENTION_DAYS` (180) · `LINE_IMPORT_TIMEZONE` (Asia/Bangkok) · `LINE_IMPORT_COLUMN_ALIASES`

ต้องมี `STORAGE_DRIVER=r2` + CORS บน bucket
Dependencies ใหม่: `yauzl`, `csv-parse` (+ `iconv-lite` ถ้าจำเป็น)

---

## 9. Phases

| Phase | งาน | ออกเมื่อ |
|---|---|---|
| **0** | export ไฟล์จริง → ยืนยัน header/วันที่/**วินาที**/encoding/ชื่อไฟล์/ค่าผู้ส่ง/placeholder/userId/ขนาด · เช็ค OA verified ไหม → แก้ §1, §4 | **ก่อนทุกอย่าง** |
| 1 | migration (§3 + partial index) + parser pure function + unit test fixture จริง + แก้ `chatActivity` / `listLineUsers` (§7.1) | parser ผ่าน fixture, analytics ไม่นับ import |
| 2 | R2 presigned/multipart + CORS + `getStream` + batch endpoints + PARSE chunked + dryRun | dryRun บนไฟล์จริงได้สถิติ + **match rate จริง** |
| 3 | MATCH + MATERIALIZE (กฎเวลา/key/overlap) + `source` ใน messages | ห้องชื่อตรงเห็นประวัติเรียงถูก |
| 4 | SYNC_FOLLOWERS + แก้ `getJson` แยก status (ถ้า OA verified) | สร้าง lineMember ล่วงหน้า ไม่กระทบแชทจริง |
| 5 | LINK_NEW_MEMBER + หน้า "รอผูก" + link/relink/unlink | ลูกค้าเก่าทักมาเห็นประวัติ; ผูกผิดแก้ได้ไม่เสียข้อมูล |
| 6 | cancel/rollback + retention purge + pg_trgm + load test (100k entries, 3–5M messages) | วัดเวลา/ขนาดจริง |

### Test ที่ต้องมี
- parser: fixture จริง, BOM, header หลายภาษา, แถวเสีย, comma/newline ในข้อความ, กรองวันที่, **5 ข้อความในนาทีเดียว → ลำดับตรง CSV**, "ค่ะ" ซ้ำในนาทีเดียว → contentHash ไม่ชน
- zip safety: zip bomb, path traversal, entry ไม่ใช่ csv, disk ไม่พอ
- upload: uploadId ปลอม / key นอก prefix → 400; ไฟล์ไม่มีใน R2 → 400
- match: ชื่อซ้ำ → AMBIGUOUS, 2 threads → member เดียว → AMBIGUOUS, Unknown → SKIPPED, ชื่อไฟล์ถูกตัดแต่ sender_name ครบ → match ได้
- idempotency: import ไฟล์เดิม 2 ครั้ง → แถวไม่เพิ่ม; job ตายกลาง chunk → resume ไม่ซ้ำ
- overlap: ห้องที่มี LIVE แล้ว → ข้อความซ้ำช่วงรอยต่อไม่เบิ้ล; ข้อความแอดมินที่ตอบจากแอป OA (ไม่มี LIVE) ยังลง
- relink/unlink: ข้อมูลไม่หาย, ห้องที่ import สร้างเองถูกลบ/คำนวณ lastMessage ใหม่
- ห้องที่มี LIVE → `lastMessage`/`unreadCount` ไม่เปลี่ยน
- analytics `chatActivity` ไม่นับ IMPORT; `listLineUsers` ไม่นับ followers_sync ตาม default
- getProfile 404 → skip; 429 → backoff
- ไม่มี AI/Redis/delivery ถูกเรียกตลอด flow

---

## 10. ความเสี่ยงที่ต้องแจ้งเจ้าของ OA

- LINE ให้แค่ ~100k ห้องล่าสุด, ช่วงเวลาตามที่ LINE เก็บ, ข้อความล้วน
- จับคู่ด้วยชื่อ → เปลี่ยนชื่อ/ชื่อซ้ำ/บล็อก ไม่ผูกอัตโนมัติ (แอดมินผูกเองได้)
- OA ไม่ verified → ไม่มีการสร้างลูกค้าล่วงหน้า ประวัติจะผูกตอนลูกค้าทักมาเท่านั้น
- หลังเชื่อมระบบ **ต้องตอบผ่านระบบเราเท่านั้น**
- export ได้สัปดาห์ละครั้ง

---

## 11. Changelog v1 → v2 (จากรีวิว)

| # | ประเด็น | ผลตรวจกับโค้ด | แก้ที่ |
|---|---|---|---|
| C1 | มีที่อื่นอ่าน `lineChatHistory` | **จริง** — v1 อ้างว่า grep แล้วมีที่เดียว ผิด (grep แค่ `findMany`); `chatActivity` ไม่กรอง; `listLineUsers` มี pagination จึงไม่บวมต่อหน้า แต่ total/messageCount เพี้ยน; เจอเพิ่ม `lineMember.count` ที่ users.service:80 | §7.1 |
| C2 | unlink ทำข้อมูลหาย | **จริง** — แผนขัดกันเอง | §3.3 เก็บ `messages` ถึง `expiresAt`, §5.7–5.8 relink/unlink |
| C3a | ลำดับในนาทีเดียวกัน | **จริง** — tie-break ด้วย UUID v4 | §4 กฎเวลา |
| C3b | importKey ตอน PARSE ไม่รู้ member | **จริง** | §4 contentHash → importKey |
| C3c | overlap กับ LIVE | **จริง** — แต่ไม่ตัดทิ้งทั้งช่วงตามที่รีวิวเสนอ เพราะข้อความที่ตอบจากแอป OA ไม่มี webhook จะหาย → ใช้ dedupe ช่วงรอยต่อ | §4 กฎรอยต่อ |
| H1 | R2 `get()` Buffer + 20s timeout, default `local`, CORS, uploadKey | **จริงทั้งหมด** | §5.1–5.2, §6.2 |
| H2 | profile rate / 404 / ชื่อไฟล์ | **จริง** (รายละเอียด: โยน `InternalServerErrorException` ไม่ใช่ BadGateway, แยก 404 ไม่ได้) | §6.1, §1 |
| H3 | partial unique, pg_trgm, ห้าม select messages | partial unique + ไม่ select `messages` — รับ; index `(conversationId, createdAt, id)` ไม่จำเป็นเมื่อแก้ C3a; pg_trgm เป็นปัญหาเดิม ย้ายไป Phase 6 | §3.1, §3.3, §7.1 |
| H4 | BullMQ stall / hook race | stall: BullMQ ต่อ lock อัตโนมัติ เสี่ยงจริงเฉพาะตอน event loop ค้าง — แต่ chunk ยังควรทำเพื่อ resume; hook: รับ | §6 ทั่วไป, §6.5 |
| — | match rate 40–65% | ประมาณการของรีวิว ยังไม่วัด → วัดด้วย dryRun Phase 2 | §0, §9 |

---

## 12. สถานะการ implement (branch `importLineChat`, 2026-11-26)

### ไฟล์

| ส่วน | ที่ |
|---|---|
| Migration (additive, partial unique index) | `prisma/migrations/20261126000000_line_chat_import/`, `prisma/models/line/chatImport.prisma`, `prisma/schema.prisma` |
| CSV → staged messages (pure) | `chat-import/csv/line-chat-csv.mapper.ts`, `csv/line-chat-csv.reader.ts` |
| Zip (stream, limits) | `chat-import/zip/line-chat-zip.reader.ts` |
| Match / overlap (pure) | `chat-import/line-chat-import.matcher.ts` |
| เขียนลงตารางแชท (ที่เดียว) | `chat-import/line-chat-import.writer.ts` |
| Stages (chunk + checkpoint) | `chat-import/line-chat-import.runner.ts`, `.processor.ts`, `.jobs.ts` |
| API | `chat-import/line-chat-import.controller.ts`, `.service.ts`, `.dto.ts` |
| R2 presigned / multipart / stream | `chat-import/line-chat-import.storage.ts` |
| Hook ลูกค้าใหม่ | `chat-import/line-chat-import.hook.ts` + `line-member.repository.ts` (`onCreated`) + `line-channel.adapter.ts` |
| LINE API แยก status | `admin/line-api.utils.ts` (`getLineJson`, `LineApiError`), `admin/line-admin.service.ts` (`findProfile`, `getFollowerIds`) |
| ตัวเลขไม่นับ import | `admin/analytics/admin-analytics.repository.ts` (`chatActivity`), `users/users.service.ts` |

(path ของ chat-import อยู่ใต้ `src/modules/channels/line/`)

### ต่างจากแผนเล็กน้อย
- `uploadId` = `batchId` (แถว batch ถูกสร้างตอนขอ URL อัปโหลด, สถานะ `UPLOADED`) — endpoint `POST /` รับ `uploadId`
- ไฟล์ > 100 MB ใช้ multipart: `POST /uploads/:id/parts` (`partNumbers[]` → URL ต่อ part) และ `POST /uploads/:id/complete` (`parts[{partNumber, etag}]`)
- `GET /:batchId` คืน `threads` = จำนวน thread ต่อสถานะ ณ ตอนนี้ (นับสด) ส่วน `linkedThreads/unmatchedThreads/ambiguousThreads` เป็นผลตอน MATCH
- lazy link ใช้เฉพาะ thread ของ batch ที่ `COMPLETED`
- ห้องที่ import สร้างนับรวมใน inbox counts (`lineConversation.count`) — ตั้งใจ (เป็นห้องจริงที่แอดมินเปิดดูได้)
- `GET /api/line/conversations/:id/messages` คืน `source` (และ field import อื่น) อยู่แล้วเพราะ query ไม่ได้ `select`

### ทดสอบแล้ว
- unit: mapper/reader (header หลายภาษา, ลำดับในนาทีเดียว, hash, BOM/UTF-16, quoted newline), zip (bomb, size lie, traversal, ไม่ใช่ zip), matcher/overlap
- integration กับ Postgres จริง (`line-chat-import.it.spec.ts`, ต้องตั้ง `LINE_IMPORT_IT_DATABASE_URL` ชี้ DB ทิ้ง + `node --experimental-vm-modules`): followers sync, parse, match, dedupe รอยต่อ, counter ห้องเดิมไม่เปลี่ยน, import ซ้ำไม่เพิ่มแถว, lazy link, relink/unlink ไม่เสียข้อมูล, ลบ batch, dryRun, zip เสีย
- แอป boot ได้, route ครบ 15

### ยังไม่ทำ
- **Phase 0**: ยังไม่ได้เห็นไฟล์ export จริง — parser เดา header/วันที่/ค่าผู้ส่งจากหลายรูปแบบ + `LINE_IMPORT_COLUMN_ALIASES`; ต้องลองกับไฟล์จริงด้วย `dryRun` ก่อนใช้งาน
- CORS บน R2 bucket (งาน infra), frontend (หน้าอัปโหลด / progress / รอผูก / เส้นคั่นในแชท)
- pg_trgm บน `lineMember.displayName`, load test 100k ห้อง
- ยังไม่ได้วัด rate limit จริงของ profile API (default 10 rps)

### รอบ QA 2026-11-26
- ลบ batch: สถานะ `DELETING` (กัน link/relink/unlink + writer ถือ batch `FOR SHARE`), ลบทีละ thread ด้วย `importThreadId` (มี index) เป็น chunk 200 thread/job, retry ได้ (`delete-batch` อยู่ใน BATCH_JOBS; FAILED แล้วกด DELETE ซ้ำได้)
- หมดอายุ: ไม่ลบ batch แล้ว — ล้าง `messages` ทีละ 1,000 thread + สถานะ `EXPIRED` (ยังลบ/rollback ได้, link/relink/unlink ไม่ได้)
- match: ตัวเลข linked/unmatched/ambiguous นับจากตาราง (ถูกแม้ retry)
- parse: เขียน 50 entry/transaction; entry ที่อ่านไม่ได้ → thread `SKIPPED` + `ENTRY_UNREADABLE` (ไม่ retry ทั้ง batch)
- followers: บันทึกทุก 100 profile
- candidates: SQL normalize แบบเดียวกับ `normalizeCustomerName`, ≤20 คน/ชื่อ; filter batch `COMPLETED` ใน candidates ของห้อง และ lazy link → AMBIGUOUS
- config: `LINE_IMPORT_UTC_OFFSET_MINUTES` ว่าง = 420 (ไม่ใช่ 0)
- CSV: sender auto-reply/system/บอท/ตอบกลับอัตโนมัติ, `สติ๊กเกอร์`, AM/PM, เศษวินาที, offset `Z`/`+07:00`, เก็บล่าสุด 20,000 ข้อความ/ลูกค้า (`THREAD_TRUNCATED`)
- ไม่ทำ: index `lineMember(source)` (เงื่อนไข `<>` + OR ไม่ใช้ index, 100k แถว seq scan ระดับ ms); "match retry จับคู่ member ซ้ำ" ไม่เกิดจริง (ดูคำอธิบายในแชท)
- รอบ QA ที่ 2: DELETE ซ้ำระหว่างลบ → ตอบ `DELETING` ไม่เริ่ม job ใหม่; match ตัดสินจากทุก thread ที่ไม่ใช่ SKIPPED (แก้ retry หลัง crash กลางทางที่ทำให้ชื่อซ้ำถูก auto-link — รอบแรกสรุปผิดว่าไม่เกิด); `skippedOverlap` นับหลัง commit (กัน deadlock จาก FOR SHARE → UPDATE)
- วัดที่ `lineMember` 100k แถว: นับรายชื่อผู้ใช้ 20 ms (seq scan), candidates 85 ms/หน้า → ยังไม่เพิ่ม index / คอลัมน์ normalized; ถ้าลูกค้าถึงหลักล้านค่อยเพิ่ม `lineMember.normalizedDisplayName` + index
