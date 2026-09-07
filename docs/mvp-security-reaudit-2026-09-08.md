# MVP security / end-to-end re-audit — 2026-09-08

**ข้อสรุป: ยังไม่แนะนำเปิด public production จนกว่าจะแก้สิทธิ์การใช้ embedding, การเข้าถึงสลิป และการตั้งค่า owner ครั้งแรก ส่วนการตัดเครดิต/replay ใน flow ปกติและการกู้คำตอบผ่านการทดสอบรอบนี้แล้ว**

ตรวจ working tree ปัจจุบันซึ่งมีการแก้ไขที่ยังไม่ commit รายงานนี้เป็นผล audit ไม่ได้แก้พฤติกรรมของระบบตาม findings ด้านล่าง

## ขอบเขตและผลการรันจริง

| ตรวจ | ผล |
| --- | --- |
| Unit tests ภายใน `src` | 11 suites, 98/98 ผ่าน |
| TypeScript `npx tsc --noEmit --incremental false` | ผ่าน ก่อนสร้าง temporary suite |
| `npm run build` | ผ่าน |
| Migration deploy บน PostgreSQL ใหม่ | 30 migrations ผ่าน |
| Temporary integration/E2E | 24/24 assertions ผ่าน: 18 เคสตรวจ flow/protection และ 6 เคสยืนยันปัญหาที่ยังมีอยู่ |
| Wallet / usage / ledger reconciliation | ตรงกัน ไม่มี HELD/UNKNOWN ค้างใน scenario ที่ทดสอบ |

ใช้ Nest AppModule, Fastify HTTP injection, guards, DTO validation, services, PostgreSQL/pgvector, BullMQ/Redis และ MongoDB จริงใน Docker ชั่วคราว แยกพอร์ตและฐานข้อมูลจากระบบหลัก จำลองเฉพาะ generation/embedding adapter และ LINE HTTP boundary; ปิดกั้น fetch ที่ fixture ไม่รองรับ ไม่มีการเรียก AI แบบเสียเงินจริงหรือส่งข้อความถึงลูกค้าจริง

Static upload test ใช้ fake slip ใน `/tmp` กับ plugin configuration แบบเดียวกับ `src/main.ts` ไม่ได้เปิดอ่านสลิปจริงของลูกค้า ไม่ได้ทดสอบ browser/frontend, reverse proxy/WAF, socket client หรือ provider network จริง ตัวแปลงผลของ generation providers ไม่ได้ถูกเรียกผ่าน E2E นี้ จึงไม่อ้างว่า token normalization จริงของทุก SDK ผ่านซ้ำจาก E2E รอบนี้

## ปัญหาที่ยืนยันได้

### 1. P1 — บัญชีปิด AI และ budget = 0 ยังทำให้บริษัทเสียเครดิตผ่าน health endpoint

- ตำแหน่ง: `src/modules/ai/embeding/embedding-health.controller.ts:17`, `embedding-health.service.ts:222`, `embedding.service.ts:85`
- ทำซ้ำ: ตั้ง ordinary admin เป็น `aiEnabled=false`, budget ADMIN_AI_QUERY = 0; `POST /api/admin/ai-chat/messages` ถูกปฏิเสธ 403 แต่ `GET /api/admin/health/embedding?deep=true&query=audit` คืน 200 และเพิ่ม EMBEDDING usage/debit 0.01 credit จริง
- สาเหตุ: route ใช้ AdminGuard ทั่วไป; probe ส่งเพียง adminMemberId เข้า embedding ไม่มีการตรวจ aiEnabled/สิทธิ์ใช้ paid probe และไม่มี per-admin spending cap สำหรับ EMBEDDING นี้ ทั้งนี้ยังมี global AI rate limit และ shared wallet minimum อยู่
- แก้: แยก shallow GET ที่ไม่เสียเครดิตออกจาก paid POST probe; กำหนด owner/dev หรือ capability เฉพาะ; ใช้ spend authorization และ per-actor budget/rate limit ครอบทุก entry point

### 2. P1 — URL สลิปอ่านได้โดยไม่ login

- ตำแหน่ง: `src/main.ts:45`, `src/modules/admin/bill/admin-bill.service.ts:26`
- ทำซ้ำ: GET `/uploads/billing/fixture-slip.jpg` ไม่มี Authorization ได้ 200 พร้อมเนื้อหาไฟล์
- สาเหตุ: bill slip อยู่ใต้ uploads ซึ่งถูกเสิร์ฟทั้งหมดเป็น public static
- ผลกระทบ: ผู้ที่มี URL อ่านเอกสารการชำระเงินได้; ไม่ได้พิสูจน์การเดา UUID หรือไล่ดู directory ทั้งหมด
- แก้: ย้ายสลิปไป private storage และดาวน์โหลดผ่าน guarded API ที่ตรวจสิทธิ์ หรือ signed URL อายุสั้นหลังตรวจสิทธิ์ ให้ public เฉพาะรูปที่ตั้งใจเผยแพร่

### 3. P1 แบบมีเงื่อนไข — ผู้เข้าถึง API เป็นคนแรกตั้งตัวเองเป็น owner ได้

- ตำแหน่ง: `src/modules/admin/auth/admin-auth.controller.ts:29`, `admin-auth.service.ts:116`
- ทำซ้ำบน DB ใหม่: public `POST /api/admin/auth/owner` สร้าง owner ได้โดยไม่มี setup secret
- Unique bootstrap/transaction ป้องกันสร้าง owner ซ้ำได้ แต่ไม่ได้ยืนยันว่าใครเป็นผู้มีสิทธิ์ bootstrap
- เงื่อนไขเสี่ยง: เปิด instance ที่ยังไม่มี admin ให้อินเทอร์เน็ตเข้าถึง; ไม่ใช่การยึด owner ซ้ำบน DB ที่ตั้งค่าแล้ว ในกรณีตั้งค่าแล้ว endpoint คืน 201 พร้อมข้อความเดิม แต่ไม่มี owner ใหม่
- แก้: bootstrap ผ่าน CLI/private deployment step หรือ secret ใช้ครั้งเดียวก่อนเปิด public และปิด endpoint หลัง setup

### 4. P2 — ลบห้องแล้ว retry clientRequestId เดิมถูกหักเครดิตอีก

- ตำแหน่ง: `src/modules/admin/ai-chat/admin-chat.service.ts:104`, `prisma/schema.prisma` model AdminChatRequest
- ทำซ้ำ: ส่งข้อความโดยไม่ระบุ roomId พร้อม clientRequestId → ได้คำตอบ/ถูกหักครั้งแรก → DELETE room → ส่ง body เดิมอีกครั้ง → ได้ห้องใหม่และ debit ใหม่
- สาเหตุ: cascade ลบ request identity ไปพร้อมห้อง ทำให้ retry สร้าง request.id/billing key ใหม่
- กรณีส่ง roomId ที่ลบแล้วมาด้วยจะถูกปฏิเสธ; ปัญหานี้เป็น stale retry ของคำขอสร้างห้องโดยไม่มี roomId
- แก้: เก็บ idempotency tombstone แยกจาก chat retention; หลังลบให้ key เดิมคืน 410/409 หรือ replay ตามนโยบาย และบังคับ clientRequestId สำหรับ paid HTTP requests

### 5. P2 — login ไม่มีการ throttle ใน application

- ตำแหน่ง: `src/modules/admin/auth/admin-auth.service.ts:36`
- ทำซ้ำ: รหัสผิดกับ username เดิม 12 ครั้งต่อเนื่อง ทุกครั้ง 401 ไม่มี 429/lockout
- Source flow ไม่มีตัวเรียก login rate limiter; การทดสอบ 12 ครั้งเพียงอย่างเดียวไม่ได้พิสูจน์ขีดจำกัดทุกค่า และไม่ได้ตรวจ WAF/proxy ภายนอก
- แก้: จำกัดต่อ account และ IP แยกกัน เพิ่ม backoff, security audit events และ MFA สำหรับ owner/dev

### 6. P2 — AI ส่งข้อความว่าง แต่ HTTP สำเร็จและหักเครดิต

- ตำแหน่ง: `src/modules/usage/billing/ai-billing.service.ts:342`, `src/modules/admin/ai-chat/admin-chat.service.ts:219`
- ทำซ้ำ: fixture provider คืน `text=''`, input 1,000, cached input 200, output 0 → HTTP 200 และ debit 0.11 credit
- Metering ตรวจ output token > 0 เฉพาะเมื่อมีข้อความ จึง settlement สำเร็จและบันทึก assistant ว่าง
- แก้: บันทึก provider finish/block reason และสถานะ empty/blocked ให้ชัด ส่ง fallback ที่ผู้ใช้เข้าใจแทนข้อความว่าง; แยกต้นทุน provider ที่เกิดจริงออกจากนโยบายคิดเครดิต/refund และห้าม retry แบบคิดใหม่เงียบ ๆ

## Flow ที่ยืนยันว่าทำงานได้ในรอบนี้

1. Login ถูกต้องรับ token, ไม่มี token ได้ 401, ordinary admin เข้า owner route ได้ 403 และอ่านห้องของคนอื่นไม่ได้
2. Registration เมื่อ CAN_REGISTER=false ปฏิเสธ valid body ด้วย 403
3. Notification list/unread API ตอบ 200; DB column aiSettings.id เป็น UUID หลัง migration ใหม่
4. HTTP admin AI ผ่าน GEMINI/OPENAI/ANTHROPIC/MAXPLUS ด้วย fixture adapter, คิด input/cache/output ถูกต้อง; retry body/key เดิมคืนคำตอบเดิม ไม่เรียก provider และไม่หักซ้ำ; เปลี่ยน text โดยใช้ key เดิมได้ 409
5. คำขอ admin key เดียวกันพร้อมกันจบด้วยหนึ่ง debit/หนึ่ง provider call และ retry ภายหลังอ่านคำตอบได้
6. สร้าง AiBillingService instance ใหม่แล้วยัง replay ผล SETTLED จาก DB ได้ ไม่ได้ทดสอบ OS process restart จริง
7. Fault injection ด้วย PostgreSQL trigger: settlement สำเร็จแล้วเขียน assistant history ล้มเหลวทำให้ HTTP 500; เอา trigger ออกแล้ว retry ได้คำตอบเดิม ไม่มี debit/provider call เพิ่ม
8. Provider failure สร้าง failed usage ไม่หักเครดิตและ release hold; balance = 20 ถูกปฏิเสธก่อนเรียก provider
9. Embedding document/query ใช้ scope แยกกัน; key เดิมใน scope เดิมไม่หักซ้ำ; เขียนและ search vector จริงบนตารางใหม่ได้
10. Signed LINE webhook → BullMQ worker → member/inbound persistence → semantic DIRECT → LINE reply fixture → ACCEPTED delivery/outgoing history; ไม่มี generation debit และมี query embedding debit 1 ครั้ง
11. LINE semantic RAG ด้วย cosine 0.8 → embedding + generation → reply/history; debit รวมสอง operation และ duplicate webhook ไม่ส่ง/หักเพิ่ม
12. ลบ outgoing history ของ ACCEPTED delivery แล้วเรียก recovery ได้ history กลับมาโดยไม่ส่ง LINE/หักเครดิตใหม่
13. Seed pending topup ลง DB แล้ว confirm ผ่าน HTTP: ordinary admin/owner ถูกปฏิเสธ, dev confirm พร้อมกันได้ 200 + 409 และ TOPUP ledger เดียว; rejected request confirm ไม่ได้ ไม่ครอบคลุม multipart upload/rate quotation end-to-end รอบนี้
14. HTTP อ่าน admin usage/account, AI chat usage, embedding usage, wallet, reservations, bill history, deliveries ได้ 200 การตรวจนี้ยืนยัน backend availability; ไม่ใช่การยืนยันหน้า dashboard render ครบทุก field

ราคาทดสอบต่อ million tokens: input 100, cached input 50, output 200 credits; 1,000 input + 200 cached + 500 output = **0.21 credit** แยกแต่ละ bucket ไม่คิด cached ซ้ำที่ราคา input

| หลักฐาน DB หลังจบ 24 เคส | ค่า |
| --- | --- |
| TOPUP 2 รายการรวม | 1,010 |
| DEBIT 16 รายการรวม | -2.26 |
| Wallet balance | 1,007.74 |
| lifetimeSpentCredit / ผลรวม success usage | 2.26 / 2.26 |
| reservedCredit | 0 |
| Reservation SETTLED / RELEASED | 16 / 1 |
| HELD / UNKNOWN | 0 / 0 |
| LINE delivery ACCEPTED | 2 |

ยอดรวมนี้รวมการทำซ้ำปัญหาที่ตั้งใจให้เกิดใน test ไม่ใช่ค่าใช้จ่ายของ flow ปกติเพียงอย่างเดียว

## ช่องว่างจาก source review และสิ่งที่ควรเพิ่ม

- **Dashboard ยังไม่ครบสำหรับตรวจบิลราย operation:** `AdminUsageService` เป็นยอด wallet/budget; `AdminAiUsageService` รวมเฉพาะ ADMIN_AI_QUERY; embedding มี events/tokens แต่ยังไม่มี API กลางแบบ pagination/filter สำหรับ generation usage + ledger ทุก kind พร้อม input/cached/cache-write/output, chargedCredit, status, actor, conversation และ operation/delivery correlation หลีกเลี่ยงให้ field `chargedCreditTotal` ถูกเข้าใจว่ารวม embedding ที่ admin ใช้แล้ว
- **Security audit trail:** ควรมีบันทึก login success/failure, เปลี่ยน role/budget/provider/pricing, approve/reject topup, release UNKNOWN พร้อม actor/time/reason; billing usage log ไม่แทน audit log ของทุก admin action
- **Socket authorization:** `notification.gateway.ts` ตรวจ JWT ตอน connect แล้ว broadcast ให้ทุก socket; ไม่พบ disconnect/revalidate เมื่อ token หมดอายุหรือสิทธิ์เปลี่ยน ควรเพิ่มและทดสอบด้วย socket client แยก (ข้อสังเกตจาก source ยังไม่ได้ reproduce รอบนี้)
- **Replay identity:** CreditService ค้น paid result ด้วย operationKey และ kind; ควร bind actor/company/request fingerprint ในชั้น billing ด้วย ปัจจุบัน admin chat ป้องกันผ่าน key ที่สร้างฝั่ง server จึงยังไม่ได้พิสูจน์ช่องทาง HTTP สำหรับขโมยผลของคนอื่น
- **Deploy configuration:** `src/main.ts:118` อ่าน PORT แต่บรรทัด 120 listen 8080 คงที่; ควรใช้ port ที่ config กำหนด (source finding)
- **RAG quality:** เพิ่มชุดคำถามอ้างอิงภาษาไทย, conflicting/stale knowledge, follow-up, prompt injection, image/sticker และ human handoff evaluation; แสดงแหล่งคำตอบ/knowledge version, รับ feedback และมีช่องส่งต่อคนเมื่อไม่มั่นใจ Fixture semantic scores รอบนี้ไม่ได้วัดคุณภาพ embedding/LLM จริง
- **Operations:** alerts สำหรับเครดิตต่ำ/UNKNOWN/failed delivery, reconciliation job, queue backlog dashboard, backup/restore drill และเกณฑ์ rollback ก่อนปล่อย ข้อมูล reservation ที่ไม่มี payload จากระบบเก่าต้องมี operator procedure

แนวทาง login throttling/MFA อ้างอิง [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) และ private file storage/authorized read อ้างอิง [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)

## ข้อจำกัดและ cleanup

- รอบนี้ไม่ใช่ pentest ครบทุก endpoint/ทุก interleaving และไม่ได้รัน dependency CVE scan, load test, browser XSS/CSRF test หรือการ upgrade บนสำเนาข้อมูล production เดิม
- 98 unit tests ไม่ได้เท่ากับมี unit test ทุก service: ยังควรมี regression ถาวรสำหรับ auth, registration, chat idempotency, LINE worker/delivery และ routing branches
- Temporary suite ใช้ ts-jest diagnostics=false และ Node VM modules สำหรับ Prisma; application source ตรวจแยกด้วย typecheck/build ชุด E2E ใช้ forceExit จึงไม่ใช่หลักฐานว่า graceful shutdown ไม่มี open handles
- ลบ `test/reaudit.e2e-spec.ts`, `test/reaudit.env.cjs`, `test/reaudit-jest.json`, fake slip/temp files, compose และ audit containers/network/data หลังเก็บผล ไม่ลบ unit specs เดิม, migrations, source changes หรือเอกสารของผู้ใช้
- ลบ npm script `test:e2e:mvp` ที่อ้าง runner ซึ่งไม่มีอยู่แล้ว รายงาน 2026-09-07 ยังคงเป็นประวัติ ไม่ใช่ชุดทดสอบที่รันซ้ำได้หลัง cleanup
- เหลือรายงานนี้เพื่อใช้ติดตามแก้ไข เมื่อแก้ findings แล้วควรมี regression tests ถาวรใน CI แทนการพึ่งชุดตรวจชั่วคราว
