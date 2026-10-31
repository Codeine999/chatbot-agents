# Investigation: credit wallet contention (P2034)

สถานะ: root cause ยืนยันแล้วด้วยการ reproduce บน DB local · **แก้แล้วใน `credit.service.ts` (ยังไม่ commit)** ผลหลังแก้อยู่ที่หัวข้อ 9 · วันที่ 2026-10-31

## 1. อาการ

- **ที่เห็น:** transaction ของ billing (`reserveAiCredit`, `recordAiUsage`, `releaseAiCredit`) ล้มด้วย Prisma `P2034`
  ทุกครั้งที่มีหลาย AI call พร้อมกัน ต้อง retry ใน `runSerializable` และบางครั้ง retry ครบ 10 ครั้งแล้วยังล้ม
- **ที่ควรเป็น:** AI call ที่พร้อมกันควรรอคิวกันบน wallet แล้วสำเร็จทุกตัว ถ้าเครดิตพอ
- โค้ดยอมรับปัญหานี้ไว้แล้วใน comment ของ `src/modules/usage/credit-point/credit.service.ts:20-27`
  ("burst ... conflicts under SERIALIZABLE") และแก้ด้วยการเพิ่ม retry เป็น 10 ครั้ง

## 2. Reproduce

**สภาพแวดล้อม:** DB ทิ้งได้ `credit_repro` ใน container `nest-postgres` (pg16) แยกจาก `app_db`,
apply ด้วย `prisma migrate deploy` ทุก migration · เรียก `CreditService` ตัวจริงจาก `src/`
พร้อม stub `CompanyService`/`ConfigService` · wallet ตั้งต้น 1,000,000 credit (จึงไม่มีเคสเครดิตไม่พอ)
· จอง 5 / คิดจริง 3 ต่อ call · LLM จำลองด้วย sleep สุ่ม

| สถานการณ์ | calls | settle ล้ม (ครบ 10 ครั้ง) | retry ต่อ call | P2034 ทั้งหมด |
|---|---:|---:|---:|---:|
| A: concurrency 1 (กลุ่มควบคุม) | 30 | 0 | 0 | 0 |
| B: concurrency 10 (ค่าบน production), LLM 0-100 ms | 200 | **1 (0.5%)** | 1.54 | 310 |
| C: concurrency 30, LLM 0-100 ms | 300 | **5 (1.7%)** | 3.70 | 1,114 |
| D: burst 10 พร้อมกัน × 20 รอบ | 200 | 0 | 3.05 | 610 |
| E: burst 30 พร้อมกัน × 10 รอบ | 300 | 0 | 4.73 | 1,418 |

ไม่มี reserve ตัวไหนล้มครบ 10 ครั้ง ทุกตัวที่ล้มคือ **settle** (หลังเรียก LLM แล้ว)

**ยอดรวมหลังจบยังถูกต้อง:** ledger 1,024 แถว = จำนวน settle ที่สำเร็จ · spent 3,072 = 1,024 × 3 · balance 996,928
· `reservedCredit` ค้าง 30 = 6 holds × 5 ซึ่งตรงกับ settle ที่ล้ม 6 ตัว
สรุปได้ว่าปัญหาคือ **ล้มแล้วยอดจองค้าง ไม่ใช่ตัวเลขผิด**

### ข้อแตกต่างจาก production (ยังสรุปอัตราการเกิดบน prod ไม่ได้)

- LLM จริงใช้หลายวินาที ทำให้ call กระจายตัวกว่า repro ข้อนี้ทำให้ repro ชนมากกว่าจริง
- DB บน prod อยู่ข้าม network ทำให้ transaction ยาวกว่าและช่วงทับกันกว้างกว่า ข้อนี้ทำให้ repro ชนน้อยกว่าจริง
- 1 ข้อความบน prod มีหลาย call (classifier, embedding, answer) และมี top-up/admin chat แก้ wallet เดียวกัน
- script เรียก `CreditService` ตรง ไม่ผ่าน `AiBillingService` holds ที่ล้มจึงค้างเป็น `HELD` แทนที่จะถูกตั้งเป็น `UNKNOWN`

## 3. Flow ที่เกี่ยวข้อง

```
LINE webhook → BullMQ line-events (concurrency 10, limiter 12/s)
  → ChatbotService → AiChatService.generateText (answer.service.ts:333)
    → UsersAiProviderService.generate (users-ai-provider.service.ts:40, ไม่ pin operationKey)
      → AiBillingService.runMetered (ai-billing.service.ts:179)
          ① reserveAiCredit    credit.service.ts:187   SERIALIZABLE
          ② provider call      (เสียเงินจริง)
          ③ recordAiUsage      credit.service.ts:340   SERIALIZABLE
             ล้ม → markReservationUnknown + PendingAiUsageError (ai-billing.service.ts:313-329)
  ← PendingAiUsageError.retryable = true
  → LineEventsProcessor ย้ายไป line-events-retry (line-events.processor.ts:86-95, attempts 3, backoff 2s)
```

แถวที่ทุก AI call แตะ: `creditWallets` (บริษัทละ 1 แถว) และ `creditBudgets` (LINE ใช้ scope `*` แถวเดียว)
งานอื่นที่เขียน wallet แถวเดียวกัน: top-up approval (`admin-bill.service.ts:177`, SERIALIZABLE ด้วย), admin AI chat, embedding

## 4. สมมติฐานและหลักฐาน

นับจาก Postgres log ของรอบ repro: serialization failure ทั้งหมด 3,452 ครั้ง ตรงกับจำนวน P2034 ที่ script นับได้

| # | สมมติฐาน | หลักฐาน | ผล |
|---|---|---|---|
| H1 | write-write conflict บน wallet row: SERIALIZABLE ไม่ยอมให้ UPDATE แถวที่ถูกแก้หลัง snapshot | `could not serialize access due to concurrent update` **3,083 ครั้ง (89%)** ทั้งหมดอยู่ที่ `UPDATE "creditWallets"` | **ยืนยัน** (สาเหตุหลัก) |
| H2 | SSI read/write dependency: อ่าน wallet/budget แล้วตัวอื่นเขียน → Postgres ตัดสินว่าเป็น pivot | `read/write dependencies among transactions` **369 ครั้ง (11%)** ที่ `INSERT aiUsageEvents` 219, `UPDATE creditWallets` 89, `INSERT creditReservation` 61 · DETAIL: "Canceled on identification as a pivot" | **ยืนยัน** (สาเหตุรอง ต้นเหตุเดียวกันคือการอ่านแถวที่แชร์กันใน SERIALIZABLE) |
| H3 | connection pool หมด / interactive transaction timeout | ไม่พบ error code อื่นนอกจาก P2034 (ไม่มี P2028) ถึงที่ concurrency 30 | ตัดออก (ที่โหลดระดับนี้) |
| H4 | deadlock | `deadlock detected` 0 ครั้ง โค้ดแก้ wallet ก่อน budget เสมอ | ตัดออก |

budget row ไม่มี failure เลย เพราะทุก transaction แก้ wallet ก่อนและตายตรงนั้นไปก่อน ถ้าแก้ wallet แล้ว
budget จะเป็นจุดร้อนถัดไปด้วยกลไกเดียวกัน

## 5. ห่วงโซ่ "ทำไม"

1. ทำไม AI call ล้ม? → `recordAiUsage` โยน P2034 หลังลองครบ 10 ครั้ง (`credit.service.ts:620`)
2. ทำไม P2034? → Postgres ตีกลับเพราะ wallet row ถูก transaction อื่นแก้หลัง snapshot (H1) หรือเป็น pivot ของ rw-dependency (H2)
3. ทำไมตีกลับแทนที่จะรอ? → SERIALIZABLE (`credit.service.ts:614`) รอ row lock ได้ แต่ห้ามเขียนต่อบนแถวที่เปลี่ยนไปแล้ว
4. ทำไมต้อง SERIALIZABLE? → การเช็กยอดและ budget ทำใน JS จากค่าที่อ่านไว้ก่อน
   (`credit.service.ts:209-262` สำหรับ reserve, `:355-397` สำหรับ settle) ถ้าไม่ใช้ SERIALIZABLE การเช็กจะ race กัน
5. ทำไมชนบ่อย? → ทุก AI call เขียน wallet row เดียวกัน 2 ครั้ง (reserve + settle) บนบริษัทเดียว

**Root cause:** การเช็กเงื่อนไขทางการเงินอยู่ในแอป แยกจากคำสั่งเขียน จึงต้องพึ่ง SERIALIZABLE
ซึ่งแก้การชนบนแถวที่ทุกคนใช้ร่วมกันด้วยการตีกลับ การเพิ่ม retry เป็น 10 ครั้งแก้แค่อาการ
อัตรา retry ต่อ call โตตาม concurrency (1.54 → 3.70 → 4.73)

## 6. ความเสี่ยงที่พบระหว่างไล่โค้ด

| # | ความเสี่ยง | ระดับหลักฐาน |
|---|---|---|
| R1 | settle ล้มหลัง provider ตอบแล้ว → ต้นทุน provider ไม่ถูกบันทึก ไม่มี ledger และยอดจองค้างเป็น `UNKNOWN` จนแอดมินปล่อยเอง (`ai-billing.service.ts:313-329`) ยอดที่ใช้ได้จึงลดลงสะสม | โค้ด + repro (holds ค้าง 6 ตัว) |
| R2 | `PendingAiUsageError.retryable = true` → turn ถูกย้ายเข้า retry queue แต่ LINE answer ไม่ pin `operationKey` → `runMetered` สร้าง key สุ่มใหม่ (`ai-billing.service.ts:183`) → **เรียก LLM ซ้ำ** ต้นทุนของ turn นั้นอาจเป็น 2 เท่า และครั้งแรกไม่ถูกเก็บเงิน | อ่านจากโค้ด ยังไม่ได้รัน |
| R3 | embedding ใช้ idempotency key ที่ผูกกับ `turnId` (`embedding.service.ts:91`) ถ้า settle ของ embedding ล้มแล้ว retry ด้วย key เดิม อาจเจอ `UNKNOWN` แล้วโยน `PendingAiUsageError` ซ้ำจน retry หมด | อ่านจากโค้ด ยังไม่ได้รัน |
| — | ช่องโหว่ด้าน security (injection, auth, การรั่วของ error/`costThb`) ในไฟล์ที่ไล่: ไม่พบ เส้นทาง answer จับ error ดิบแล้วตอบ fallback (`answer.service.ts:347-351`) | ขอบเขตจำกัดเฉพาะไฟล์ที่ไล่ ไม่ใช่ audit เต็ม |

## 7. วิธีแก้ที่เสนอ (ลงมือแล้ว ดูหัวข้อ 9 ว่าทำต่างจากนี้ตรงไหน)

ย้ายการเช็กเข้าไปอยู่ใน `WHERE` ของ UPDATE แล้วรันใต้ READ COMMITTED ทำให้ตัวหลังรอ row lock
แล้วประเมินเงื่อนไขกับค่าล่าสุด แทนที่จะถูกตีกลับ

```sql
UPDATE "creditWallets"
SET "reservedCredit" = "reservedCredit" + $amt
WHERE id = $id AND active
  AND "balanceCredit" - "reservedCredit" - $amt > $min;   -- rowCount 0 → InsufficientCreditException
```

- budget ใช้รูปแบบเดียวกัน (`limitCredit IS NULL OR used + reserved + $amt <= limitCredit`) และล็อก wallet ก่อน budget เสมอ
- settle: ย้ายเงื่อนไข "charge เกิน reserve + available" เข้า `WHERE` · ใช้ `RETURNING` ให้ `balanceAfterCredit` ตรงกับยอดที่ commit
- idempotency ของ `operationKey`: เปลี่ยนไปพึ่ง unique constraint (P2002) และ `updateMany where status='RELEASED'`
- ต้องคงกฎใน `.claude/rules/billing.md` ไว้ทั้งหมด (atomic reserve, settle ใน transaction เดียว, DEBIT ไม่เกิน 1 ครั้ง, ledger immutable)
- แยกงาน: R2 (pin `operationKey` ให้ LINE answer เพื่อกันเรียก LLM ซ้ำ) ควรแก้แยกอีกงาน

**เกณฑ์ยอมรับ:** รัน repro ชุดเดิมหลังแก้ ต้องได้ P2034 = 0, settle ล้ม = 0, `stuckHeld` = 0
และยอดรวมสมดุล พร้อม test ตาม `billing.md` (reserve, settle, release, replay, concurrency, provider failure,
wallet/budget ไม่พอ, expiry)

## 8. สิ่งที่ยังไม่ได้ยืนยัน และวิธียืนยัน

- **อัตราการเกิดบน production:** ค้น log `Retrying serialized AI credit transaction` (retry) และ
  `Failed to record ... usage` (settle ล้ม = R1)
- **holds ค้างบน prod:** `SELECT status, count(*), sum("amountCredit") FROM "creditReservation" WHERE status IN ('HELD','UNKNOWN') GROUP BY status;`
- **R2:** test ที่ทำให้ settle ล้มแล้วนับว่า provider ถูกเรียกกี่ครั้งต่อ 1 webhook event
- **R3:** test เดียวกันในเส้นทาง embedding

## 9. การแก้และผลหลังแก้

### สิ่งที่เปลี่ยน (`src/modules/usage/credit-point/credit.service.ts`)

แทนที่จะเขียน raw SQL ที่มีเงื่อนไขใน `WHERE` ตามที่เสนอในหัวข้อ 7 ใช้วิธีที่ให้ผลเท่ากันด้วย Prisma API เดิม:
**increment/decrement ก่อน แล้วเช็กค่าที่ UPDATE คืนมา** ภายใต้ READ COMMITTED แถวที่ UPDATE ถูกล็อกจนกว่าจะ commit
ค่าที่คืนมาจึงเป็นยอดล่าสุดเสมอ ถ้าเช็กไม่ผ่านก็โยน error ให้ทั้ง transaction rollback

| path | ก่อน | หลัง |
|---|---|---|
| `reserveAiCredit` | SERIALIZABLE: อ่าน → เช็ก → increment | READ COMMITTED: สร้าง/re-hold reservation → increment wallet → increment budget → เช็กค่าที่คืนมา · operationKey ซ้ำพร้อมกัน (P2002) → `PendingAiUsageError` · re-hold ใช้ `updateMany where status='RELEASED'` |
| `recordAiUsage` | SERIALIZABLE: อ่าน hold/wallet/budget → เช็ก → เขียน → ปิด hold ท้ายสุด | READ COMMITTED: ปิด hold ก่อน (`updateMany where status='HELD'` กันตัดเงินซ้ำ) → usage event → wallet → budget → เช็กค่าที่คืนมา → ledger |
| `releaseAiCredit` | SERIALIZABLE | READ COMMITTED (guard สถานะเดิมก็กันการปล่อยซ้ำได้อยู่แล้ว) |
| `setBudgetLimit` | SERIALIZABLE | คงไว้ เพราะอ่านแล้วเขียน และไม่ได้อยู่บนเส้นทางร้อน |
| `runSerializable` | retry P2034 | เปลี่ยนชื่อเป็น `runTransaction(isolationLevel, work)` retry P2034 เหมือนเดิม (เหลือแค่ `setBudgetLimit` และ deadlock) |

ลำดับ lock ทุกเส้นทางเป็น reservation → wallet → budget เพื่อกัน deadlock · ข้อความ error ทุกข้อความเหมือนเดิม
· ไม่มี migration ไม่เปลี่ยน schema

### ผลการตรวจบน `credit_repro` (รัน 3 รอบ ผลเหมือนกันทุกรอบ)

| สถานการณ์ | ก่อนแก้: ล้ม / retry ต่อ call | หลังแก้: ล้ม / retry |
|---|---|---|
| B: concurrency 10 | 1 / 1.54 | **0 / 0** |
| C: concurrency 30 | 5 / 3.70 | **0 / 0** |
| D: burst 10 | 0 / 3.05 | **0 / 0** |
| E: burst 30 | 0 / 4.73 | **0 / 0** |

การตรวจความถูกต้องทางบัญชีขณะทำงานพร้อมกัน (ผ่านทั้งหมด):

| # | สถานการณ์ | ผล |
|---|---|---|
| F | wallet พอสำหรับ 9 holds, ยิง 30 พร้อมกัน | สำเร็จ 9 พอดี, ไม่พอ 21, `reservedCredit` = 45 ทั้ง wallet และ budget |
| G | budget limit 50, ยิง 30 × 5 พร้อมกัน | สำเร็จ 10 พอดี |
| H | operationKey เดียวกัน 10 ครั้งพร้อมกัน | 1 hold, อีก 9 ได้ `PendingAiUsageError` |
| I | settle hold เดียวกัน 2 ครั้งพร้อมกัน | DEBIT 1 แถว, `balanceAfterCredit` ตรงกับยอดจริง |
| J | settle ชน release บน hold เดียวกัน × 20 | `reservedCredit` กลับเป็น 0, ledger = จำนวนที่ตัดเงินจริง |
| K | release hold เดียวกัน 2 ครั้งพร้อมกัน | ปล่อยครั้งเดียว |
| L | reserve ซ้ำขณะ HELD / หลัง RELEASED | HELD → Pending · RELEASED → re-hold แถวเดิมด้วยยอดใหม่ |
| M | provider ล้ม (status failed) | RELEASED, ไม่มี DEBIT, มี usage event |
| N | ค่าจริงเกินยอดที่เหลือ | ปฏิเสธและ rollback ทั้งหมด (hold ยัง HELD, ไม่มี usage event) |
| O | แก้ budget limit ระหว่างมีการจอง | committed ไม่เกิน limit เสมอ (limit ถูกปฏิเสธเมื่อต่ำกว่ายอดที่จองไปแล้ว) |

### ปัญหาเดิมที่พบระหว่างตรวจ (ยังไม่แก้ แยกเป็นอีกงาน)

- **`ensureBudget` ชนกันตอนสร้าง budget แถวแรก:** เมื่อ scope ใหม่ถูกใช้พร้อมกันหลาย call ครั้งแรก `upsert` จะทำ
  `INSERT INTO "creditBudgets"` ซ้อนกัน แล้วตัวหลังล้มด้วย P2002 (`credit_budgets_walletId_kind_scopeKey_key`)
  พบ 53 ครั้งในรอบตรวจที่ไม่ได้สร้าง budget ไว้ก่อน เกิดเฉพาะครั้งแรกของแต่ละ scope เช่น admin ใหม่ หรือ install ใหม่
  ไม่เกี่ยวกับการแก้รอบนี้ (`ensureBudget` ไม่ได้ถูกแตะ)
- **Top-up approval** (`admin-bill.service.ts:144`) ยังเป็น SERIALIZABLE และ retry 3 ครั้ง ตอนนี้ hot path commit บน wallet ถี่ขึ้น
  ไม่มีการตีกลับกันเองแล้ว แต่ top-up ที่อ่านแล้วเขียน wallet อาจถูกตีกลับบ่อยขึ้นตอนโหลดสูง ยังไม่ได้วัด

## ภาคผนวก: รัน repro ซ้ำ

script อยู่ที่ scratchpad ของ session ที่ทำ investigation นี้ (ไม่ได้ commit) สร้าง DB ทิ้งได้ด้วย:

```bash
docker exec nest-postgres psql -U <user> -d app_db -c "CREATE DATABASE credit_repro"
DATABASE_URL=<url ที่ชี้ไป credit_repro> bunx prisma migrate deploy
# ลบเมื่อเลิกใช้
docker exec nest-postgres psql -U <user> -d app_db -c "DROP DATABASE credit_repro"
```
