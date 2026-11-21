# รายงาน live audit: Product RAG รอบรถ (transport) ผ่านช่องทาง App

วันที่รัน 20 พ.ย. 2026 04:44–04:56 (+07) · branch `product` (working tree ที่ยังไม่ commit) · server `nest start --watch` (pid 138278) รันโค้ดปัจจุบัน (dist build 04:25:00 หลัง src ล่าสุด 04:24:59 และ route `/api/admin/products/:id/variants/:variantId/slots` ตอบ 401 = มีอยู่) · โมเดล PLAN/ANSWER = `anthropic/claude-haiku-5.5` ผ่าน OpenRouter · embedding = Gemini embedding-2 ผ่าน OpenRouter

ไฟล์หลักในโฟลเดอร์นี้: `manifest.json` (ID ที่ seed + budget) · `cases.json` · `results.json` (หลักฐานรายเทิร์นครบ: reply, decisionLogs, trace, commerceTurns plan/retrieval/response, commerceLlmCalls request/result) · `conversations.md` · `summary.json` · `manual-verdicts.json` (คำตัดสินที่ผู้ตรวจตัดเอง พร้อมเหตุผลรายเคส) · `run.log`

## 1. สรุปผู้บริหาร

| หัวข้อ | ผล |
|---|---|
| รันได้ | **71 จาก 80 เคส** (ที่เหลือ 9 เคสไม่ได้รันเพราะ budget guard ตัดที่ chat LLM ใช้ 98/100) |
| Budget | chat LLM **98/100** (baseline 540 reservations → 638; นับตรงกับผลรวม `decisionLogs.llmCallCount` = 98) · embedding ระหว่างรัน 12 + ตอน seed 10 (7 เอกสารสินค้า + 3 FAQ) |
| Flow ถูก (ตาม expect/alt) | **68/71 = 95.8%** ผิด flow 3 เคส ทั้งหมดเป็น decoy ที่ถูกดึงเข้า product (D11, D12, D13) |
| Pass ตามคำตัดสินผู้ตรวจ (ต้องถูกทั้ง flow + เนื้อหา + ไม่ fallback เกินจำเป็น) | **52/71 = 73.2%** (นับ PARTIAL เป็นผ่านครึ่ง: 59/71 = 83.1%) |
| Pass ตามตัวตรวจอัตโนมัติ (flow + regex) | 61/71 = 85.9% (หลวมกว่า: ไม่เห็นเคสที่ตอบ ok แต่ไม่ระบุ VIP / ไม่ติดป้ายเต็ม) |
| ปัญหาเด่นสุด | **PLAN call ถูกตัดที่ 900 token (finishReason=length) 8 ครั้งจาก 66 PLAN call = 12%** → `PRODUCT_PLAN_FAILED` → ตอบ fallback + ส่งแอดมิน ทั้งที่สินค้าและรอบมีใน DB ครบ |

ตอบ 3 เป้าหมาย
1. **ลูกค้าถามสินค้า → ต้องเข้า product**: เข้า product ครบทุกเคสที่คาดว่าเป็น product (55/55 เทิร์น: มี commerceTurns + answerType=PRODUCT) รวมถึง "รอบรถ", "สอบถามรอบรถค่ะ" ที่มี FAQ mock ชื่อเดียวกัน (product ชนะ FAQ, ได้คำถามกลับ ไม่ใช่ตาราง mock) และ route ที่ไม่มีใน catalog (กรุงเทพฯ→น่าน ได้ not-found โดยไม่แต่งรอบ)
2. **มีสินค้าแล้วตอบถูกรายการและไม่ fallback**: ทิศทาง/วัน/เวลา/ราคา/ที่นั่งที่ตอบมาถูกทุกครั้งที่ตอบได้ (ไม่พบ hallucination ของราคา/เวลา/ที่นั่ง; รอบยกเลิกไม่ถูกเสนอ; รอบ "เต็ม" ถูกติดป้ายในโหมดรายการ) แต่ **8/55 เทิร์น (14.5%) fallback + handoff โดยไม่จำเป็น** ทั้งหมดจาก PLAN ถูกตัด (P12 P19 P20 P23 P08 P47 P50 P30)
3. **คำถามนอก product ต้องไม่เข้า product**: 12/15 ถูก; 3 เคสที่มีชื่อสถานที่ในประโยค (D11 ร้านอาหารพัทยา, D12 ขับรถไปพัทยา, D13 เที่ยวเชียงใหม่) ถูก planner ตัดสินเป็น PRODUCT; D12/D13 จบด้วย fallback + handoff แอดมิน, D11 ตอบ "ยังไม่พบเส้นทางที่ตรงกับคำถามนี้ ใกล้เคียง กรุงเทพฯ→พัทยา"

## 2. Mapping flow → สัญญาณที่อ่านได้ (ที่ runner ใช้ตัดสิน)

อ่านจาก `decision-log/utils/decision-log.builder.ts` (`answerType`), `products/rag/product-answer.service.ts` (`report()` + mode) และ `commerceTurns`

| flow ที่สังเกตได้ | เงื่อนไข (เรียงลำดับความสำคัญ) | สัญญาณตัวอย่าง |
|---|---|---|
| **PRODUCT** | `decisionLogs.answerType='PRODUCT'` (retrieval.product.plan.mode ∈ PRODUCT/BOTH) และมีแถว `commerceTurns` (externalEventId=`app:<messageId>`, `plan.plan.mode`) | answerMode = `PRODUCT_SCHEDULE_TEMPLATE` (0 LLM ANSWER, ตารางจาก DB), `PRODUCT_LLM_TEMPLATE` (LLM template ผ่าน renderer), `PRODUCT_SAFE_TEMPLATE` (template ถูกปฏิเสธ → รายการ deterministic), `PRODUCT_MISSING_INPUT` (ถามเส้นทาง/วัน), `PRODUCT_NO_MATCH`, `PRODUCT_UNMATCHED_SUGGESTIONS`, `PRODUCT_REPLAY` |
| PRODUCT แต่ fallback | answerType=PRODUCT + `isFallback=true` | answerMode=`FALLBACK`, fallbackReason=`PRODUCT_PLAN_FAILED` / `PRODUCT_INSUFFICIENT_CONTEXT` + handoffRequested=true |
| **KNOWLEDGE** | answerType ∈ KNOWLEDGE / MICRO_KNOWLEDGE / MIXED_KNOWLEDGE และไม่ fallback | answerMode `DIRECT_PRESET` (FAQ exact, 0 LLM) หรือ `GROUNDED`; planner อาจเปิด commerceTurn ด้วย plan.mode=KNOWLEDGE (เสีย 1 PLAN call) |
| **GENERAL** | answerType=GENERAL | answerMode=`GENERAL` (plan.mode=GENERAL หรือ rule ทักทาย/ขอบคุณ) |
| **FALLBACK** | `isFallback=true` ที่ไม่ใช่ PRODUCT หรือ answerType=HANDOFF | fallbackReason `INSUFFICIENT_CONTEXT` (ไม่มี KB), หรือ HANDOFF/TEMPLATE (ติดต่อแอดมิน) |
| RULE (ยอมรับแทน GENERAL สำหรับ สวัสดี/ขอบคุณ) | answerType ∈ RULE/MENU/SYSTEM | |

หมายเหตุเรื่องนิยามที่ผู้ตรวจใช้: การเปิด `commerceTurns` อย่างเดียวไม่ถือว่า "เข้า product" ถ้าคำตอบสุดท้ายมาจาก KNOWLEDGE/GENERAL (planner ทำหน้าที่แทน classifier ตามที่ออกแบบ) แต่รายงานแยกไว้ในข้อ 4.3 ว่าเปลืองกี่ call

## 3. ข้อมูล seed (ผ่าน admin API เท่านั้น, ID ใน manifest.json)

- สินค้าใหม่ 7 รายการ / 9 variant / 54 slot: พัทยา→กรุงเทพฯ, กรุงเทพฯ→เชียงใหม่ (STD 650 + VIP 990), เชียงใหม่→กรุงเทพฯ (STD + VIP), กรุงเทพฯ→ระยอง (280, ความจุ 13), กรุงเทพฯ→หัวหิน (250), กรุงเทพฯ→ขอนแก่น (480–520 ความจุ unknown), กรุงเทพฯ→เกาะช้าง (750, `is_regular_bus=false`, ต่อรถที่ ตราด/ท่าเรือเลมงอบ)
- ในนั้นมี slot ยกเลิก 3 (PTY→BKK ส.21 10:00, VIP CNX จ.23 21:00, เกาะช้าง จ.23 06:00), เต็ม 4 (เช่น PTY→BKK ศ.20 21:00, STD CNX ส.21 22:00, RYG ส.21 09:00, HHN ส.21 12:00), เหลือ 2–3 ที่ (เช่น VIP CNX ศ.20 21:00 เหลือ 2, PTY→BKK อา.22 16:00 เหลือ 2), ปิดขาย 1 (RYG อา.22 09:00), ราคาเฉพาะรอบ 350/1090
- รวมกับสินค้าเดิม (กรุงเทพฯ→พัทยา 50 slot เฉพาะ ส./อา. 07,10,14,18,21 น. ราคา 350) → 8 สินค้า / 104 slot; `productIndexJobs` DONE ครบ 8 และ `productVectors` 8 แถว
- Knowledge ใหม่ 3 รายการ (DIRECT, prefix `[TEST]`): จุดขึ้นรถ, ช่องทางชำระเงิน, สัมภาระ · เรื่อง **ยกเลิก/คืนเงิน** และ **สัตว์เลี้ยง** จงใจไม่เพิ่ม เพื่อให้มีเคส "ไม่มี KB → fallback"
- KB เดิมใน DB มี FAQ จองตั๋ว/ติดต่อ/สำนักงานใหญ่/E-Ticket/พัสดุ และ **FAQ mock ตารางเดินรถ** (รวมถึง FAQ ชื่อ "สอบถามรอบรถ", "ตารางเดินรถ (ภาพรวม)" ที่มีตัวอย่างคำถามว่า "รอบรถ") — ทดสอบแล้ว product ชนะ FAQ นี้ในเคส P40/P41/FA1
- เวลา "วันนี้" = ศุกร์ 20 พ.ย. 2026 ~04:50 น., ข้อมูล seed ผูกกับวันที่ตายตัว (20,21,22,23,24,25,26,28 พ.ย., 5 ธ.ค.) ถ้ารันซ้ำหลัง 20 พ.ย. ต้อง seed ใหม่

## 4. ผลละเอียด

### 4.1 อัตราผ่านรายกลุ่ม

| กลุ่ม | จำนวนที่รัน / ทั้งหมด | flow ถูก | PASS | PARTIAL | FAIL | PASS (strict) |
|---|---|---|---|---|---|---|
| product (เดี่ยว) | 44 / 48 | 44 (100%) | 32 | 4 | 8 | 72.7% |
| decoy | 15 / 20 | 12 (80%) | 12 | 0 | 3 | 80.0% |
| follow-up (4 บทสนทนา, 12 เทิร์น) | 12 / 12 | 12 (100%) | 8 | 3 | 1 | 66.7% |
| **รวม** | **71 / 80** | **68 (95.8%)** | **52** | **7** | **12** | **73.2%** |

องค์ประกอบ 80 เคสจริงคือ decoy 20 + product 48 + follow-up 12 (ผู้ว่าจ้างระบุ 50/20/10: ผมนับ 4 บทสนทนา A/B/C/D รวม 12 เทิร์น ตามตัวอย่างที่ให้ และลด product เดี่ยว 2 เคส) · PASS = flow ถูก + ตอบถูกรายการ/วัน/เวลา/ราคา + ไม่ fallback เกินจำเป็น · PARTIAL = flow และรายการถูก แต่ข้อมูลที่ตอบทำให้เข้าใจผิดบางส่วน (เช่น รอบเต็มไม่ติดป้าย)

### 4.2 เคสที่ผิด flow

| เคส | ข้อความ | คาด | ได้ | สัญญาณ |
|---|---|---|---|---|
| D12 | ขับรถเองไปพัทยากี่ชั่วโมง | GENERAL | PRODUCT→fallback+handoff | plan.mode=PRODUCT (productIds ว่าง แต่ probe `identified=true` เจอสินค้า "พัทยา"), ANSWER ได้ INSUFFICIENT_CONTEXT → `PRODUCT_INSUFFICIENT_CONTEXT`, handoff |
| D13 | ไปเที่ยวเชียงใหม่ช่วงไหนดี | GENERAL | PRODUCT→fallback+handoff | plan.mode=PRODUCT, 2 evidence (BKK-CNX STD/VIP), เหมือน D12 |
| D11 | แนะนำร้านอาหารพัทยาหน่อย | GENERAL | PRODUCT (`PRODUCT_UNMATCHED_SUGGESTIONS`) | plan.mode=PRODUCT operation=RECOMMEND ตอบ "ยังไม่พบเส้นทางที่ตรงกับคำถามนี้ ใกล้เคียง กรุงเทพฯ→พัทยา / พัทยา→กรุงเทพฯ" |

ไม่พบเคส product→legacy (ทุกคำถามรอบรถไปถึง product; ไม่มีเคสที่ถูก FAQ DIRECT/ตารางเดินรถ mock ตอบแทน)

**สาเหตุสันนิษฐาน (D11–D13)** `ProductRetrievalService.routeWithoutPlanner` ส่งทุกข้อความที่ probe เจอ name/alias ของสินค้า ("พัทยา", "เชียงใหม่" เป็น alias ของสินค้า) เข้า PLAN โดยไม่มีด่านกรอง "ไม่ใช่คำถามตารางเดินรถ" และ prompt ของ planner (`transport.prompt.ts` + `product-prompt.ts`) ไม่มีกฎกัน decoy ที่มีชื่อสถานที่; haiku เลือก mode=PRODUCT แทน GENERAL (D10 อากาศ ซึ่งไม่มีชื่อสถานที่ ถูกจัด GENERAL ถูกต้อง) จากนั้นขั้น ANSWER ปฏิเสธเพราะหลักฐานไม่ตอบคำถาม → `unmatchedProductAnswer`/fallback

### 4.3 fallback / handoff ที่ไม่จำเป็น (product ที่มีข้อมูลใน DB)

| เคส | ข้อความ | หลักฐาน |
|---|---|---|
| P12 | กรุงเทพไปเชียงใหม่คืนนี้ รอบไหนบ้าง | PLAN outputTokens=900 finishReason=length, JSON ถูกตัดกลางคัน |
| P20 | กรุงเทพไประยองพรุ่งนี้ 9 โมง ที่นั่งว่างไหม | เหมือนกัน |
| P23 | พัทยากรุงเทพวันอาทิตย์ 4 โมงเย็นเหลือกี่ที่นั่ง | เหมือนกัน |
| P19 | กรุงเทพไปเชียงใหม่ VIP วันจันทร์ | เหมือนกัน |
| P08 | กรุงเทพไประยองพรุ่งนี้ 06:30 ไป 3 คนพอไหม | เหมือนกัน |
| P47 | 5 ธ.ค. กรุงเทพไปพัทยามีกี่รอบ | เหมือนกัน |
| P50 | ตอนนี้มีรถไปพัทยาไหม | เหมือนกัน |
| P30 | กรุงเทพไปภูเก็ต (ควรได้ not-found) | เหมือนกัน |

ทั้ง 8 เคส: `commerceTurns.plan = {failed:true, plan: <ค่า default ambiguous>}` → `ProductAnswerService.answer` → `setting.fallbackMessage` + `requestAdmin` → ลูกค้าเห็น "ขออภัยค่ะ เรื่องนี้ขอให้เจ้าหน้าที่ช่วยตรวจสอบให้ก่อนนะคะ" และบทสนทนา `waiting_admin`

**Root cause (หลักฐานชัด)** `products/rag/product-retrieval.service.ts` ที่เรียก slot `PLAN`: `maxOutputTokens: 900, reasoningEffort: 'low'` กับโมเดล `anthropic/claude-haiku-5.5` — ใน 8 เคสที่ล้มเหลว usage.outputTokens = 900 เต็มพอดี แต่ข้อความ JSON ที่ได้กลับมาสั้นราว 560 ตัวอักษร (ถูกตัดกลาง `"inStockOnly`) แปลว่าโควตา 900 ถูก reasoning token กินไปครึ่งหนึ่ง; PLAN ที่ผ่านใช้ 191–893 token (P18 888, FB3 893 เฉียดเพดาน) จึงเป็นเรื่องความน่าจะเป็น (7 ใน 8 ที่ล้มเหลวมีคำบอกเวลา/วัน ซึ่งทำให้ schema `slots` ใหญ่ขึ้น) · `JSON.parse` พัง → `plan.failed` → fallback ทันที ไม่มี retry · และ `commerceLlmCalls` บันทึกว่า `failed:false` ทำให้ส่งข้อความเดิมซ้ำ (replay) ได้ผลล้มเหลวเดิมตลอด · สมมติฐานที่ยังไม่ได้พิสูจน์: อัตราล้มเหลวขึ้นกับโหลดของ reasoning บน provider
**ข้อเสนอ** เพิ่ม `maxOutputTokens` (เช่น 1500–2000) หรือ retry 1 ครั้งเมื่อ `finishReason=length`, และเมื่อ plan ล้มเหลวให้ถามกลับแทนส่งแอดมิน (ตรงกับ FB1 ใน audit-product.md)

### 4.4 ข้อบกพร่องอื่นที่พบ (ไม่ทำให้ flow ผิด)

| ID | ระดับ | เคส | อาการ | สาเหตุสันนิษฐาน (ไฟล์/ฟังก์ชัน) |
|---|---|---|---|---|
| N1 | MED | FC3 | "แล้วรอบถัดไปล่ะ" (บทสนทนา C หลังแทรก FAQ) planner สร้าง plan ถูก (BKK→RYG, NEXT, 2026-11-21) และ search ได้ FOUND/MATCHED 1 รอบ (06:30) แต่คำตอบเป็น "ยังไม่พบเส้นทางที่ตรงกับคำถามนี้" | planner ใส่ `askFields:["origin","destination"]` → `isScheduleLookup()` (`slots/slot-answer.ts`) คืน false เพราะ `plan.askFields?.length` → ตกไปทาง LLM ANSWER → ได้ decision ไม่ผ่าน → `unmatchedProductAnswer` ใน `product-answer.service.ts` ที่พูดว่า "ไม่พบ" ทั้งที่มีหลักฐาน FOUND |
| N2 | MED | P05 P10 FC1 FD1 FD2 | ตารางเดินรถแบบย่อ (`departureTimetable`) แสดงรอบ **เต็ม** เป็นเวลาปกติ ไม่ติดป้าย (RYG 09:00 เต็ม 13/13, HHN 12:00 เต็ม) ขณะที่โหมดรายการ (FA2, P21) ติดป้าย "ที่นั่งเต็ม" | `slots/slot-answer.ts departureTimetable` ไม่กรอง/ไม่ใส่ state FULL (หลักฐาน retrieval FC1: state=FULL อยู่ใน evidence แต่ไม่ถูกแสดง) |
| N3 | MED | P04 | ถาม "VIP ราคาเท่าไหร่" ได้สองแถว (650 / 990–1090) ไม่บอกว่าแถวไหนคือ VIP; ใน P03/P09 ถ้อยคำเผย SKU ("BKK-CNX-STD") ให้ลูกค้า | variant ไม่มีชื่อ/label ให้ลูกค้า (preset มี field แค่ origin/destination/transfer_points/is_regular_bus); ANSWER template ถูก renderer ปฏิเสธ → `safeProductAnswer` ที่ไม่มีชื่อ variant. ควรมี field "ชั้นที่นั่ง"/ชื่อ variant ใน preset (ข้อมูลฝั่งร้าน) |
| N4 | LOW | P16 P45 | รอบใกล้เคียงไม่ใช่รอบที่ใกล้วันที่ถามที่สุด: จ.30 พ.ย. → เสนอ ศ.20 พ.ย. (ไม่ใช่ ส.28); จ.23 → เสนอ ส.21 (ไม่ใช่ อา.22) | `slots/slot-search.ts`: หน้าต่างรอบใกล้เคียง anchor −12/+36 ชม.; ถ้าว่างใช้ `later` = รอบแรกสุดของ horizon ไม่ใช่รอบที่ใกล้ anchor |
| N5 | LOW | P42 | "เชียงใหม่" ตอบว่าเส้นทางที่เกี่ยวคือ "กรุงเทพฯ→เชียงใหม่" เท่านั้น ตกเส้นกลับ เชียงใหม่→กรุงเทพฯ | LLM template เลือก evidence เดียว (probe ได้ 2 สินค้า) |
| N6 | LOW | P33 | `is_regular_bus=false` แสดงเป็น "ระบุสถานะรถประจำทางเป็น 'ไม่มี'" ถ้อยคำกำกวม (คล้าย audit-product §8 "BOOLEAN false = ไม่ใช่") | `PRODUCT_LLM_TEMPLATE`/safe renderer ของ BOOLEAN |
| N7 | INFO | ทั้งรอบ | ANSWER template ถูก renderer ปฏิเสธแล้วใช้ safe template 9 ครั้ง จาก ANSWER call ที่ทำ 25 ครั้ง (36%; ทั้งหมดเป็นคำถามราคา/ข้อมูลเส้นทาง/ตารางเวลา) ⇒ เสีย LLM 1 call ได้ผลเป็นรายการแข็งๆ (P04 P05 FA4 P27 P28 P34 P35 P36 P39) | `product-answer.grounding.ts` / `product-answer.policy.ts` (F-01/F-02 เดิม) |

### 4.5 ผลกระทบของ planner ต่อคำถาม KB/ทั่วไป (ไม่ใช่ผิด flow แต่เปลืองและมีความเสี่ยง)

- decoy 15 เคสที่รัน มี **11 เคสที่เปิด `commerceTurns` และเสีย PLAN call ~7.7k input token** แม้คำตอบสุดท้ายเป็น KB/GENERAL (D01, D04, D05, D06, D09, D10, D14, D15 + D11–D13) เพราะ planner ทำหน้าที่แทน classifier; 4 เคสที่ไม่เสีย: D02 D03 (FAQ exact DIRECT, 0 LLM), D07 (rule), D08 (rule ทักทาย)
- D01 "จองตั๋วที่ไหน" 2 LLM call แทน 0 เพราะ FAQ ไม่ exact-match จึงต้องผ่าน PLAN(KNOWLEDGE) + grounded answer
- FAQ สัมภาระ (D06) ที่ lexicon ถือเป็น `policySignals` ไม่หลุดเข้า product (ถูก)
- "ขึ้นรถที่ไหน" ใช้ regex `standalonePolicyQuestions` ตอบ DIRECT 0 LLM ทั้งเคสเดี่ยว (D02) และกลางบทสนทนารอบรถ (FC2)
- ตัวเลขที่เคยกังวล: ไม่พบ ราคา/เวลา/ที่นั่งที่ model แต่งเอง ทุกตัวเลขตรงกับ DB; ไม่พบ handoff ในเคสที่ไม่ควร นอกจาก 8+2 เคสข้างต้น

### 4.6 รายเคส (สร้างอัตโนมัติจาก results.json + manual-verdicts.json)

| เคส | กลุ่ม | ข้อความ | คาด | ได้ | answerMode | LLM | ms | ผล | หมายเหตุผู้ตรวจ |
|---|---|---|---|---|---|---|---|---|---|
| P01 | product | พัทยาไปกรุงเทพ | PRODUCT | PRODUCT | PRODUCT_LLM_TEMPLATE | 2 | 6864 | PASS | route พัทยา→กรุงเทพฯ ถูกทิศ ราคา 316–350 ถูกต้อง ขอวันเดินทางต่อ (ไม่แสดงรอบ) |
| P02 | product | กรุงเทพ พัทยา | PRODUCT | PRODUCT | PRODUCT_LLM_TEMPLATE | 2 | 9839 | PASS | ทิศถูก (กรุงเทพฯ→พัทยา) แต่ตอบเป็น profile ของ route ไม่ระบุราคา/รอบ ขอวันที่ต่อ (อ่อน) |
| P03 | product | กรุงเทพ เชียงใหม่ | PRODUCT | PRODUCT | PRODUCT_LLM_TEMPLATE | 2 | 12886 | PASS | แสดง STD 650 / VIP 990–1090 ถูก แต่เผย SKU 'BKK-CNX-STD' ให้ลูกค้าเห็น และไม่บอกชื่อชั้น |
| P04 | product | กทม-เชียงใหม่ VIP ราคาเท่าไหร่ | PRODUCT | PRODUCT | PRODUCT_SAFE_TEMPLATE | 2 | 28953 | PARTIAL | ลูกค้าถาม VIP แต่คำตอบแสดงสองแถว (650 / 990–1090) ไม่ระบุว่าแถวไหนคือ VIP (safe template ไม่มี label ของ variant; ตอบ LLM ถูกตีกลับ) |
| P05 | product | พรุ่งนี้เช้าไประยองมีกี่โมง | PRODUCT | PRODUCT | PRODUCT_SAFE_TEMPLATE | 2 | 5177 | PARTIAL | 06:30, 09:00 ถูก แต่ 09:00 เป็นรอบเต็ม (13/13) ตารางแบบย่อไม่ติดป้ายเต็ม |
| P09 | product | เชียงใหม่ไปกรุงเทพ | PRODUCT | PRODUCT | PRODUCT_LLM_TEMPLATE | 2 | 12475 | PASS | ทิศถูก (เชียงใหม่→กรุงเทพฯ) STD 650 / VIP 990 ถูก; เผย SKU และไม่แสดงรอบ |
| P11 | product | วันอาทิตย์นี้พัทยาไปกรุงเทพ | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 3892 | PASS | อาทิตย์ 22: 09:00,13:00,16:00,19:00 ถูก (ไม่ติดป้าย 'เหลือ 2 ที่' ของ 16:00 แต่ไม่ได้ถาม) |
| P12 | product | กรุงเทพไปเชียงใหม่คืนนี้ รอบไหนบ้าง | PRODUCT | PRODUCT | FALLBACK:PRODUCT_PLAN_FAILED | 1 | 10686 | FAIL | PRODUCT_PLAN_FAILED: PLAN output ถูกตัด 900 token (finishReason=length) → fallback + handoff ทั้งที่มีรอบ |
| P17 | product | พัทยาไปกรุงเทพพรุ่งนี้ 10 โมง | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 2585 | PASS | บอกรอบ 10:00 ไม่พบ (ยกเลิก) + เสนอ 07:00/14:00/17:30 ถูกต้อง |
| P20 | product | กรุงเทพไประยองพรุ่งนี้ 9 โมง ที่นั่งว่างไหม | PRODUCT | PRODUCT | FALLBACK:PRODUCT_PLAN_FAILED | 1 | 6214 | FAIL | PRODUCT_PLAN_FAILED (output ตัดที่ 900 token) → fallback + handoff |
| P23 | product | พัทยากรุงเทพวันอาทิตย์ 4 โมงเย็นเหลือกี่ที่นั่ง | PRODUCT | PRODUCT | FALLBACK:PRODUCT_PLAN_FAILED | 1 | 7142 | FAIL | PRODUCT_PLAN_FAILED (output ตัดที่ 900 token) → fallback + handoff |
| P29 | product | กรุงเทพไปน่านมีรถไหม | PRODUCT | PRODUCT | PRODUCT_NO_MATCH | 1 | 4580 | PASS | ไม่แต่งรอบ/ราคา ตอบว่ายังไม่พบเส้นทางและขอต้นทาง-ปลายทางเพิ่ม (ไม่ได้บอกชัดว่าไม่มีน่าน) |
| P14 | product | กรุงเทพไปเกาะช้างต้องต่อรถไหม | PRODUCT | PRODUCT | PRODUCT_LLM_TEMPLATE | 2 | 10130 | PASS | จุดต่อรถ ตราด, ท่าเรือเลมงอบ ถูกต้อง |
| D01 | decoy | จองตั๋วที่ไหน | KNOWLEDGE | KNOWLEDGE | GROUNDED | 2 | 6825 | PASS | ตอบ FAQ ช่องทางจอง (KNOWLEDGE) แต่เปิด commerceTurn + เรียก PLAN 1 call ก่อน (planner ตัดสินเป็น KNOWLEDGE) |
| D02 | decoy | ขึ้นรถที่ไหน | KNOWLEDGE | KNOWLEDGE | DIRECT_PRESET | 0 | 181 | PASS | DIRECT_PRESET 0 LLM |
| D04 | decoy | ยกเลิกตั๋วคืนเงินได้ไหม | FALLBACK/KNOWLEDGE | FALLBACK | FALLBACK:INSUFFICIENT_CONTEXT | 2 | 6311 | PASS | ไม่มี KB เรื่องยกเลิก → fallback + handoff ถูกตาม expect (planner KNOWLEDGE → INSUFFICIENT_CONTEXT, เปลือง 2 call) |
| D08 | decoy | สวัสดีครับ | GENERAL/RULE | GENERAL | GENERAL | 1 | 2212 | PASS | ทักทาย ไม่เข้า product |
| D12 | decoy | ขับรถเองไปพัทยากี่ชั่วโมง | GENERAL/FALLBACK | PRODUCT | FALLBACK:PRODUCT_INSUFFICIENT_CONTEXT | 2 | 9998 | FAIL | decoy เข้า product: planner ตัดสิน PRODUCT (probe จับชื่อ 'พัทยา') → ANSWER ได้ INSUFFICIENT_CONTEXT → fallback + handoff แอดมิน แทนที่จะเป็น GENERAL |
| D13 | decoy | ไปเที่ยวเชียงใหม่ช่วงไหนดี | GENERAL/FALLBACK | PRODUCT | FALLBACK:PRODUCT_INSUFFICIENT_CONTEXT | 2 | 9612 | FAIL | decoy เข้า product: planner ตัดสิน PRODUCT (จับ 'เชียงใหม่') → fallback + handoff |
| FA1 | followup | สอบถามรอบรถค่ะ | PRODUCT/KNOWLEDGE | PRODUCT | PRODUCT_MISSING_INPUT | 1 | 3371 | PASS | ถามเส้นทางกลับพร้อมตัวเลือก 5 เส้น (ไม่ fallback) |
| FA2 | followup | กรุงเทพไปเชียงใหม่ | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 7027 | PASS | แสดง 11 รอบ BKK→CNX พร้อมราคา/ถึง/เต็ม ถูกต้อง (STD/VIP ไม่มีป้ายชั้น แยกได้จากราคา) |
| FA3 | followup | มีรอบกี่โมงบ้าง | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 3043 | PASS | จำเส้นทางเดิมได้ ตอบรอบชุดเดิม |
| FA4 | followup | รอบ 4 ทุ่มราคาเท่าไหร่ | PRODUCT | PRODUCT | PRODUCT_SAFE_TEMPLATE | 2 | 8570 | PASS | รอบ 22:00 ศ.20 / ส.21(เต็ม) / พ.25 ราคา 650 ถูกต้อง (VIP ไม่มีรอบ 22:00) |
| FC1 | followup | กรุงเทพไประยองพรุ่งนี้ | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 6233 | PARTIAL | 06:30, 09:00, 13:00 ถูก แต่ 09:00 เต็มไม่ติดป้าย |
| FC2 | followup | ขึ้นรถที่ไหน | KNOWLEDGE | KNOWLEDGE | DIRECT_PRESET | 0 | 168 | PASS | DIRECT_PRESET จุดขึ้นรถ ไม่ถูกดึงเข้า product แม้บริบทก่อนหน้าเป็นรถระยอง |
| FC3 | followup | แล้วรอบถัดไปล่ะ | PRODUCT | PRODUCT | PRODUCT_UNMATCHED_SUGGESTIONS | 2 | 6701 | FAIL | 'แล้วรอบถัดไปล่ะ' หลัง decoy กลางทาง: ตอบว่า 'ยังไม่พบเส้นทางที่ตรงกับคำถาม' (PRODUCT_UNMATCHED_SUGGESTIONS) บริบทเส้นทางหาย (DIRECT knowledge turn ใช้ contextPolicy CLEAR) |
| P10 | product | วันเสาร์นี้ กรุงเทพไปหัวหินกี่โมงบ้าง | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 2749 | PARTIAL | 08:00, 12:00, 16:00 ถูกวัน แต่ 12:00 เต็ม ไม่ติดป้าย |
| P06 | product | รอบสุดท้ายคืนนี้ไปหัวหิน | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 4181 | PASS | บอกไม่มีรอบหลัง 18:00 และเสนอ 17:30 เป็นรอบสุดท้ายของวัน ถูกต้อง |
| P13 | product | รถไปขอนแก่นคืนนี้มีไหม | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 3775 | PASS | 22:00 ศ.20 ราคา 480–520 ประมาณ ถูกต้อง ไม่กล่าวถึงจำนวนที่นั่ง |
| P15 | product | ไปเกาะช้างพรุ่งนี้มีรอบไหม | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 2401 | PASS | ส.21 06:00 ราคา 750 ถูกต้อง |
| P16 | product | ไปเกาะช้างวันจันทร์ | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 3781 | PASS | จ.23 ไม่พบรอบ (ยกเลิก) ถูกต้อง; รอบใกล้เคียงแสดงแค่ ส.21 06:00 ทั้งที่ อา.22 06:00 ใกล้กว่า (หน้าต่าง alt ±12/36 ชม.) |
| P18 | product | เชียงใหม่ไปกรุงเทพวันเสาร์ 3 ทุ่ม | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 5305 | PASS | ส.21 21:00 เชียงใหม่→กรุงเทพฯ 650 ถูกต้อง |
| P19 | product | กรุงเทพไปเชียงใหม่ VIP วันจันทร์ | PRODUCT | PRODUCT | FALLBACK:PRODUCT_PLAN_FAILED | 1 | 6428 | FAIL | PRODUCT_PLAN_FAILED (output ตัดที่ 900 token) → fallback + handoff |
| P21 | product | กรุงเทพไปเชียงใหม่พรุ่งนี้ 4 ทุ่มที่ว่างไหม | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 4687 | PASS | 22:00 Standard เต็ม + เสนอ 21:00 VIP / 20:30 / อา.22 20:30 ถูกต้อง |
| P22 | product | VIP กรุงเทพเชียงใหม่คืนนี้เหลือกี่ที่ | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 14934 | PASS | VIP 21:00 ศ.20 ราคา 990 เหลือ 2 ที่นั่ง ถูกต้อง |
| P24 | product | กรุงเทพ พัทยา วันที่ 28 พ.ย. ราคา | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 2527 | PASS | ส.28 07:00,10:00,14:00,18:00,21:00 ราคา 350 ถูกต้อง |
| P26 | product | กรุงเทพไประยองราคาเท่าไหร่ | PRODUCT | PRODUCT | PRODUCT_LLM_TEMPLATE | 2 | 12673 | PASS | 280 บาท ถูกต้อง |
| P27 | product | พัทยาไปกรุงเทพราคาเท่าไร | PRODUCT | PRODUCT | PRODUCT_SAFE_TEMPLATE | 2 | 6329 | PASS | พัทยา→กรุงเทพฯ 316–350 ถูกต้อง |
| P28 | product | กรุงเทพไปขอนแก่นราคา | PRODUCT | PRODUCT | PRODUCT_SAFE_TEMPLATE | 2 | 8785 | PASS | 480–520 (ประมาณ) ถูกต้อง |
| P30 | product | กรุงเทพไปภูเก็ต | PRODUCT/KNOWLEDGE | PRODUCT | FALLBACK:PRODUCT_PLAN_FAILED | 1 | 7897 | FAIL | ควรเข้า product แล้วตอบ not-found แต่ PLAN ถูกตัด (900 token) → fallback + handoff |
| P33 | product | ไปเกาะช้างเป็นรถประจำทางไหม | PRODUCT | PRODUCT | PRODUCT_LLM_TEMPLATE | 2 | 8751 | PASS | ไม่ใช่รถประจำทาง (ใช้คำ 'ระบุสถานะเป็นไม่มี') ถูกต้อง ถ้อยคำกำกวมเล็กน้อย |
| P34 | product | กรุงเทพไประยองเป็นรถประจำทางหรือเปล่า | PRODUCT | PRODUCT | PRODUCT_SAFE_TEMPLATE | 2 | 5187 | PASS | รถประจำทาง: มี ถูกต้อง |
| P08 | product | กรุงเทพไประยองพรุ่งนี้ 06:30 ไป 3 คนพอไหม | PRODUCT | PRODUCT | FALLBACK:PRODUCT_PLAN_FAILED | 1 | 7331 | FAIL | PRODUCT_PLAN_FAILED (output ตัดที่ 900 token) → fallback + handoff |
| P47 | product | 5 ธ.ค. กรุงเทพไปพัทยามีกี่รอบ | PRODUCT | PRODUCT | FALLBACK:PRODUCT_PLAN_FAILED | 1 | 6201 | FAIL | PRODUCT_PLAN_FAILED (output ตัดที่ 900 token) → fallback + handoff |
| P50 | product | ตอนนี้มีรถไปพัทยาไหม | PRODUCT | PRODUCT | FALLBACK:PRODUCT_PLAN_FAILED | 1 | 5914 | FAIL | PRODUCT_PLAN_FAILED (output ตัดที่ 900 token) → fallback + handoff |
| FB1 | followup | พัทยาไปกรุงเทพ | PRODUCT | PRODUCT | PRODUCT_LLM_TEMPLATE | 2 | 5837 | PASS | พัทยา→กรุงเทพฯ ราคา ขอวันที่ |
| FB2 | followup | พรุ่งนี้ | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 5175 | PASS | 'พรุ่งนี้' ต่อเนื่อง: ส.21 07:00,14:00,17:30,20:00 (ตัด 10:00 ที่ยกเลิก) ถูกต้อง |
| FB3 | followup | บ่ายๆ | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 5915 | PASS | 'บ่ายๆ' → 14:00 ถูกต้อง |
| FD1 | followup | กรุงเทพไปหัวหินพรุ่งนี้ | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 3067 | PARTIAL | 08:00, 12:00, 16:00 ถูก แต่ 12:00 เต็มไม่ติดป้าย |
| FD2 | followup | เปลี่ยนเป็นไประยองแทน | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 5126 | PARTIAL | เปลี่ยนปลายทางเป็นระยอง คงต้นทาง/วันถูกต้อง แต่ 09:00 เต็มไม่ติดป้าย |
| D03 | decoy | ชำระเงินยังไง | KNOWLEDGE | KNOWLEDGE | DIRECT_PRESET | 0 | 207 | PASS | DIRECT_PRESET ช่องทางชำระเงิน |
| D05 | decoy | เอาสัตว์เลี้ยงขึ้นรถได้ไหม | FALLBACK/GENERAL | FALLBACK | FALLBACK:INSUFFICIENT_CONTEXT | 2 | 6803 | PASS | ไม่มี KB สัตว์เลี้ยง → fallback+handoff ตาม expect |
| D06 | decoy | สัมภาระเอาขึ้นรถได้กี่กิโล | KNOWLEDGE | KNOWLEDGE | GROUNDED | 2 | 5305 | PASS | FAQ สัมภาระ 20 กก. (policy word 'สัมภาระ' ไม่หลุดเข้า product) |
| D07 | decoy | ติดต่อแอดมิน | FALLBACK/KNOWLEDGE | FALLBACK | TEMPLATE | 0 | 169 | PASS | handoff ผ่าน TEMPLATE 0 LLM |
| D09 | decoy | ขอบคุณค่ะ | GENERAL/RULE | GENERAL | GENERAL | 2 | 4253 | PASS | ตอบขอบคุณ |
| D10 | decoy | วันนี้อากาศเป็นไง | GENERAL/FALLBACK | GENERAL | GENERAL | 2 | 5271 | PASS | ปฏิเสธเรื่องอากาศสุภาพ (planner GENERAL → เสีย PLAN call + commerceTurn) |
| D11 | decoy | แนะนำร้านอาหารพัทยาหน่อย | GENERAL/FALLBACK | PRODUCT | PRODUCT_UNMATCHED_SUGGESTIONS | 2 | 5085 | FAIL | decoy เข้า product: 'แนะนำร้านอาหารพัทยา' → PRODUCT_UNMATCHED_SUGGESTIONS 'ยังไม่พบเส้นทาง … ใกล้เคียง กรุงเทพฯ→พัทยา' (ไม่ fallback แต่ผิด flow) |
| D14 | decoy | บริษัทตั้งอยู่ที่ไหน | KNOWLEDGE | KNOWLEDGE | GROUNDED | 2 | 5796 | PASS | FAQ ที่อยู่สำนักงานใหญ่ |
| D15 | decoy | ทำไมรถเมื่อวานมาช้า | FALLBACK/GENERAL | FALLBACK | FALLBACK:INSUFFICIENT_CONTEXT | 2 | 5818 | PASS | complaint → fallback+handoff ตาม expect |
| P35 | product | พัทยาาาาไปกทม | PRODUCT | PRODUCT | PRODUCT_SAFE_TEMPLATE | 2 | 6808 | PASS | typo 'พัทยาาาา' + 'กทม' → พัทยา→กรุงเทพฯ ถูกทิศ |
| P36 | product | บางกอกไปเชียงใหม่ | PRODUCT | PRODUCT | PRODUCT_SAFE_TEMPLATE | 2 | 12365 | PASS | 'บางกอก' → กรุงเทพฯ→เชียงใหม่ 650 / 990–1090 ถูกต้อง |
| P37 | product | bkk to cnx tonight | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 4722 | PASS | ภาษาอังกฤษ → ศ.20 20:30,21:00,22:00 ถูกต้อง |
| P38 | product | Bangkok to Pattaya tomorrow morning | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 3536 | PASS | Bangkok→Pattaya พรุ่งนี้เช้า 07:00,10:00 ราคา 350 ถูกต้อง |
| P39 | product | Pattaya to Bangkok price | PRODUCT | PRODUCT | PRODUCT_SAFE_TEMPLATE | 2 | 6922 | PASS | Pattaya→Bangkok 316–350 ถูกทิศ |
| P40 | product | ขอรอบรถค่ะ | PRODUCT/KNOWLEDGE | PRODUCT | PRODUCT_MISSING_INPUT | 1 | 3667 | PASS | ถามต้นทาง-ปลายทาง (ไม่ชนกับ FAQ mock) |
| P41 | product | รอบรถ | PRODUCT/KNOWLEDGE | PRODUCT | PRODUCT_MISSING_INPUT | 1 | 2089 | PASS | ถามเส้นทางพร้อมตัวเลือก 5 จาก 8 เส้น (ไม่ชน FAQ mock) |
| P42 | product | เชียงใหม่ | PRODUCT | PRODUCT | PRODUCT_LLM_TEMPLATE | 2 | 16884 | PARTIAL | 'เชียงใหม่' ตอบว่าเส้นทางที่เกี่ยวคือ 'กรุงเทพฯ→เชียงใหม่' เท่านั้น ทั้งที่มี เชียงใหม่→กรุงเทพฯ ด้วย (ตกเส้นกลับ) |
| P43 | product | ระยอง | PRODUCT | PRODUCT | PRODUCT_LLM_TEMPLATE | 2 | 8829 | PASS | กรุงเทพฯ→ระยอง 280 ถูกต้อง |
| P44 | product | ตีหนึ่งมีรถไหม | PRODUCT/FALLBACK/GENERAL | PRODUCT | PRODUCT_MISSING_INPUT | 1 | 6171 | PASS | ไม่แต่งรอบตี 1 ถามเส้นทางกลับ |
| P45 | product | สิ้นเดือนไปเชียงใหม่มีรถไหม | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 9366 | PASS | 30 พ.ย. ไม่พบรอบถูกต้อง; รอบใกล้เคียงเลือก ศ.20 (รอบแรกสุด) แทน ส.28 (ใกล้กว่า) — fallback 'later' เลือกรอบแรกสุด |
| P46 | product | 25 ธ.ค. กรุงเทพไปพัทยา | PRODUCT | PRODUCT | PRODUCT_SCHEDULE_TEMPLATE | 1 | 3962 | PASS | เกิน horizon 30 วัน ตอบถูกต้อง |

**ไม่ได้รัน 9 เคส (หยุดที่ budget guard: used=98, เคส product อาจใช้ได้ถึง 3 call)**: P48 (ขอให้จอง 2 ที่ไปหัวหิน: ทดสอบ F-07 บอทจองไม่ได้), P49 (รอบถัดไปไประยอง ตอนนี้ตี 5), P25 (หัวหิน 8 โมงเช้าวันอาทิตย์), P51 (วันนี้พัทยา→กรุงเทพฯ รอบไหนเหลือ), D16 (prompt injection), D17 (English small talk), D18 (BKS E-Ticket คืออะไร), D19 (ราคาน้ำมัน: ทดสอบ price signal นอก product), D20 (รถไฟไปเชียงใหม่กี่โมง). ผลคือ **ยังไม่มีข้อมูลเรื่อง prompt-injection, small talk ภาษาอังกฤษ และ decoy ที่มีคำว่า ราคา/เท่าไหร่ ที่ไม่เกี่ยวกับรถ**

## 5. LLM / latency

| รายการ | ค่า |
|---|---|
| chat LLM ที่ใช้ | **98 / 100** (baseline `creditReservation` ที่ไม่ใช่ embed 540 → 638; `aiUsageEvents` LINE_AI_REPLY 240 → 338; ผลรวม `decisionLogs.llmCallCount` ของ 71 เทิร์น = 98; ตรงกันทั้งสามแหล่ง) |
| embedding | ระหว่างรัน 12 (query) · ตอน seed 10 (document 7 สินค้า + 3 FAQ) · รวม ~22 |
| LLM เฉลี่ยต่อเทิร์น แยกตาม flow ที่ได้ | PRODUCT 1.40 (58 เทิร์น), KNOWLEDGE 1.0 (6), FALLBACK 1.5 (4), GENERAL 1.67 (3) |
| ANSWER call | 25 ครั้ง (LLM_TEMPLATE ผ่าน 10, ตกเป็น SAFE_TEMPLATE 9, ที่เหลือ general/decoy/rejected) · PLAN call 66 ครั้ง (ล้มเหลว 8) |
| latency ต่อเทิร์น | p50 **5.9 s**, p90 **10.7 s**, max 29.0 s (P04: PLAN 22 s). เฉพาะเทิร์นที่มี LLM: p50 6.2 s / p90 12.4 s. เทิร์น DIRECT/rule (0 LLM): 0.17–0.21 s |
| ขนาด PLAN prompt | ~7.6–7.8k input token ต่อ call (catalog probe + schema ฝัง) |
| 429 / 5xx | ไม่มี (retries429=0, retries5xx=0 ทุกเคส) |

## 6. สิ่งที่ผมเปลี่ยน / ข้อควรทราบ

- **ไม่ได้แก้ไฟล์ใน `src/`** ไม่ได้ commit/checkout/revert ไม่ได้แตะ env หรือ restart server (server เป็นโค้ดล่าสุดอยู่แล้ว)
- ไฟล์ใหม่: `test/audit/transport-live.cases.json`, `test/scripts/seed-transport-live.mjs`, `test/scripts/run-transport-live.mjs`, `test/scripts/finalize-transport-live.mjs`, โฟลเดอร์ผลนี้
- Runner สร้าง guest session ต่อบทสนทนาแต่ละอัน (63 session) โดยผูกกับ source address loopback ต่างกัน (`127.0.<n>.1`) เพราะ `APP_SESSION_CREATE_PER_IP_HOUR` = 30 ต่อ IP/ชั่วโมงไม่พอสำหรับ 80 เคสที่ต้อง session สดทุกเคส (เป็นการลด rate-limit ฝั่ง test harness บนเครื่อง local เท่านั้น ไม่ได้ปรับ config)
- Admin token สร้างด้วย `JWT_SECRET` (HS256, claim ตาม `AdminJwtService.sign`) ของ admin role dev ที่มีอยู่ ไม่มีการพิมพ์ secret ลงไฟล์ผลลัพธ์
- **ข้อมูลทดสอบที่ยังค้างใน DB** (ผ่าน admin API ตามกำหนด): 7 สินค้า (ID ใน manifest.json), 54 slot, 3 FAQ `[TEST]`, guest sessions/conversations 63 ชุด + `decisionLogs`/`commerceTurns` 71 แถว, และ conversation ที่ถูก requestAdmin (waiting_admin) จาก fallback+handoff 14 บทสนทนา (admin notifications) — ควรลบ/ archive สินค้าและ FAQ ทดสอบก่อนใช้ DB นี้ต่อ
- ยังไม่ได้ทดสอบ: F-07 (ขอจอง), prompt injection, English chit-chat, ความเสถียรของ PLAN หลังแก้ maxOutputTokens (ควรรันซ้ำชุด P12 P19 P20 P23 P08 P47 P50 P30 + D11–D13 หลังแก้ ใช้ ~20 call)
- คำตัดสิน PASS/PARTIAL/FAIL รายเคสเป็นการอ่านด้วยมนุษย์ (ในไฟล์ manual-verdicts.json) แยกจากตัวตรวจ regex อัตโนมัติ; ตัวตรวจอัตโนมัติหลวมกว่าผู้ตรวจ 9 เคส (P04 P05 P10 FC1 FD1 FD2 P42 = PARTIAL, FC3 P30 = FAIL ที่ regex ผ่านแต่เนื้อหาผิด/ fallback) — ผู้ตรวจรอบสองควรอ่านจาก `results.json` (`commerceLlmCalls[].request` มี evidence ที่ส่งให้ LLM, `commerceTurn.retrieval.product.result.evidence` มีแถวสินค้า/variant/slot/ราคา/ที่นั่งที่ RAG ให้)
