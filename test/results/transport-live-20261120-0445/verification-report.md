# รายงานตรวจสอบอิสระ: transport-live-20261120-0445 (Product RAG รอบรถ)

ผู้ตรวจ: verifier agent (อ่านไฟล์ + SELECT อย่างเดียว ไม่ยิงบอท ไม่เรียก LLM ไม่แก้ src/ ไม่เขียน DB)
ข้อมูลที่ใช้: `results.json` (71 turn), `cases.json`, `manifest.json`, `manual-verdicts.json`, DB `app_db` (productSlots / productVariants / products / answerPattern / microKnowledge)
ไฟล์ผลลัพธ์รายเทิร์น: `verification.json` (71 รายการ)

หมายเหตุสำคัญเรื่องความน่าเชื่อถือของ DB: `productSlots.updatedAt` สูงสุด = 2026-11-19 21:39:03 UTC (ตอน seed ก่อนเริ่มรัน 21:44) จึงยืนยันได้ว่า DB ตอนนี้ = DB ตอนที่บอทตอบ (ไม่มีการแก้ slot หลังรัน)

## 1. สรุปตัวเลข

| รายการ | ผล |
|---|---|
| เทิร์นที่รัน | 71 (ไม่ได้รัน 9: P25 P48 P49 P51 D16-D20) |
| Consistency PASS / PARTIAL / FAIL (ผมตัดสิน) | 46 / 13 / 12 |
| agent 1 (PASS / PARTIAL / FAIL) | 52 / 7 / 12 |
| เห็นต่างจาก agent 1 | 6 เคส (P03 P09 P16 P29 P36 P45: agent1 PASS -> ผม PARTIAL) |
| Flow ตรงกับ expected | 68/71 (เท่า agent 1; ที่ไม่ตรง D11 D12 D13) |
| Evidence ตรง DB (slot id, startsAt, endsAt, status, seatsLeft, FULL, ราคา, sku, ต้นทาง/ปลายทาง) | 75 slot-evidence + variant/KB evidence ทั้งหมด: mismatch = 0 |
| ข้อมูลเพี้ยนเชิงตัวเลข (เวลา/ราคา/ที่นั่ง/สถานะที่ไม่ตรง evidence หรือ DB) | 0 ไม่พบรอบที่ถูกแต่งขึ้น ไม่พบรอบ CANCELLED/CLOSED ถูกเสนอ |
| Distortion เชิงการละเว้น/เข้าใจผิด | 25 เทิร์นมี distortion อย่างน้อย 1 รายการ (ดูข้อ 3) |
| Fallback+handoff ที่ไม่จำเป็น | 10 (PLAN truncated 8 + decoy 2) |

ผลตรวจ evidence อัตโนมัติ: สคริปต์เทียบทุก slot ที่ถูกส่งให้ LLM (`commerceTurns.retrieval.product.result.evidence[].slot`) กับ `productSlots` จริง ผ่านทั้งหมด `seatsLeft = capacity - reserved`, FULL ก็ต่อเมื่อ left = 0, เวลาไทย (Asia/Bangkok = UTC+7) ตรง, เวลาถึง (endsAt) ตรง เช่น BKK-CNX 20:30 -> 06:00, ไม่มี slot สถานะ CANCELLED/CLOSED ในชุด evidence และ KB ที่ตอบ (D01 D02 D03 D06 D14 FC2) เนื้อหาตรง answerPattern ที่ active

## 2. ตารางจุดที่เห็นต่างจาก agent 1

| id | agent1 | ผม | เหตุผล |
|---|---|---|---|
| P03 | PASS | PARTIAL | ตอบว่า "ตัวเลือก BKK-CNX-STD / BKK-CNX-VIP" เผยรหัส SKU ภายในให้ลูกค้า (agent1 เองบันทึกว่าเผย SKU แต่ยังให้ PASS) |
| P09 | PASS | PARTIAL | "รหัส CNX-BKK-STD / CNX-BKK-VIP" เหมือน P03 |
| P16 | PASS | PARTIAL | จันทร์ 23 พ.ย. ถูกยกเลิกจริง แต่รอบใกล้เคียงที่เสนอคือ ส. 21 06:00 ทั้งที่ อา. 22 06:00 (OPEN เหลือ 4 ที่) ใกล้กว่า |
| P29 | PASS | PARTIAL | ลูกค้าบอกต้นทาง/ปลายทางครบ (กรุงเทพ -> น่าน) แต่บอทตอบ "ระบุต้นทางและปลายทางเพิ่มเติมได้ค่ะ" ไม่บอกชัดว่าไม่มีเส้นทางน่าน |
| P36 | PASS | PARTIAL | ราคา 650 / 990-1090 เป็นบรรทัด "- ราคา" ไม่มีป้ายชั้น + dump description ยาว |
| P45 | PASS | PARTIAL | "สิ้นเดือน" = จ. 30 พ.ย. ไม่มีรอบถูก แต่เสนอรอบ ศ. 20 พ.ย. (ย้อนไป 10 วัน) ทั้งที่ ส. 28 พ.ย. 20:30 STD (เหลือ 38) / 21:00 VIP (เหลือ 23) ใกล้กว่า; case expectation ก็บอกให้เสนอ 28 พ.ย. |

เห็นตรงกับ agent 1 ในตัว verdict แต่ **ไม่เห็นด้วยกับสาเหตุ**:
- FC3: agent1 บอกว่า "บริบทเส้นทางหาย (CLEAR)" ผิด บริบทไม่ได้หาย planner ดึง BKK->RYG จาก history ได้ครบ และ search ได้ FOUND/MATCHED (slot 29d9e713 06:30) สาเหตุจริงดูข้อ 5.2
- P12 P20 P23 P19 P30 P08 P47 P50: agent1 บอก "output ตัดที่ 900 token" ถูก แต่สาเหตุเชิงลึกคือ reasoning tokens กินงบ ไม่ใช่ JSON ยาว (ข้อ 5.1)

## 3. Distortion / คำตอบผิดเรื่อง พร้อมหลักฐาน DB

ไม่พบ hallucination เชิงตัวเลข ที่พบคือ (ก) ละเว้นสถานะ FULL (ข) เข้าใจผิด/ขัดกับ evidence (ค) fallback ที่ไม่ควรเกิด

### 3.1 รอบเต็มไม่ถูกติดป้ายในตารางย่อ (P05 P10 FC1 FD1 FD2) severity medium

ตัวอย่างคำตอบ: "• กรุงเทพฯ 06:30, 09:00 ... ราคาต่อคน 280 บาท" ลูกค้าเห็น 09:00 เหมือนมีที่ว่าง
```sql
select v.sku, s.status, s.capacity, s.reserved, s.capacity-s.reserved as left
from "productSlots" s join "productVariants" v on v.id=s."variantId"
where s.id in ('a170b57c-68e9-4426-ac91-d92096cd10ac','4c3f5407-53fc-468a-a4c9-95ea4d00ec14');
-- BKK-RYG-STD | OPEN | 13 | 13 | 0     (Sat 21 09:00, ใช้ใน P05 FC1 FD2)
-- BKK-HHN-STD | OPEN | 13 | 13 | 0     (Sat 21 12:00, ใช้ใน P10 FD1)
```
evidence ที่ส่งให้โค้ดมี `state: "FULL"` ถูกต้อง แต่ `departureTimetable` ทิ้งไป (ข้อ 5.3) ส่วนเคสที่ใช้ layout รายบรรทัด (FA2, FA4, P21) ติดป้าย "ที่นั่งเต็ม" ถูกต้อง

### 3.2 P42 "เชียงใหม่" ระบุว่ามีเส้นทางเดียว (FALSE_COMPLETENESS) severity medium

คำตอบ: "เส้นทางที่เกี่ยวกับเชียงใหม่ที่มีในระบบคือ กรุงเทพฯ → เชียงใหม่"
```sql
select p.name,p.status,p.aliases from products p
where p.name like 'เชียงใหม่%' or 'เชียงใหม่'=any(p.aliases);
-- กรุงเทพฯ → เชียงใหม่ | ACTIVE | {...,กรุงเทพไปเชียงใหม่,เชียงใหม่}   <- alias เปล่า "เชียงใหม่" มีเฉพาะอันนี้
-- เชียงใหม่ → กรุงเทพฯ | ACTIVE | {"เชียงใหม่ กรุงเทพ","เชียงใหม่ กทม","chiang mai bangkok","cnx bkk"}
```
เส้นกลับ ACTIVE และมี slot (CNX-BKK 7 รอบ) แต่ไม่เข้า evidence เพราะ probe ตรง alias เดียว ต้นเหตุผสม data seed (alias เปล่า) + ไม่มีกลไก "ขยายไปหาเส้นกลับ/ชื่อเมืองเดียวกัน"

### 3.3 FC3 คำตอบขัดกับ evidence ของตัวเอง severity high

คำตอบ: "ยังไม่พบเส้นทางที่ตรงกับคำถามนี้ค่ะ เส้นทางที่ใกล้เคียง: กรุงเทพฯ → ระยอง" ทั้งที่ plan = BKK->RYG, `slotOutcome: MATCHED`, evidence = slot 29d9e713 (Sat 21 06:30, เหลือ 11) ดูข้อ 5.2

### 3.4 Decoy ถูกบังคับเข้า product (D11 D12 D13)

- D11 "แนะนำร้านอาหารพัทยาหน่อย": ตอบ "ยังไม่พบเส้นทางที่ตรงกับคำถามนี้ ... กรุงเทพฯ → พัทยา / พัทยา → กรุงเทพฯ" (ไม่ตรงคำถามเลย)
- D12 "ขับรถเองไปพัทยากี่ชั่วโมง", D13 "ไปเที่ยวเชียงใหม่ช่วงไหนดี": fallback + handoff หาแอดมินโดยไม่จำเป็น
- ทั้งสามเคส planner ตอบ `"mode":"GENERAL"` เอง (ดู `commerceLlmCalls` PLAN) แต่โค้ดบังคับเป็น PRODUCT (ข้อ 5.4) และ LLM ANSWER ยังเขียนคำปฏิเสธสุภาพไว้แล้ว (D11, D12, D13) ที่โค้ดทิ้งไป

### 3.5 Fallback ที่ไม่จำเป็น (10 เทิร์น) ทุกเคส DB มีคำตอบ

| id | สิ่งที่ DB มี |
|---|---|
| P12 | BKK-CNX ศ. 20 พ.ย. 20:30 STD (เหลือ 26), 21:00 VIP (เหลือ 2), 22:00 STD (เหลือ 20) |
| P20 | BKK-RYG ส. 21 09:00 FULL (13/13), 06:30 เหลือ 11, 13:00 เหลือ 7 |
| P23 | PTY-BKK อา. 22 16:00 เหลือ 2 (38/40) |
| P19 | BKK-CNX VIP จ. 23 21:00 CANCELLED; อา. 22 21:00 เหลือ 14 |
| P30 | ไม่มี product กรุงเทพฯ->ภูเก็ต แต่ microKnowledge "ตารางเดินรถหลัก กรุงเทพมหานคร - ภูเก็ต" active (legacy KB ตอบได้) |
| P08 | BKK-RYG ส. 21 06:30 เหลือ 11 (พอสำหรับ 3 คน) |
| P47 | BKK-PTY ส. 5 ธ.ค. 5 รอบ 07/10/14/18/21 ราคา 350 |
| P50 | BKK-PTY ไม่มีรอบวันศุกร์ รอบถัดไป ส. 21 07:00 |
| D12, D13 | คำถามทั่วไป ไม่ควร handoff |

```sql
select v.sku, to_char(s."startsAt" at time zone 'UTC' at time zone 'Asia/Bangkok','YYYY-MM-DD HH24:MI'), s.status, s.capacity-s.reserved
from "productSlots" s join "productVariants" v on v.id=s."variantId"
where v.sku='BKK-PTY-STD' and s."startsAt">='2026-12-04' and s."startsAt"<'2026-12-06' order by 2;
-- 2026-12-05 07:00,10:00,14:00,18:00,21:00 | OPEN | 40 (ยืนยัน P47)
```

### 3.6 รอบใกล้เคียงไม่ใช่รอบที่ใกล้ที่สุด (P16, P45) severity low-medium

```sql
-- P45 (ขอ 30 พ.ย.): รอบที่ใกล้กว่าที่ไม่ถูกเสนอ
-- BKK-CNX-STD | 2026-11-28 20:30 | OPEN | 38
-- BKK-CNX-VIP | 2026-11-28 21:00 | OPEN | 23
-- P16 (ขอ จ. 23 เกาะช้าง): BKK-KCH-TRN 2026-11-22 06:00 OPEN เหลือ 4 (ไม่ถูกเสนอ; บอทเสนอ 11-21 06:00)
```

### 3.7 SKU รั่ว (P03 P09) และราคาไม่ติดป้ายชั้น (P04 P36 P37)

- P03/P09: LLM ใช้ token `{{eN.sku}}` ซึ่งโค้ดอนุญาต (ข้อ 5.5)
- P04: ลูกค้าถาม VIP ได้คำตอบ 2 บรรทัด "กรุงเทพฯ → เชียงใหม่ · ราคา 650.00 บาท" / "... 990.00–1090.00" ไม่รู้ว่าอันไหน VIP ตัวเลข VIP ถูกต้อง (DB: BKK-CNX-VIP 990, ส. 28 พ.ย. 1090) แต่ติดป้ายไม่ได้ เพราะ safe template ไม่มี label และ transport ไม่มี option "ชั้น"

## 4. เทิร์นที่ผมไม่พบข้อผิดพลาดแม้เป็นจุดเสี่ยง

P17 (10:00 ถูก CANCELLED, เสนอ 07:00/14:00/17:30 ถูก), P21 (22:00 STD เต็ม + ทางเลือกถูก), P22 (VIP เหลือ 2), P13 (ขอนแก่น capacity ไม่ระบุ -> ไม่อ้างจำนวนที่นั่ง, ราคา 480-520 ตรง variant), P46 (25 ธ.ค. เกิน horizon 30 วัน: DB slot ล่าสุด 20 ธ.ค.), P06, P14/P33/P34 (meta `transfer_points`, `is_regular_bus` ตรง), FA2/FA3 (11 รอบครบ ไม่มีรอบ CANCELLED จ. 23), D01-D06/D14 (ตรง answerPattern)

## 5. ตรวจ root cause ที่ agent 1 อ้าง (อ่านโค้ด)

### 5.1 PLAN `maxOutputTokens: 900` ตัด: ยืนยัน (code bug) แต่สาเหตุจริงคือ reasoning tokens
- `src/modules/products/rag/product-retrieval.service.ts:297-298` `maxOutputTokens: 900, reasoningEffort: 'low'`
- หลักฐานจาก `commerceLlmCalls`: ทั้ง 8 เคสมี `finishReason:"length"`, `outputTokens:900` แต่ข้อความที่มองเห็นยาวแค่ 0-395 ตัวอักษร (P19 = 0 ตัวอักษร คือกินหมดไปกับ reasoning) JSON ปกติยาว ~350-480 ตัวอักษร (~160-200 token) PLAN ทั้งหมด 66 ครั้ง: median outputTokens = 574; 13 ครั้ง >= 800; 8 ครั้งชนเพดาน ที่ผ่านก็ใกล้เพดาน (P18 888, FB3 893, P35 850) แปลว่า reasoning ใช้ 300-700 token ของงบ 900
- ไม่มีการตรวจ finishReason: `grep finishReason src/modules/products` = ไม่พบ; ผลถูกบันทึกเป็นสำเร็จ (`failed=false`) แล้ว JSON.parse พังที่ `product-retrieval.service.ts:384-390` -> `failed=true`
- Resend replay: ใช่ ถ้า turnId เดิม `commerce-turn.service.ts:265-267` คืน `operation.result` ที่บันทึกไว้ (`314-317` บันทึกโดยไม่ดู finishReason) และ stage `plan` ถูก save ทั้งที่ `failed:true` จึงคำตอบเดิมซ้ำ (ไม่มีการเรียก LLM ใหม่) ถ้าลูกค้าพิมพ์ซ้ำเป็นข้อความใหม่ (messageId ใหม่) จะเรียก PLAN ใหม่ได้ตามปกติ (สุ่ม)
- ประเภท: code bug (config/guard) ไม่ใช่ harness
- ข้อสังเกต: เมื่อ plan.failed โค้ดไม่ลอง legacy KB (P30 มี MK ภูเก็ต) `product-answer.service.ts:105-113`

### 5.2 `isScheduleLookup` + `askFields`: ยืนยัน (code bug) และเป็นต้นเหตุของ FC3
- `slots/slot-answer.ts:237` `if (plan.listOptions.length || plan.askFields?.length) return false;`
- planner ใส่ `askFields:["origin","destination"]` (FC3, FA4) หรือ `["destination"]` (P05) ซ้ำกับ filter ซึ่ง `groundAskFields` (`search/product-plan-policy.ts:44-53`) ไม่ตัด เพราะเป็น field ที่ askable -> คำถามตารางเวลาล้วนถูกส่งไป LLM ANSWER แทนที่จะใช้ `scheduleAnswer`
- ผลกระทบ: (ก) เสีย LLM call เปล่า P05 (403 tok) FA4 (1121 tok) (ข) FC3: LLM ตอบ placeholder `{"decision":"ANSWER","answerTemplate":"รอบถัดไปจาก {{eN.name}} ... ","directlyAnswered":false}`; `productAnswerDecision` (`product-answer.policy.ts:566-568`) ถือ directlyAnswered=false เป็น INSUFFICIENT_CONTEXT -> `rejected` (`product-answer.service.ts:194`) -> บล็อก `232-253` ใช้ `unmatchedProductAnswer` ทั้งที่ `identified` เป็น null และ search FOUND จึงได้ "ยังไม่พบเส้นทาง" ผิดความจริง
- ประเภท: code bug (ตัว guard เข้มเกิน + ข้อความ unmatched ใช้กับ status FOUND/MATCHED)

### 5.3 `departureTimetable` ไม่ติดป้าย FULL: ยืนยัน (code bug)
- `slots/slot-answer.ts:111-120` ถ้าถามเวลาอย่างเดียว/วันเดียว/ product เดียว -> `departureTimetable` (`173-215`) แสดงแค่เวลา+ราคา+notice ไม่อ่าน `slot.state`
- ขัดกับเจตนาที่เขียนไว้ที่ `slot-answer.ts:80` ("A full or closed round is always said so") ซึ่งใช้เฉพาะ layout รายบรรทัด
- ประเภท: code bug

### 5.4 Decoy place-name routing (`routeWithoutPlanner`): ยืนยัน แต่ต้นเหตุหลักอยู่ที่ clamp
- `product-retrieval.service.ts:602-640` ชื่อเมืองที่ตรง alias/ชื่อ (probe) -> `'PLAN'` เสมอ (ตั้งใจออกแบบ ตาม CLAUDE.md §6.3)
- เสียหายจริงที่ `product-retrieval.service.ts:379-381` `if (probe.length && plan.mode === 'GENERAL') plan.mode = policyWorded ? 'BOTH' : 'PRODUCT'` ทับคำตัดสิน GENERAL ของ planner (D11 D12 D13 planner ตอบ GENERAL ทั้งหมด) แล้ว ANSWER ได้ INSUFFICIENT_CONTEXT -> fallback+handoff (`product-answer.service.ts:232-253`)
- ปัจจัยร่วมจาก data: product `กรุงเทพฯ → พัทยา` (ไม่ได้ seed โดย harness) มี alias เปล่า "กรุงเทพ","พัทยา" และ `กรุงเทพฯ → เชียงใหม่` มี alias เปล่า "เชียงใหม่" ทำให้ probe ตรงกับชื่อเมืองเดี่ยว ๆ
- ประเภท: code bug (clamp) + test data issue (alias เปล่า) ส่วนที่ agent1 บอก "decoy เข้า product" ถูก แต่เป็น design flaw ไม่ใช่ harness

### 5.5 SKU / label รั่ว: ยืนยัน (code + data model)
- `product-answer.policy.ts:142` `IDENTITY_FIELDS` รวม `sku`; `:473` `const fields = ['name','sku']` -> LLM ใช้ `{{eN.sku}}` ได้ (P03 P09)
- Transport ไม่มี option "ชั้น" (Standard/VIP อยู่ใน SKU suffix + description) `safeProductAnswer` (`product-answer.policy.ts:945-956`) พิมพ์ `name · options · facts` จึงแยกชั้นไม่ได้
- P04 ถูกตีกลับเพราะ prose มีคำ "ตายตัว" (`transport.lexicon.ts:35` certainWords) ทั้งที่ใช้เชิงปฏิเสธ ("ไม่สามารถระบุราคาตายตัวได้") ตรวจที่ `product-answer.policy.ts:698-706` (อนุมานจากโค้ด+ข้อความ template ไม่ได้รันซ้ำ เพราะห้ามเรียก LLM)
- ประเภท: code bug + preset data-model gap (ไม่ใช่ harness)

### 5.6 Alternative "later" ไม่ใช่ใกล้ที่สุด (ข้อใหม่ที่ agent1 ไม่ได้ระบุเป็น root cause)
- `slots/slot-search.ts:378-395` เมื่อไม่มีรอบใน [anchor-12h, anchor+36h] ใช้ `.find` รอบแรกสุดของ horizon -> P45 (ศ. 20), P16 (ส. 21) ต้อง sort ตามระยะห่างจาก anchor

## 6. ความคาดหวังใน cases.json ที่ผิด/ไม่เหมาะ

| case | ปัญหา |
|---|---|
| P30 | expect "ไม่มีเส้นทางกรุงเทพฯ → ภูเก็ตใน product" แต่ KB จริงมี microKnowledge ตารางเดินรถภูเก็ต active ทดสอบควรยอมรับ KNOWLEDGE หรือ deactivate KB mock |
| D01 D04 D05 D06 D10 D14 D15 (+ counter `decoyOpenedTurn`) | expect "ไม่เข้า product" แต่ตามสถาปัตยกรรม (CLAUDE.md §6.3) เส้นทาง "planner แทน classifier" จึงเปิด commerceTurn และเรียก PLAN 1 ครั้งเป็นเรื่องปกติ ไม่ควรนับเป็น fail (flow สุดท้ายถูกทั้งหมด) |
| D11 D12 D13 | expectation เหมาะสม (GENERAL) ผิดที่โค้ด ไม่ใช่ expectation แต่ `noHandoff:false` ทำให้ D12/D13 handoff ไม่ถูกจับเป็นความเสียหาย ควรตั้ง `noHandoff:true` |
| P16 | expect "เสนอ อา. 22 06:00" ถูกต้องกับ DB บอทเสนอรอบอื่น (auto เขียนเป็น PASS เพราะ regex ผ่าน) ควรเพิ่ม mustMatch "22 พ.ย." |
| P05 FC1 FD1 FD2 P10 | expect ระบุ "(เต็ม)" แต่ checker อัตโนมัติไม่ตรวจ จึง autoPass ทั้งที่ reply ไม่บอก ควรเพิ่ม mustMatch เต็ม |
| P45 | expect ระบุเสนอ 28 พ.ย. แต่ autoPass (ไม่ได้ตรวจรอบเสนอ) |
| FC3 | expect "รอบถัดไป หลังรอบที่ให้ไว้ (13:00)" ไม่สอดคล้องกับ flow: turn ก่อนหน้า (FC2) เป็น FAQ ที่ CLEAR context และ "รอบถัดไป" ที่ถูกตีความคือรอบแรกหลัง "ตอนนี้" (06:30) ควรระบุ expectation ตามนั้นหรือให้ยอมรับ 06:30 |
| auto 61 PASS vs จริง | `autoPass` 61 ไม่เห็น FULL-flag, SKU-leak, alt ผิด, FC3 (auto=PASS ทั้งที่ FAIL), P30 (auto PASS แต่ fallback) |

expectation ที่ผมตรวจกับ DB แล้วถูกต้อง: P01 P02 P05 P06 P10 P12 P15 P18 P20 P23 P24 P25 P48 P49 P51 (ตัวเลขที่นั่ง/วัน/ราคาตรง DB)

## 7. รายการแก้ไขตามลำดับความสำคัญ

1. (สูง) PLAN: เพิ่ม `maxOutputTokens` (เช่น 2000) หรือ `reasoningEffort: 'minimal'/ปิด reasoning` และตรวจ `finishReason==='length'` ให้ถือเป็นล้มเหลวที่ retry ได้ (ไม่บันทึกเป็น result สำเร็จ) -- `product-retrieval.service.ts:297-298`, `commerce-turn.service.ts:314-317`
2. (สูง) เมื่อ `plan.failed` อย่าตอบ fallback+handoff ทันที ลอง legacy KB / ถามวันที่-เส้นทางกลับ (`product-answer.service.ts:105-113`)
3. (สูง) ทำให้ `isScheduleLookup` ไม่นับ askFields ที่ซ้ำกับ filter origin/destination (หรือ strip ใน `groundAskFields`) -- `slot-answer.ts:237`, `product-plan-policy.ts:44`
4. (สูง) อย่าใช้ `unmatchedProductAnswer` ("ยังไม่พบเส้นทาง") เมื่อ search FOUND/MATCHED และมี evidence -> ใช้ `scheduleAnswer`/`safeProductAnswer` แทน -- `product-answer.service.ts:232-253`
5. (กลาง) `departureTimetable` ต้องติดป้าย "เต็ม" / "ปิดรับ" ทุกรอบที่ FULL/CLOSED และ (แนะนำ) "ใกล้เต็ม" -- `slot-answer.ts:173-215`
6. (กลาง) ยกเลิก/ผ่อน clamp `GENERAL -> PRODUCT` เมื่อ probe ตรงเพียงชื่อเมืองเดี่ยว ๆ และใช้ข้อความปฏิเสธที่ LLM เขียนแทน fallback+handoff -- `product-retrieval.service.ts:379-381`
7. (กลาง) ป้ายชั้นผู้โดยสาร: เพิ่ม option "ชั้น" (Standard/VIP) ใน transport preset และเอา `sku` ออกจาก field ที่ LLM ใช้ในธุรกิจที่มีป้ายชั้น; ให้ safe template พิมพ์ label -- `product-answer.policy.ts:142,473,945-956`
8. (กลาง) certainWords: ไม่ปฏิเสธเมื่อคำนั้นอยู่หลังคำปฏิเสธ ("ไม่…ตายตัว") -- `product-answer.policy.ts:698-706`
9. (กลาง) เลือก alternative แบบ "ใกล้ที่สุด" แทนรอบแรกสุดของ horizon -- `slot-search.ts:378-395`
10. (ต่ำ) P42: เมื่อ probe เจอชื่อเมืองเดียว ให้ดึง product ที่ต้น/ปลายทางตรงชื่อเมืองนั้นมาทั้งสองทิศ; แก้ seed ลบ alias เปล่า "เชียงใหม่" (และ "พัทยา","กรุงเทพ" ของ BKK-PTY)
11. (ต่ำ) harness: เพิ่ม checker สำหรับ FULL / SKU leak / รอบใกล้เคียง; ปรับ expectation ตามข้อ 6; ตั้ง `noHandoff:true` กับ decoy GENERAL

## 8. สิ่งที่ตรวจไม่ได้
- ไม่ได้รันซ้ำ `renderProductAnswer` เพื่อพิสูจน์ว่า P04 ถูกปฏิเสธเพราะ "ตายตัว" (ต้องใช้ ts runtime; ผมสรุปจากโค้ดและข้อความ template)
- ไม่ได้ทดสอบ retrieval ซ้ำว่าทำไม P42 ไม่ดึงเส้นกลับ (สรุปจาก alias ใน DB + evidence ที่ส่ง)
- ไม่ได้ตรวจเนื้อหา conversations.md นอกเหนือจาก results.json (ข้อมูลเดียวกัน)
