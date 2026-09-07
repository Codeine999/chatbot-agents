# System E2E results — 2026-09-07

**ผลของรอบ 2026-09-07: ผ่าน 42/42 tests — release gate ทั้ง 6 จุดที่พบในรอบนั้นผ่านแล้ว**

> Audit ล่าสุด: [Security re-audit 2026-09-08](mvp-security-reaudit-2026-09-08.md) พบปัญหาเพิ่มเติม จึงยังไม่ควรใช้ผลรอบนี้เป็นการรับรองความพร้อมปล่อยทั้งหมด ชุดทดสอบชั่วคราวและ runner ของรอบนี้ถูกลบแล้ว คำสั่งทดสอบด้านล่างเป็นบันทึกประวัติ

รอบยืนยันใช้ application source ปัจจุบันกับฐานข้อมูลใหม่ทั้งหมด หลังแก้ production logic และ migration แล้ว ไม่มีการ skip, `test.failing` หรือเปลี่ยน assertion ให้ยอมรับพฤติกรรมที่ผิด

## สิ่งที่แก้และหลักฐาน

| ปัญหา | การแก้ | ผลทดสอบ |
| --- | --- | --- |
| Semantic RAG/indexing ใช้ชื่อตารางเก่า | raw SQL ใช้ `answerPattern` และ `answerPatternVector` ตาม migration ปัจจุบัน | create/index, coverage, semantic DIRECT และ grounded RAG ผ่าน |
| Notification API คืน 500 | migration สร้าง `adminNotifications` และ `lineFollowerSnapshots` พร้อม index/default | handoff สร้าง notification และ GET API ผ่าน |
| `aiSettings.id` เป็น BIGINT แต่ Prisma ใช้ UUID | migration แปลง legacy BIGINT เป็น UUID โดยรักษาข้อมูล settings ของ row เดิม | migration จากฐานเปล่าและ Prisma create ผ่าน |
| Registration สมัครได้เมื่อปิด feature | controller ตรวจ `CAN_REGISTER=false` และใช้ Zod DTO | anonymous register คืน 403 และไม่สร้าง member |
| Admin retry ถูกหักซ้ำ | รับ `clientRequestId`, บันทึก `adminChatRequest` แบบ unique และใช้ operation key คงที่ | ส่ง request เดิมสองครั้งได้ message/reply เดิม, debit เพิ่มครั้งเดียว |
| SETTLED operation replay ไม่ได้ | เก็บ provider result ใน `creditReservation.result` ภายใน transaction เดียวกับ usage/debit และอ่าน replay ก่อน quote/provider | replay คืน output เดิมโดยไม่เรียก provider และ usage, ledger, ยอดเงินไม่เพิ่ม |

`adminChatRequests` มี foreign keys ไปยัง admin, room, user message และ assistant message เพื่อไม่ให้ idempotency record กลายเป็น orphan เมื่อข้อมูลต้นทางถูกลบ

## ขอบเขตและสภาพแวดล้อม

- Docker project `chatbot-mvp-e2e` แยกจากระบบอื่น ใช้ PostgreSQL 16 + pgvector, Redis 7 และ MongoDB 7
- ใช้ `prisma migrate deploy` จากฐานเปล่า ลง migrations 30 ตัวสำเร็จ ไม่ใช้ `db push`
- ใช้ `AppModule`, Fastify injection, raw-body LINE signature, JWT guards, BullMQ worker, Prisma transaction, Redis context และ pgvector จริง
- Seed company, owner/admin/dev, wallet 1,000 credits, TOPUP ledger, budget, provider pricing, AI setting, knowledge ภาษาไทย และ vector 1536 มิติ
- AI SDK และ LINE HTTP boundary ใช้ deterministic fixtures; unexpected outbound request ถูกปฏิเสธ จึงไม่มีค่า AI จริงและไม่มีข้อความถูกส่งไป LINE จริง
- fault-injection tests ตั้งใจให้ LINE reply/push บางครั้งคืน error เพื่อทดสอบ fallback/retry ข้อความ error ใน console ของสองเคสนี้เป็นผลที่คาดไว้

Fixture vector ใช้ตรวจ routing และ SQL เท่านั้น ไม่ได้วัดคุณภาพ semantic embedding ภาษาไทยของ provider จริง

## ยอดบัญชีจาก PostgreSQL รอบผ่าน

| รายการ | ค่า |
| --- | ---: |
| Initial credit / TOPUP ledger | 1,000 |
| Debit ledger รวม | -18.175 |
| `balanceCredit` | 981.825 |
| `lifetimeSpentCredit` | 18.175 |
| `reservedCredit` | 0 |
| Usage events | 18 success / 2 failed (รวม 20) |
| Debit ledger entries | 18 |
| Reservations | 18 SETTLED / 4 RELEASED |
| Accepted LINE deliveries | 13: REPLY 10 / PUSH 3 |

ผลรวม debit ledger เท่ากับ `lifetimeSpentCredit`, wallet เท่ากับ TOPUP ลบ debit, budget ตรงกับ usage ของแต่ละ scope และไม่มี reserve ค้าง ระบบทดสอบหักยอดจาก token counters ที่ fixture provider คืนจริง แต่ผลนี้ยังไม่ยืนยัน invoice หรือ token counters ของ live provider

Generation fixture ปกติใช้ input 1,000, cached input 200 และ output รวม reasoning 500 tokens; Anthropic เพิ่ม cache-write 100 tokens ราคา fixture input/output/cached/cache-write เท่ากับ 500/1,500/125/625 credits ต่อหนึ่งล้าน tokens จึงตัด 1.275 ต่อ call หรือ 1.3375 สำหรับ Anthropic ส่วน embedding รายงาน input 100 tokens และตัด 0.05 ต่อ call

## Flow ที่ผ่าน

- Login ด้วย bcrypt, wrong password/input, password hash ไม่รั่ว, JWT/role/account deletion guards
- Admin AI และ LINE AI ครบ GEMINI, OPENAI, ANTHROPIC, MAXPLUS พร้อม actor attribution, token buckets, pricing, usage, ledger และ balance
- aiEnabled=false, budget หมด, minimum balance และไม่มี pricing ปฏิเสธก่อน upstream call
- provider retry/failure, zero-charge failure record, reservation release และ UNKNOWN settlement recovery permission
- signed LINE webhook → BullMQ → exact/semantic/RAG → billing → delivery → history/context
- duplicate webhook, invalid/expired reply token → push, push retry, handoff/resume, sticker และ image
- embedding query/document/index/coverage และ usage API
- concurrent reservations และ concurrent operation key ไม่ทำให้ debit/provider call ซ้ำ
- admin room ownership, history, usage totals, request retry และ settled result replay (ยังไม่ได้ kill/restart worker จริง)

## Validation อื่น

- `npm run build`: ผ่าน
- `npx tsc --noEmit --incremental false`: ผ่าน (ตรวจเพิ่มเติม 2026-09-08)
- isolated HTTP/component audit: 16/16 tests ผ่าน
- `npm test -- --runInBand`: 11 suites, 98/98 tests ผ่าน
- `npm run test:e2e:mvp`: 1 suite, 42/42 tests ผ่าน
- migration ทุกตัว apply จาก empty PostgreSQL สำเร็จ

## วิธีรันซ้ำ

ต้องมี Docker, dependencies และ images `pgvector/pgvector:pg16`, `redis:7-alpine`, `mongo:7` อยู่ในเครื่อง เพราะ runner ใช้ `--pull never`

```bash
npm run test:e2e:mvp
```

Runner สร้าง containers แยก → migrate ฐาน `chatbot_e2e` จากศูนย์ → seed fixtures → run tests → export artifacts → ลบ containers และ volumes เมื่อจบ หากต้องการเก็บชุดทดสอบไว้ตรวจ DB ใช้:

```bash
npm run test:e2e:mvp -- --keep
```

ไฟล์หลัก:

- Suite: `test/mvp-system.e2e-spec.ts`
- Runner/config: `test/run-mvp-e2e.cjs`, `test/jest-mvp-e2e.json`, `test/mvp-e2e.env.cjs`
- Machine-readable result: `test/artifacts/mvp-system-results.json`
- DB reconciliation snapshot: `test/artifacts/mvp-system-db.json`

Artifacts ถูก gitignore เพราะมี generated fixture IDs ข้อมูลในรายงานนี้เป็น snapshot ที่อ่านและ review ได้

## ข้อจำกัดก่อน production public release

Frontend ต้องสร้าง UUID `clientRequestId` ต่อการส่งข้อความหนึ่งครั้ง และส่งค่าเดิมเมื่อ retry `POST /api/admin/ai-chat/messages` หากไม่ส่ง field นี้ backend จะสร้าง operation ใหม่ทุก request เพื่อรักษาความเข้ากันได้กับ client เดิม การพิมพ์คำถามเหมือนเดิมโดยตั้งใจด้วย request ID ใหม่ยังคิดเครดิตตามปกติ

Result replay รองรับ operation ที่ settlement หลังเพิ่มคอลัมน์ `result` แล้วเท่านั้น Reservation เก่าที่เป็น SETTLED แต่ไม่มี output ไม่สามารถกู้คำตอบย้อนหลังจาก token/ledger ได้ ระบบจะยังกันการเรียก provider ซ้ำ ส่วน UNKNOWN ที่ settlement ไม่สำเร็จยังต้องตรวจสอบตาม recovery workflow เดิม

Migration ถูกทดสอบกับฐานข้อมูลแยกแล้ว ยังไม่ได้ apply ไปยังฐานใช้งานหลัก ก่อนเปิดโค้ดรุ่นนี้ใน environment เป้าหมายต้องรัน `npm run db:deploy` และ generate Prisma client ในขั้น build

Release gate ใน scope นี้เป็นสีเขียวแล้ว แต่ยังไม่ได้ทดสอบ browser/frontend, reverse proxy/CORS/static upload, multi-replica ordering, live provider token counters/pricing, LINE acceptance จริง หรือ crash/restart ระหว่างหลาย process ควรทำ staging smoke test ด้วย test recipient และงบจำกัด รวมทั้งปิด owner bootstrap endpoint หรือเพิ่ม setup secret และเพิ่ม rate limit/audit log ให้ login ก่อนเปิด API สู่ public internet
