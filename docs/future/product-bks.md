# Product สำหรับ BKS (รอบรถ) และหลายธุรกิจ: audit + design

วันที่ 5 พฤศจิกายน 2026 · branch `multi/app` (HEAD `509c0ed` + ไฟล์ที่ยังไม่ commit)
สถานะเอกสาร: **เป้าหมาย ยังไม่ได้ implement** (ระดับเดียวกับ `docs/feature/*`)

ขอบเขต: flow product ทั้งหมดเมื่อเปิด `PRODUCT_ENABLED` ตั้งแต่ webhook ถึงคำตอบ ได้แก่ การคัดว่าเข้า flow product, planner, การ match สินค้า, การตัดสินใจตอบ และการ render คำตอบ แล้วออกแบบต่อให้โครง product เดียวกันใช้ได้ทั้งร้าน ecom และบริษัทขนส่ง/ทัวร์ (สินค้าคือรอบรถ วันเวลา ที่นั่ง) โดยแทบไม่ต้องแก้โค้ดเมื่อเพิ่มธุรกิจใหม่

อ่านคู่กับ: [audit-product-22.md](../audit-product-22.md) (audit ฝั่ง catalog/stock เดิม), [test/audit-core-logic-opus/AUDIT.md](../../test/audit-core-logic-opus/AUDIT.md) (audit core chat ล่าสุด) เอกสารนี้ไม่เขียนซ้ำสิ่งที่สองฉบับนั้นอธิบายแล้ว แต่ระบุว่าข้อไหน**ยังเปิดอยู่**

---

## 0. สรุป

### คำตอบสั้นของคำถามหลัก

| คำถาม | คำตอบ |
|---|---|
| Product feature ตอนนี้ใช้งานถูกต้องและเป็น best practice ไหม | **สำหรับ ecom: ส่วนใหญ่ใช่** หลักสำคัญถูกแล้ว ได้แก่ LLM แค่แปลงคำถามเป็น plan, โค้ดกรองเอง, ราคา/สต็อกมาจาก DB ผ่าน token, replay ได้ต่อ event แต่ยังมีข้อที่เปิดค้าง 7 ข้อ (หัวข้อ 3) |
| ใช้กับ BKS (รอบรถ) ได้เลยไหม | **ไม่ได้** ขาด 4 อย่าง: (1) ไม่มีแนวคิด "รอบ" (วันเวลา) (2) ไม่มีวันเวลาปัจจุบันใน prompt ใดๆ จึงตีความ "พรุ่งนี้" ไม่ได้ (3) ข้อความตอบ/ตัวกันมั่วผูกกับคำศัพท์ ecom ("สินค้า", "ชิ้น", "สีและขนาด") (4) คำว่า "ว่าง/เต็ม" ไม่ถูกกันจึงอาจถูกแต่งขึ้นเองได้ |
| ต้องมี stock ไหม | **ไม่ต้องมี stock แบบ SKU** (`inventoryBalances` ต่อ variant) แต่**ต้องมีความจุต่อรอบ** (capacity ต่อ departure) เพราะที่นั่งเป็นของที่หมดอายุตามรอบ (perishable inventory) รอบ 07:30 วันนี้กับรอบ 07:30 พรุ่งนี้คนละก้อน เก็บไว้ในแถวของรอบเลย (`capacity`, `reserved`) ใช้ความหมายเดียวกับ `onHand`/`reserved` ที่มีอยู่ |
| ต้องแก้โค้ดเยอะไหม | **refactor ครั้งเดียว** (ทำให้ preset เป็นตัวกำหนดคำศัพท์และความสามารถ + เพิ่มตาราง `productSlots` + date resolver) หลังจากนั้นธุรกิจใหม่ = **ไฟล์ preset 1 ไฟล์ + ข้อมูล** ไม่ต้องแก้ search/planner/renderer |

### การออกแบบในหนึ่งภาพ

```
Product   = สิ่งที่ลูกค้าเรียกชื่อ      ecom: เสื้อเชิ้ตลินิน     BKS: กรุงเทพฯ (หมอชิต 2) → เชียงใหม่
  Variant = ตัวเลือกที่มีราคา          ecom: สีดำ / L  290฿     BKS: VIP 890฿, ชั้น 1 590฿
    Slot  = ครั้งที่เกิดขึ้นจริง + ความจุ  ecom: (ไม่มี)            BKS: 6 พ.ย. 20:00 · 24 ที่ · จองแล้ว 21   ← ใหม่
```

- ecom ไม่ใช้ Slot และไม่เปลี่ยนพฤติกรรม
- **ความฉลาดอยู่ที่การแบ่งงาน:** LLM ทำแค่เข้าใจคำถาม (ไปไหน วันไหน ช่วงไหน กี่คน ชั้นไหน) ส่วนคำนวณเวลา เช็คที่นั่งพอไหม หารอบใกล้เคียง และสรุปตาราง ทำด้วยโค้ดแบบ deterministic แล้วแสดงผลผ่าน token เหมือนราคาในปัจจุบัน

### ลำดับงานที่แนะนำ

0. **แก้ของค้าง** (ไม่เกี่ยวกับ BKS แต่ต้องแก้ก่อน): C1, P1, H3, M8, เทสต์ C02 และเลิกใช้ timetable ใน MicroKnowledge
1. **Preset เป็นตัวกำหนดคำศัพท์และความสามารถ** โดย ECOMMERCE ต้องได้ผลเหมือนเดิมทุกตัวอักษร
2. **TRANSPORT preset + `productSlots` + date resolver + ค้นรอบ** ตอบตารางเวลา ค่าโดยสาร และรอบถัดไปได้ (ยังไม่ต้องมีข้อมูลที่นั่งก็ใช้ได้)
3. **ข้อมูลที่นั่งจริง** (กรอกโดยแอดมินหรือ sync จากระบบจองของ BKS) พร้อมตรวจความสดของข้อมูล

---

## 1. วิธีตรวจและสิ่งที่รันจริง

อ่านโค้ด (ทั้งไฟล์): `commerce/*`, `products/search/*`, `products/business/*`, `products/attributes/{presets,prompts,types,utils,dto}`, `products/{product,inventory}.service.ts`, `chatbot/chatbot.service.ts`, `intent/intent-router.service.ts`, `intent/utils/route-stages.ts`, `knowledge/knowledge-retrieval.service.ts`, `knowledge/product/*`, `shared/prompt/*`, `context/load-context.service.ts` (เฉพาะส่วนเก็บ context), schema `prisma/models/products/product.prisma`, `customers/commerce-turn.prisma`, `schema.prisma` และ seed ข้อมูล BKS ที่ยังไม่ commit (`prisma/bks-*.json`, `prisma/mock-timetable-*.json`)

รันแล้ว (mock ทั้งหมด ไม่เรียก AI/LINE):

| คำสั่ง | ผล |
|---|---|
| `bunx jest src/modules/chatbot/knowledge/product` | **10/11 ผ่าน** ไม่ผ่าน 1 ข้อคือ `C02 rejects a colour the customer did not choose` (fixture ยังใช้ businessType ที่ถูกลบไปแล้ว, ดู P2) |
| `bunx jest --config test/audit-core-logic-opus/jest.config.json …/product-flow.spec.ts` | **14/14 ผ่าน** (รวมเทสต์ที่จำลอง BUG-P1/P2 ให้เกิดซ้ำ) |

ไม่ได้รัน: `tsc`, lint, build, live eval, load test และ `EXPLAIN` ของ SQL ตัวเลขด้านประสิทธิภาพในเอกสารนี้มาจากการอ่านโค้ด

---

## 2. Flow ปัจจุบันแบบ end-to-end (เมื่อเปิด product)

### 2.1 Flag ที่ต้องเปิดจริง

[commerce-feature.service.ts:34-37](../../src/modules/commerce/commerce-feature.service.ts#L34) ต้องเปิด **3 flag** ไม่ใช่ flag เดียว:

| `PRODUCT_ENABLED` | `PRODUCT_RAG_ENABLED` | `PRODUCT_SEMANTIC_ENABLED` | ผล |
|---|---|---|---|
| false | – | – | ไม่มี product ในแชต, admin API ตอบ 403 |
| true | false | – | admin จัดการ catalog ได้ แต่แชต**ไม่ตอบเรื่องสินค้า** |
| true | true | false | แชตตอบสินค้าด้วย lexical อย่างเดียว |
| true | true | true | lexical + vector fallback |

> Doc drift: [product-mvp.md](../feature/product-mvp.md) บอกว่ากำหนดให้ `PRODUCT_ENABLED` เป็นชื่อหลักและยุบ flag อื่น แต่โค้ดยังใช้สาม flag

### 2.2 ทุกจุดตัดสินใจของข้อความหนึ่งข้อความ

```
LINE webhook → queue → ChatbotService.answerText
 ├─ mute / ข้อความว่าง / ยาวเกิน                       → ตอบ SYSTEM (ไม่เข้า product)
 └─ IntentRouterService.resolve
     1. rich menu (postback/label)                     → ตอบเมนู
     2. gateBeforeSearch: greet / cancel / register / trusted rule
     3. KnowledgeRetrievalService.retrieve  (disableProduct ถ้าอยู่ใน REGISTER)
        └─ ProductRetrievalService.retrieveProduct
           a. productRagEnabled + มี userId/turnId/lineMemberId/conversationId?   ไม่ → legacy
              (ช่อง APP ไม่มี lineMemberId จึงไม่เข้า product เลย)
           b. ทั้งข้อความเป็นคำถามนโยบาย ecom ("ส่งฟรีไหม" …)?                     ใช่ → legacy
           c. scope = บริษัทเดียวในระบบ (forLineDeployment)                         ไม่ชัด → legacy
           d. CommerceTurn ของ event นี้มีแล้ว? → ใช้ plan/retrieval ที่เก็บไว้ (replay)
           e. routeWithoutPlanner:
                productSignal regex | referenceSignal + มี refs | probe(ชื่อ/alias/SKU) | mentionsCatalog
                  → ใช่: PLAN
                  → ไม่: รัน legacy; ถ้ามั่นใจ → legacy; ถ้าเป็นคำนโยบาย → KNOWLEDGE; ไม่งั้น PLAN
           f. plan:  broad opener → MISSING_INPUT (0 LLM)
                     exact SKU     → plan จากกฎ (0 LLM)
                     นโยบายล้วน    → KNOWLEDGE (0 LLM)
                     อื่นๆ          → LLM PLAN (JSON) → ตรวจ id/variant/option/filter/ราคา
                     มี probe แต่ model ตอบ GENERAL → บังคับเป็น PRODUCT/BOTH
           g. groundStockFilter (inStockOnly ต้องมีคำในข้อความจริง)
           h. search (RepeatableRead tx) → [semantic fallback ถ้า NO_MATCH]
           i. KNOWLEDGE → legacy knowledge; BOTH → knowledge(policyQuery) เพิ่ม
     4. decideFromRetrieval: มี product → ANSWER_KNOWLEDGE (ข้าม classifier BUSINESS/GENERAL)
 └─ AiChatService.answerKnowledge → ProductAnswerService.answer (lease)
     - failed / KNOWLEDGE ไม่มีหลักฐาน → fallback + requestAdmin
     - status ≠ FOUND → safeProductAnswer (ข้อความจากโค้ด, 0 LLM)
     - FOUND → LLM ANSWER (JSON template) → renderProductAnswer ตรวจ
         ไม่ผ่าน + คำถามสำคัญ → CRITICAL_REPAIR (call ที่ 3)
         INSUFFICIENT_CONTEXT → ชื่อสินค้าใกล้เคียง หรือ fallback
         ไม่ผ่านทั้งหมด → safeProductAnswer
     - เก็บ response + catalogRefs (เพื่อให้ "ตัวนี้" ใน turn ถัดไปอ้างถึงได้)
```

### 2.3 การประเมิน flow

| ด้าน | ดี | ยังไม่ดี |
|---|---|---|
| **เลือกเข้า product (classifier)** | gate ราคาถูกก่อน LLM; planner ทำหน้าที่ classifier ไปในตัว (ไม่ต้องเรียก 2 รอบ); FAQ ที่มั่นใจไม่ต้องเรียก planner | สัญญาณเป็น regex คำ ecom ที่เทียบแบบ substring (A1, M6) |
| **Planner** | JSON schema strict; ID ต้องมาจาก probe/refs; field/operator ต้องอยู่ใน preset; ช่วงราคาตรวจด้วย Decimal | ไม่รู้วันเวลาปัจจุบัน (A2); filter EQ บน option หายเงียบ (M8) |
| **Match** | aggregate scan ทั้ง catalog; ใช้ option บน variant เดียวกัน; ถ้าเสมอกันจะถามกลับ ไม่เลือกเอง; VARIANT_UNAVAILABLE บอกตัวเลือกที่มีจริง | LIMIT 60 ก่อนกรอง (H3); `language='th'` ตายตัว |
| **ตัดสินใจตอบ** | token-only facts; ห้ามตัวเลขนอก token; ต้องตอบครบตามที่ถาม; INSUFFICIENT_CONTEXT แยกจาก format error | คำที่ห้ามและข้อความ fallback เป็น ecom (A3); policy อ่อนถูกแนบท้าย (P1) |
| **Idempotency/billing** | CommerceTurn ต่อ event, lease, slot ต่อ LLM call สูงสุด 3, operationKey ของ billing | – |

**โดยรวม:** สถาปัตยกรรมเป็นแบบที่ควรเป็นสำหรับ product RAG ที่ต้องไม่ตอบมั่ว ไม่ต้องรื้อ ที่ต้องทำคือเอาสมมติฐานของ ecom ออกจาก core แล้วย้ายไปไว้ใน preset

---

## 3. Audit findings

ระดับ: **H** = ต้องแก้ก่อนเปิดใช้กับ BKS · **M** = แก้ในรอบเดียวกัน · **L** = แก้เมื่อสะดวก
ป้าย: **[ใหม่]** พบในรอบนี้ · **[ค้าง]** อยู่ใน audit เดิมและยังไม่แก้ (ตรวจกับโค้ดแล้ว)

### H — ก่อนเปิดใช้กับ BKS

#### A1 [ใหม่] สัญญาณเข้า flow product เป็นคำศัพท์ ecom ที่เขียนตายตัว
- **ที่:** [product-retrieval.service.ts:47-59](../../src/modules/chatbot/knowledge/product/product-retrieval.service.ts#L47) (`policySignal`, `productSignal`, `isBroadProductInquiry`, `referenceSignal` มี "สีดำ/สีขาว") และ regex นโยบายทั้งข้อความที่ [:99-104](../../src/modules/chatbot/knowledge/product/product-retrieval.service.ts#L99)
- **ผลกับ BKS:** คำอย่าง `รถ`, `ตั๋ว`, `รอบ`, `ที่นั่ง`, `ออกกี่โมง`, `เต็ม` ไม่อยู่ในสัญญาณ การเข้า planner จึงขึ้นกับว่าชื่อ/หมวดสินค้ามีคำนั้นหรือไม่ (`mentionsCatalog`) ตัวอย่าง: "พรุ่งนี้มีรถไหม" อาจไม่เข้า product แล้วไปตอบจาก MicroKnowledge แทน ส่วน `สี` ใน `productSignal` ไป match คำว่า "รถเสีย" ทำให้เสีย planner call เปล่า (M6 เดิม)
- **แก้:** ย้ายคำทั้งหมดไปไว้ที่ `preset.lexicon.signals` และเทียบเป็นคำด้วย `Intl.Segmenter` (แก้ M6 ไปพร้อมกัน) ค่า default ของ ECOMMERCE ใช้คำชุดปัจจุบัน

#### A2 [ใหม่] ไม่มีวันเวลาปัจจุบันใน prompt ใดๆ และไม่มี field ชนิดวัน/เวลา
- **ที่:** [ai-setting-prompt.composer.ts](../../src/modules/chatbot/shared/prompt/ai-setting-prompt.composer.ts) และ [product-prompt.ts](../../src/modules/chatbot/knowledge/product/utils/prompt/product-prompt.ts) ไม่มี `now`, timezone หรือวันในสัปดาห์ ส่วน `ATTRIBUTE_TYPES` ([attribute-definition.types.ts:203](../../src/modules/products/attributes/types/attribute-definition.types.ts#L203)) มีแค่ TEXT/NUMBER/BOOLEAN/SELECT/MULTI_SELECT/TAGS
- **ผล:** "พรุ่งนี้", "คืนนี้", "ศุกร์นี้", "สองทุ่ม" ถูกตีความไม่ได้ หรือ model เดาวันเอง ถ้าเก็บเวลาเป็น TEXT "07:30" ก็กรองช่วงเวลา (หลัง 18:00) ไม่ได้
- **แก้:** date resolver (หัวข้อ 5.7) และเก็บเวลาเป็นคอลัมน์ของ slot ไม่เก็บใน meta

#### A3 [ใหม่] ข้อความตอบและตัวกันมั่วผูกกับคำศัพท์ ecom และไม่กันคำว่า "ว่าง/เต็ม"
- **ที่:**
  - [product-answer.policy.ts:26-32](../../src/modules/chatbot/knowledge/product/product-answer.policy.ts#L26) `stockLabels` ("มีสินค้าคงเหลือ", "ร้านไม่ได้เปิดระบบติดตามสต็อก")
  - [:540](../../src/modules/chatbot/knowledge/product/product-answer.policy.ts#L540) หน่วย "ชิ้น"
  - [:611-618](../../src/modules/chatbot/knowledge/product/product-answer.policy.ts#L611) "หมายถึงสินค้ารุ่นไหนคะ … ระบุสีและขนาด", "ระบุชื่อรุ่นหรือ SKU"
  - [:404-410](../../src/modules/chatbot/knowledge/product/product-answer.policy.ts#L404) คำต้องห้ามนอก token มีแค่ `มีของ|มีสินค้า|พร้อมส่ง|สินค้าหมด|หมดสต็อก|เหลือ\s|ส่งฟรี|…`
- **ผลกับ BKS:**
  1. ลูกค้าถาม "รอบ 20:00 เต็มยัง" แต่ variant ไม่ track stock → ได้คำตอบ "ร้านไม่ได้เปิดระบบติดตามสต็อก"
  2. **ความเสี่ยงหลัก:** model เขียน "รอบนี้ยังว่างอยู่ค่ะ" หรือ "เต็มแล้วค่ะ" ใน prose ได้โดยไม่ใช้ token เพราะทั้งสองคำไม่อยู่ในรายการห้าม ผลคือแต่งสถานะที่นั่งขึ้นเอง ซึ่งเป็นความผิดประเภทเดียวกับการแต่งราคา
- **แก้:** `preset.lexicon` (หัวข้อ 5.5) กำหนด label, หน่วย, ข้อความถามกลับ และ `claimWords` ที่ถูกรวมเข้า regex ต้องห้ามของ renderer

#### A4 [ใหม่] ตารางเวลาและค่าโดยสาร BKS อยู่ใน MicroKnowledge (ข้อความ + vector)
- **ที่:** `prisma/mock-timetable-micro-knowledge.json` (ค่าโดยสาร 590/890 บาท และเวลา 07:30, 09:00, …) และ pattern ภาพรวม `MOCK_SCHEDULE_OVERVIEW`
- **ผล:** ขัดกฎ "Price, stock … come from DB/API, never vector text" ([.claude/rules/rag-ai.md](../../.claude/rules/rag-ai.md)) และเมื่อเปิด product จะมีข้อมูลจริงสองแหล่ง ใน mode `BOTH` คำตอบอาจได้ราคาจาก product และ policy ที่มีราคาเก่าพร้อมกัน
- **แก้:** เมื่อ import route/fare เข้า product แล้ว ให้ปิด (`active=false`) ทั้ง MicroKnowledge และ AnswerPattern หมวด `MOCK_TIMETABLE` (pattern `MOCK_SCHEDULE_OVERVIEW` เป็น DIRECT จึงจะตอบตารางเก่าก่อนถึง product เสมอ) เหลือเฉพาะข้อความทั่วไปอย่าง "เวลาอาจเปลี่ยนแปลง ตรวจสอบได้ที่…" เป็น policy

#### C1 [ค้าง: AUDIT.md] `catalogRefs: []` กลายเป็น `{}` ใน Redis
- **ที่:** Lua ใน [load-context.service.ts](../../src/modules/chatbot/context/load-context.service.ts) (decode/encode ทุก turn, cjson เข้ารหัส table ว่างเป็น object)
- **ผล:** หลัง turn ที่ไม่ได้แสดงสินค้า (GENERAL, COUNT) คำถาม "รอบนั้นเต็มไหม" จะอ้างถึงสินค้า/รอบที่แสดงไว้สอง turn ก่อน สำหรับ BKS เป็นข้อมูลรอบผิดทั้งที่ตอบด้วยน้ำเสียงมั่นใจ
- **แก้:** `cjson.encode_empty_table_as_object(false)` หรือเก็บ refs เป็น JSON string ที่ Lua ไม่ decode

#### H3 [ค้าง: audit-product-22] DETAIL ที่มีคำค้นตัด candidate ที่ 60 ก่อนกรอง option/filter
- **ที่:** [product-search.service.ts:353](../../src/modules/products/search/product-search.service.ts#L353)
- **ผลกับ BKS:** ปลายทางยอดนิยม (เช่น "เชียงใหม่" ที่ match ทั้งชื่อ, stops และ description ของหลายเส้นทาง) อาจทำให้ route ที่ตรงต้นทาง/ปลายทางหลุดจาก 60 ตัวแรก
- **แก้:** ตามข้อเสนอเดิม: เมื่อ plan มี options/filters ให้ใช้เส้นทาง keyset scan เดียวกับ aggregate

### M — แก้ในรอบเดียวกัน

#### P1 [ค้าง: AUDIT.md] policy ที่หลักฐานอ่อนถูกแนบท้ายคำตอบสินค้าทั้งข้อความ
- **ที่:** [product-retrieval.service.ts:425-432](../../src/modules/chatbot/knowledge/product/product-retrieval.service.ts#L425) เก็บ `selectedItems` แม้ route เป็น `LOW_CONFIDENCE` แล้ว `safeProductAnswer` ต่อ `policies.map(e => e.answer)` ท้ายข้อความ
- **แก้:** ใช้ policy เฉพาะจาก retrieval ที่ไม่ใช่ `LOW_CONFIDENCE` ไม่งั้นใช้ `POLICY_UNVERIFIED_NOTE`

#### P2 [ค้าง: AUDIT.md] ความถูกต้องขึ้นกับว่า company มี preset ที่ลงทะเบียน + เทสต์ C02 ล้ม
- **ที่:** [presets/index.ts](../../src/modules/products/attributes/presets/index.ts) มีแค่ `ECOMMERCE` ส่วน `presets/custom/prasya.preset.ts` และ `prompts/custom/prasya.prompt.ts` เป็นสำเนาของ ECOMMERCE ที่ไม่ได้ลงทะเบียน (dead code)
- **ผลต่อ design นี้:** การเปลี่ยน BKS เป็น TRANSPORT ต้องทำผ่าน endpoint apply preset (bump `searchRevision` + re-embed) และต้องมี go-live check ว่าค่า `company.productBusinessType` ถูกต้อง
- **แก้:** แก้ fixture ของ C02 ให้ใช้ ECOMMERCE, ลบ `custom/prasya.*` หรือลงทะเบียนให้ถูก และเพิ่มเทสต์ที่วนทุก preset (M6 เดิม: `assertSafeDefinition`)

#### M8 [ค้าง] filter EQ บน key ที่เป็น option หายเงียบ
- **ที่:** [product-retrieval.service.ts:313-330](../../src/modules/chatbot/knowledge/product/product-retrieval.service.ts#L313)
- **ผลกับ BKS:** "VIP หรือชั้น 1 ก็ได้" ได้ option เดียว อีกตัวหายไป
- **แก้:** ลบออกจาก filters เฉพาะตัวที่ย้ายไป options สำเร็จ

#### M1 [ค้าง] `categories` ของ field ใน preset ถูกเขียนทับด้วยหมวดของร้าน
- **ที่:** [catalog-fields.ts:51](../../src/modules/products/search/catalog-fields.ts#L51)
- **ผล:** ถ้าบริษัทขนส่งขายทั้งตั๋วรถและพัสดุ (BKS Express) จะกำหนดไม่ได้ว่า field `bus_class` ใช้กับหมวด "ตั๋วโดยสาร" เท่านั้น
- **แก้:** ใช้ `field.categories` ของ preset ถ้ามี

#### A5 [ใหม่] ช่อง APP (in-app chat) ไม่มี product เลย
- **ที่:** [app-channel.adapter.ts:66](../../src/modules/app-message/app-channel.adapter.ts#L66) ไม่มี `lineMemberId` และ `CommerceTurn.lineMemberId` เป็น FK ไป `LineMember`
- **ผล:** ถ้า BKS เปิดแชตในแอป ลูกค้าจะถามรอบรถไม่ได้ ไปตอบด้วย legacy knowledge แทน (ซึ่งก็คือ MicroKnowledge ที่ A4 จะปิด)
- **แก้ (เมื่อเปิดช่อง APP):** ให้ `CommerceTurn` อ้าง `ChannelConversation` ได้ (`lineMemberId` เป็น nullable + `channelConversationId`) เป็นงานแยก ไม่ใช่ส่วนหนึ่งของ design นี้

### L — เมื่อสะดวก

| ID | ที่ | เรื่อง |
|---|---|---|
| L-a [ใหม่] | [product-terms.ts](../../src/modules/products/search/product-terms.ts) | `QUESTION_TERMS` มีคำที่เป็นชื่อสินค้าได้ในธุรกิจอื่น (`ลูก`, `ใบ`, `ส่ง`, `ไป`, `ดี`) ให้ย้ายส่วนที่ขึ้นกับธุรกิจไปไว้ใน `lexicon.questionWords` |
| L-b [ค้าง M7] | [product-retrieval.service.ts:378](../../src/modules/chatbot/knowledge/product/product-retrieval.service.ts#L378) | `language='th'` ตายตัว |
| L-c [ค้าง M4] | `plannerCatalog` | scan meta ของทุก variant ทุก turn และค่า TAGS ออกมาเป็น JSON string |
| L-d [ค้าง M3/L9] | `forLineDeployment` | อ่าน company ทุก turn และใช้ได้กับบริษัทเดียวเท่านั้น |
| L-e [ค้าง] | `package.json` | `test:commerce`, `test:product-audit` ชี้ไป `test/scripts/` ซึ่งไม่มีอยู่แล้ว |

---

## 4. เทียบกับ best practice

ส่วนของ ecom อยู่ในตารางของ [audit-product-22.md §2](../audit-product-22.md) แล้ว ตารางนี้เพิ่มเฉพาะเรื่องที่ใหม่เมื่อสินค้าเป็นรอบ/เวลา

| แนวปฏิบัติ | แหล่ง | ตอนนี้ | หลัง design นี้ |
|---|---|---|---|
| ให้ LLM แปลงคำถามเป็น filter แบบมีโครงสร้าง (self-query) แล้วให้ระบบค้นจริงเป็นผู้กรอง ความแม่นยำขึ้นกับการนิยาม metadata ให้ชัด | Elastic self-query | ✓ (planner + preset fields) | ✓ เพิ่ม `when`, `quantity` |
| ใส่วันเวลาปัจจุบันและ timezone ลงใน prompt จากโค้ด ให้ model ตอบเป็นวันที่แบบ ISO แล้วตรวจในโค้ด; คำที่ต้องแม่นให้ resolve นอก model; ถ้าตัวเลือกมีจำกัดให้แนบ label ของวันไปด้วย | Vapi, neura.market, cnoe date guide | ✗ ไม่มี now | ✓ ปฏิทิน 14 วันพร้อม label + parser ภาษาไทยแบบ deterministic |
| แยก route (เส้นทาง) / trip (เที่ยว) / ปฏิทินวันวิ่ง + ข้อยกเว้น | GTFS | ✗ | Product/Variant/Slot; ปฏิทินถูกขยายเป็นแถวตอน import (ไม่เก็บกฎ) |
| สินค้าแบบมีรอบ: product → session/slot ที่มีวันเวลา + capacity + cutoff | FareHarbor/Rezdy (สรุปจากแหล่งรอง) | ✗ | ✓ `productSlots` |
| ความจุต่อรอบหักแบบ atomic (conditional update เมื่อพอ), hold มีวันหมดอายุ, คืน hold ปลอดภัยจาก race | ticket-booking LLD, AWS fair seat | ไม่มี | ออกแบบไว้ (5.10) ยังไม่ทำ เพราะยังไม่จองผ่านแชต |
| ตัวเลขที่เปลี่ยนเร็ว (ราคา/สต็อก/ที่นั่ง) ต้องมาจากแหล่งจริงและบอกเวลาที่ตรวจ | rag-ai rules, Elastic (freshness ขึ้นกับรอบ refresh) | ✓ ราคา/สต็อก | ✓ + guard อายุข้อมูล (`maxAgeMinutes`) |
| LLM ไม่คำนวณเอง (วัน ผลบวก จำนวนพอไหม) | Vapi date guidance | ✓ ราคา | ✓ เวลา ที่นั่ง รอบใกล้เคียง |

---

## 5. Design

### 5.1 หลักการ

1. **Product / Variant / Slot** เป็นสามชั้นทั่วไป ธุรกิจเลือกใช้ Slot หรือไม่ผ่าน preset
2. **Preset เป็นข้อมูลทั้งหมดที่ต่างกันระหว่างธุรกิจ:** fields, prompt, ความสามารถ (capabilities) และคำศัพท์ (lexicon) โค้ดแตกเส้นทางตาม capability ไม่ใช่ตามชื่อธุรกิจ (ห้ามมี `if (businessType === 'TRANSPORT')` ใน core)
3. **ค่าที่เปลี่ยนเร็วไม่อยู่ใน meta:** ราคาอยู่ที่คอลัมน์ `price`, สต็อกอยู่ที่ `inventoryBalances`, เวลาและที่นั่งอยู่ที่ `productSlots` ส่วน meta เก็บคุณสมบัติที่ค่อนข้างคงที่ (ต้นทาง ปลายทาง ชั้นรถ ระยะเวลา จุดจอด)
4. **LLM เข้าใจ โค้ดคำนวณ token แสดงผล** รักษาสัญญาเดิมของ renderer ไว้ทุกข้อ
5. **เพิ่มเท่าที่จำเป็น:** ตารางใหม่ 1 ตาราง, enum 1 ตัว, field ใน plan 4 ตัว ไม่มี rule engine, ไม่มี seat map

### 5.2 ใช้กับแต่ละธุรกิจอย่างไร

| ธุรกิจ | Product | Variant (ราคา) | Slot | stock ที่ใช้ |
|---|---|---|---|---|
| ecom | เสื้อเชิ้ตลินิน | สีดำ/L | – | `inventoryBalances` ต่อ variant |
| **ขนส่ง (BKS)** | กรุงเทพฯ (หมอชิต 2) → เชียงใหม่ | VIP / ชั้น 1 | 6 พ.ย. 20:00, 24 ที่ | capacity ต่อ slot (`trackStock=false` ที่ variant) |
| ทัวร์ | เชียงใหม่ 3 วัน 2 คืน | ผู้ใหญ่ / เด็ก / พักเดี่ยว | ออกเดินทาง 12 ธ.ค. รับ 30 คน | capacity ต่อ slot |
| คอร์ส/อีเวนต์ | เวิร์กช็อปกาแฟ | บัตรปกติ / VIP | รอบ 14 พ.ย. 13:00 | capacity ต่อ slot |
| คลินิก/ซาลอน (นัด) | ทำสีผม | 60 / 90 นาที | 10:00–11:00 (capacity 1) | capacity ต่อ slot |
| โรงแรม | – | – | – | **ไม่ครอบคลุม:** การพักหลายคืนต้องเช็คทุกคืนในช่วง ถ้าจะทำต้องออกแบบแยก |

ทัวร์มักมีราคาต่างกันตามวัน เมื่อมีลูกค้าทัวร์จริงให้เพิ่ม `productSlots.priceOverride Decimal?` เป็นคอลัมน์ nullable (additive ไม่ breaking) **ไม่ทำตอนนี้** เพราะค่าโดยสาร BKS ผูกกับเส้นทางและชั้นรถ

### 5.3 ต้องมี stock ไหม

- **ไม่ใช้** stock แบบ SKU (`inventoryBalances`) กับตั๋ว เพราะที่นั่งไม่ใช่ของในคลัง ที่นั่งของรอบ 07:30 วันนี้ขายพรุ่งนี้ไม่ได้ ถ้าใช้ balance ต่อ variant จะรวมทุกรอบเป็นก้อนเดียวซึ่งผิดความหมาย ตั้ง `trackStock=false` ที่ variant ของตั๋ว
- **ใช้** ความจุต่อรอบ: `capacity` (จำนวนที่นั่งของรถคันนั้น) และ `reserved` (ขาย/จองแล้ว) ที่แถว slot ที่นั่งว่าง = `max(0, capacity − reserved)` ความหมายเดียวกับ `onHand − reserved` ที่ renderer และ token ใช้อยู่ จึงใช้โค้ดแสดงผลสต็อกเดิมได้เกือบทั้งหมด
- **`capacity` เป็น null ได้** แปลว่ายังไม่มีข้อมูลที่นั่ง ระบบตอบเวลาและราคาได้ แต่สถานะที่นั่งจะเป็น "ยังตรวจสอบที่นั่งไม่ได้ ดูที่นั่งล่าสุดได้ที่ BKS E-Ticket" ทำให้ phase 2 ใช้งานได้ทันทีโดยยังไม่ต้องเชื่อมระบบจอง
- **ไม่ทำ seat map** (เลขที่นั่งรายตัว) ลูกค้าในแชตถามว่า "ยังมีที่ไหม/พอสำหรับ 3 คนไหม" ซึ่งตัวเลขรวมตอบได้ การเลือกที่นั่งรายตัวเป็นงานของระบบจองตั๋ว

### 5.4 Schema (additive)

```prisma
enum ProductSlotStatus {
  OPEN       // ขาย/ให้ข้อมูลได้
  CLOSED     // ปิดขาย (เช่น ใกล้เวลาออก หรือแอดมินปิด)
  CANCELLED  // ยกเลิกรอบ
}

/// One dated occurrence of a variant: a bus departure, tour date or class session.
/// capacity/reserved are perishable inventory of this occurrence only.
model ProductSlot {
  id        String         @id @default(uuid()) @db.Uuid
  companyId String         @db.Uuid
  variantId String         @db.Uuid
  variant   ProductVariant @relation(fields: [variantId, companyId], references: [id, companyId], onDelete: Restrict)

  startsAt  DateTime          // UTC, convention เดียวกับตารางอื่น (timestamp(3))
  endsAt    DateTime?         // เวลาถึงโดยประมาณ (ข้ามวันได้)
  status    ProductSlotStatus @default(OPEN)

  capacity        Int?        // null = ยังไม่ทราบจำนวนที่นั่ง
  reserved        Int       @default(0)
  /// เวลาที่ capacity/reserved ถูกยืนยันล่าสุด (แอดมินกรอกหรือ sync); null = ไม่เคยยืนยัน
  availabilityAt  DateTime?
  /// ค่าตาม field ของ preset ที่ scope = SLOT เช่น platform, bus_no (ห้ามมีราคา/จำนวน)
  meta      Json     @default("{}")

  version   Int      @default(1)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([id, companyId])           // ให้ hold/order อ้างแบบ composite FK ได้ในอนาคต
  @@unique([variantId, startsAt])     // import ซ้ำได้โดยไม่เกิดรอบซ้ำ
  @@index([companyId, startsAt])
  @@map("productSlots")
}
```

- `ProductVariant` ต้องเพิ่ม back relation `slots ProductSlot[]` (Prisma บังคับ ไม่มีผลกับคอลัมน์)
- **ทำไมไม่มี `productId`:** หาได้จาก variant อยู่แล้ว และ search รู้ `variantIds` ก่อนค้น slot การเก็บซ้ำจะต้องมี FK อีกตัวและตรวจความสอดคล้องเพิ่ม
- **ทำไม UTC `timestamp(3)` ไม่ใช่ `timestamptz`:** ตามแบบตารางอื่นในโปรเจกต์ (เช่น analytics แปลง `AT TIME ZONE` ตอน query) ไม่ให้มีสองแบบปนกัน ทุกการแสดงผลแปลงเป็น `Asia/Bangkok` ในโค้ด
- **CHECK ใน migration (SQL ดิบ):** `capacity IS NULL OR capacity >= 0`, `reserved >= 0` **ไม่บังคับ** `reserved <= capacity` เพราะข้อมูล sync จากระบบภายนอกอาจขายเกิน (overbook) ได้จริง การคำนวณที่ว่างจึงใช้ `max(0, …)`
- **Migration:** สร้าง enum + ตารางใหม่เท่านั้น ไม่มี backfill ไม่แตะแถวเดิม (ตาม [.claude/rules/prisma.md](../../.claude/rules/prisma.md): `migrate dev --create-only` บน local แล้วตรวจ SQL)
- **ทำไมไม่ทำเป็น variant ต่อรอบ (ไม่ต้องแก้ schema):** หนึ่งเส้นทาง × 2 ชั้น × 4 รอบ × 90 วัน = 720 variant ต่อสินค้า ซึ่ง search โหลด variant ทั้งหมดทุกครั้ง (`include.variants`), document ที่ใช้ embed รวม SKU ทุก variant จึงต้อง re-embed ทุกครั้งที่เพิ่มรอบ และรอบที่ผ่านไปแล้วต้องมีงานปิด สรุปคือแพงกว่าและผิดความหมาย
- **ทำไมไม่เก็บกฎปฏิทิน (แบบ GTFS calendar):** กฎ + ข้อยกเว้นต้องมี engine ขยายรอบตอนอ่าน ซึ่งเกินความจำเป็น ให้ import endpoint รับรูปแบบรายสัปดาห์แล้วขยายเป็นแถวจริงตอนเขียน (5.11) ข้อยกเว้น (งดวิ่ง/เพิ่มรอบ) คือการแก้แถวตรงๆ

### 5.5 Preset: capabilities + lexicon

```ts
// attribute-definition.types.ts (ข้อเสนอ)
export type AvailabilityState =
  | 'AVAILABLE' | 'LOW' | 'FULL' | 'CLOSED' | 'UNKNOWN' | 'NOT_TRACKED';

export type BusinessCapabilities = Readonly<{
  /** แหล่งของ "ยังมีไหม": stock ต่อ variant, ความจุต่อ slot หรือไม่มี */
  inventory: 'VARIANT_STOCK' | 'SLOT_CAPACITY' | 'NONE';
  /** แสดงจำนวนจริง ("ว่าง 5 ที่") หรือแค่สถานะ ("ว่าง/ใกล้เต็ม/เต็ม") */
  showQuantity: boolean;
  /** ที่ว่าง ≤ ค่านี้ = LOW */
  lowThreshold: number | null;
  /** จำนวนที่ลูกค้าขอได้ในหนึ่งคำถาม (คน/ชิ้น) */
  maxQuantity: number;
  slot?: Readonly<{
    horizonDays: number;          // เปิดให้ถามล่วงหน้ากี่วัน
    cutoffMinutes: number;        // ภายในกี่นาทีก่อนออก ถือว่าปิดขาย
    maxAgeMinutes: number | null; // availabilityAt เก่ากว่านี้ = UNKNOWN; null = ไม่ตรวจ
  }>;
}>;

export type BusinessLexicon = Readonly<{
  unit: string;                                   // 'ชิ้น' | 'ที่นั่ง' | 'ที่'
  availability: Readonly<Record<AvailabilityState, string>>;
  clarify: Readonly<{ which: string; none: string; notFound: string; when?: string }>;
  /** คำ (ตัดคำแล้ว) ที่บอกว่าเป็นคำถาม catalog → PLAN */
  signals: readonly string[];
  /** คำบอกนโยบาย → KNOWLEDGE เมื่อไม่มีสัญญาณ catalog */
  policySignals: readonly string[];
  /** คำบอกสถานะที่ห้ามอยู่ใน prose นอก token */
  claimWords: readonly string[];
  /** คำถาม/คำลักษณนามเพิ่มเติมที่ไม่ใช่ชื่อสินค้าของธุรกิจนี้ */
  questionWords: readonly string[];
}>;

export type BusinessPreset = Readonly<{
  label: string;
  prompt: BusinessPrompt;
  fields: readonly AttributeDefinitionInput[];      // scope: 'VARIANT' | 'SLOT'
  capabilities?: BusinessCapabilities;              // default = ECOMMERCE_CAPABILITIES
  lexicon?: BusinessLexicon;                        // default = ECOMMERCE_LEXICON
}>;
```

- **ECOMMERCE_LEXICON = ค่าที่เขียนตายตัวอยู่ตอนนี้ทุกคำ** (`stockLabels`, "ชิ้น", ข้อความถามกลับ, regex สัญญาณ) phase 1 ต้องพิสูจน์ด้วยเทสต์ว่าคำตอบ ecom ไม่เปลี่ยนแม้แต่ตัวอักษรเดียว
- อ่าน preset ผ่าน [catalog-fields.ts](../../src/modules/products/search/catalog-fields.ts) เท่านั้น (เพิ่ม `loadCatalogContext().capabilities/lexicon`) เพื่อรักษากฎ "ผู้อ่าน `BUSINESS_PRESETS` มีที่เดียว"
- field `scope: 'SLOT'` ใหม่ ใช้ validator ตัวเดิม (`validateAttributeValues`) และ key ต้องห้ามชุดเดิม

### 5.6 TRANSPORT preset (ใช้ได้กับบริษัทขนส่งไทยทั่วไป ไม่ผูก BKS)

```ts
// presets/transport.preset.ts (ข้อเสนอ)
const PLACE_ALIASES = {
  'กรุงเทพฯ': ['กรุงเทพ', 'กทม', 'bangkok', 'bkk', 'หมอชิต', 'สายใต้', 'เอกมัย'],
  'นครราชสีมา': ['โคราช', 'korat'],
  'เชียงใหม่': ['chiang mai', 'cnx'],
  // …ชื่อจังหวัด/สถานีที่ให้บริการ
};

export const TRANSPORT_PRESET: BusinessPreset = {
  label: 'ขนส่ง/รถโดยสาร',
  prompt: TRANSPORT_PROMPT,
  fields: [
    { key: 'origin', label: 'ต้นทาง', scope: 'VARIANT', type: 'TEXT', valueAliases: PLACE_ALIASES, sortOrder: 1 },
    { key: 'destination', label: 'ปลายทาง', scope: 'VARIANT', type: 'TEXT', valueAliases: PLACE_ALIASES, sortOrder: 2 },
    { key: 'origin_terminal', label: 'สถานีต้นทาง', scope: 'VARIANT', type: 'TEXT', sortOrder: 3 },
    { key: 'destination_terminal', label: 'สถานีปลายทาง', scope: 'VARIANT', type: 'TEXT', sortOrder: 4 },
    { key: 'bus_class', label: 'ชั้นรถ', scope: 'VARIANT', type: 'SELECT', variantOption: true,
      options: ['VIP', 'ชั้น 1', 'ชั้น 2'], valueAliases: { VIP: ['วีไอพี'], 'ชั้น 1': ['ป.1', 'ชั้นหนึ่ง'] }, sortOrder: 10 },
    { key: 'duration_min', label: 'ระยะเวลาเดินทาง', scope: 'VARIANT', type: 'NUMBER', unit: 'นาที', sortOrder: 20 },
    { key: 'distance_km', label: 'ระยะทาง', scope: 'VARIANT', type: 'NUMBER', unit: 'กม.', sortOrder: 21 },
    { key: 'stops', label: 'จุดจอดระหว่างทาง', scope: 'VARIANT', type: 'TAGS', sortOrder: 22 },
    { key: 'amenities', label: 'สิ่งอำนวยความสะดวก', scope: 'VARIANT', type: 'TAGS', sortOrder: 23 },
    { key: 'platform', label: 'ชานชาลา', scope: 'SLOT', type: 'TEXT', sortOrder: 30 },
  ],
  capabilities: {
    inventory: 'SLOT_CAPACITY',
    showQuantity: true,           // ตัดสินใจโดยเจ้าของ (หัวข้อ 10)
    lowThreshold: 5,
    maxQuantity: 10,
    slot: { horizonDays: 30, cutoffMinutes: 30, maxAgeMinutes: 15 },
  },
  lexicon: {
    unit: 'ที่นั่ง',
    availability: {
      AVAILABLE: 'มีที่นั่งว่าง', LOW: 'ที่นั่งใกล้เต็ม', FULL: 'ที่นั่งเต็ม',
      CLOSED: 'ปิดการขายรอบนี้', UNKNOWN: 'ยังตรวจสอบที่นั่งไม่ได้', NOT_TRACKED: 'ยังตรวจสอบที่นั่งไม่ได้',
    },
    clarify: {
      which: 'ต้องการเดินทางเส้นทางไหนคะ',
      none: 'ต้องการเดินทางจากที่ไหนไปที่ไหนคะ',
      notFound: 'ยังไม่พบเส้นทางที่ตรงกับคำถาม ระบุต้นทางและปลายทางเพิ่มเติมได้ค่ะ',
      when: 'ต้องการเดินทางวันไหนคะ',
    },
    signals: ['รถ', 'ตั๋ว', 'รอบ', 'เที่ยว', 'ที่นั่ง', 'ค่าโดยสาร', 'ออก', 'ถึง', 'เต็ม', 'ว่าง'],
    policySignals: ['คืนตั๋ว', 'เลื่อนตั๋ว', 'สัมภาระ', 'กระเป๋า', 'ส่วนลด', 'นโยบาย'],
    claimWords: ['ว่าง', 'เต็ม', 'ที่นั่ง', 'ออกแล้ว', 'ยกเลิก'],
    questionWords: ['โมง', 'ทุ่ม', 'ตี', 'วัน', 'พรุ่งนี้', 'วันนี้', 'คืนนี้', 'คน', 'ท่าน'],
  },
};
```

- **ข้อควรระวังเรื่อง key:** `SENSITIVE_KEY_WORDS` ห้าม `address`, `qty`, `quantity` และ label ห้าม "ที่อยู่" ([attribute-key.constants.ts](../../src/modules/products/attributes/utils/attribute-key.constants.ts)) จึงต้องใช้ `pickup_point` ไม่ใช่ `pickup_address` และความจุต้องเป็นคอลัมน์ของ slot ไม่ใช่ meta (เป็น inventory ตามกฎเดียวกับ stock)
- **ทิศทาง:** ต้องแยก `origin`/`destination` เป็น field และ **ห้ามใส่ชื่อปลายทางเดี่ยวๆ เป็น alias ของ product** (เช่น alias "เชียงใหม่") ไม่งั้น `probe` จะ match ทั้งขาไปและขากลับ แล้วถามกลับทุกครั้ง alias ที่ถูกคือชื่อคู่อย่าง "กรุงเทพ-เชียงใหม่", "กทม เชียงใหม่" ส่วนคำถาม "ไปเชียงใหม่" ให้ planner ใส่ filter `destination EQ เชียงใหม่` แล้ว optionMatcher จัดการ alias ของสถานที่ให้
- **จุดจอดระหว่างทาง:** ใช้ตอบ "รถผ่านลำปางไหม" (`stops CONTAINS`) ได้ แต่**ค่าโดยสารต่อช่วงทาง** (ขึ้นกลางทาง) ไม่ทำ ให้ขายคู่ต้นทาง-ปลายทางเป็น product ของตัวเองแบบที่ระบบจองตั๋วทำ

TRANSPORT_PROMPT (planner): ใช้ `origin`/`destination` เป็น filter EQ, `bus_class` เป็น option, เวลา/วันใส่ `when` เท่านั้น, จำนวนผู้โดยสารใส่ `quantity`, "รอบถัดไป/รอบต่อไป/คันต่อไป" = `operation NEXT`, ห้ามเดาต้นทางเมื่อลูกค้าไม่บอก (ปล่อยว่างแล้วให้ระบบถามกลับพร้อมตัวเลือก)
TRANSPORT_PROMPT (answer): เวลา วันที่ ที่นั่ง และสถานะต้องมาจาก token เท่านั้น, ถ้ารอบที่ถามเต็ม/ปิด/ออกไปแล้วให้บอกตรงๆ แล้วเสนอรอบใน `alternatives`, ห้ามยืนยันการจองหรือกันที่นั่ง

### 5.7 Plan + date resolver

**field ใหม่ใน `productPlanSchema`** (ใช้ได้ทุกธุรกิจ):

```ts
when: z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),         // วันที่ใน Asia/Bangkok
  after: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),  // HH:MM
  before: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
}).strict().nullable().default(null),
quantity: z.number().int().min(1).max(50).nullable().default(null), // คน/ชิ้น ("ไป 3 คน", "เอา 2 ตัว")
slotIds: z.array(z.string().uuid()).max(12).default([]),           // อ้างรอบที่แสดงไปแล้ว ("รอบนั้น")
operation: …เพิ่ม 'NEXT',                                         // รอบเร็วที่สุดหลังตอนนี้
asks: …เพิ่ม 'SCHEDULE',                                          // ถามเวลา/วัน
```

`quantity` ใช้กับ ecom ได้ด้วย ("เสื้อดำ L มี 3 ตัวไหม" → ที่ว่าง ≥ 3) ได้ประโยชน์โดยไม่ต้องเขียนเพิ่ม

**การ resolve วันเวลา (ทำแบบนี้จึงฉลาดและแม่น):**

1. Backend คำนวณ `now` ใน `Asia/Bangkok` (ค่าคงที่ + env `PRODUCT_TIMEZONE` แบบเดียวกับ `ANALYTICS_TIMEZONE` ยังไม่ต้องเพิ่มคอลัมน์ `Company.timezone` จนกว่าจะเป็น SaaS หลายประเทศ)
2. ส่งให้ planner เป็น **ตารางวันที่มี label** แทนการให้ model นับวันเอง:
   ```
   now=2026-11-05T21:10+07:00 (พฤหัสบดี)
   calendar=[{"date":"2026-11-05","label":"วันนี้ พฤหัสบดี"},{"date":"2026-11-06","label":"พรุ่งนี้ ศุกร์"},
             {"date":"2026-11-07","label":"มะรืนนี้ เสาร์"}, … 14 วัน]
   ```
3. **Parser ภาษาไทยแบบ deterministic** (shared util ไม่มี I/O, ไม่ขึ้นกับธุรกิจ) จัดการรูปที่พบบ่อยและใช้ทับค่าของ model เมื่อมันอ่านได้:

   | คำ | ผล |
   |---|---|
   | วันนี้ / พรุ่งนี้ / มะรืน(นี้) | date = today / +1 / +2 |
   | วัน<จันทร์…อาทิตย์>นี้ / หน้า | วันนั้นที่ใกล้ที่สุดที่ยังไม่ผ่าน / +7 |
   | 20 พ.ย. / 20/11 / 20 พฤศจิกายน | date (ถ้าเลยมาแล้วในปีนี้ = ปีหน้า) |
   | เช้า / สาย / บ่าย / เย็น / ค่ำ / ดึก / คืนนี้ | ช่วง after–before ตามค่าคงที่ (เช่น เย็น 16:00–19:00, คืนนี้ = today หลัง 18:00) |
   | 6 โมงเช้า, บ่าย 2, 4 โมงเย็น, 2 ทุ่ม, ตี 1, 20:00, 20.00 น. | HH:MM (ระบบเวลาไทย: n ทุ่ม = 18+n, ตี n = n, บ่าย n = 12+n, n โมงเย็น = 12+n) |
   | "หลัง" / "ก่อน" / "ประมาณ" + เวลา | after / before / ช่วง ±60 นาที |

4. ตรวจผลสุดท้าย: `date ∈ [today, today + horizonDays]` และ `after < before` ถ้าไม่ผ่านให้เก็บไว้แต่ผลค้นจะเป็น `OUT_OF_WINDOW` (ตอบว่ายังไม่เปิดข้อมูลรอบวันนั้น) ไม่ใช่ error
5. parser กับ model ไม่ตรงกัน → ใช้ของ parser และ log `dateSource=PARSER_OVERRIDE` ไว้วัดผล
6. plan ถูกเก็บใน `CommerceTurn.plan` อยู่แล้ว การ replay จึงไม่ตีความวันใหม่ (ปลอดภัยแม้ retry ข้ามเที่ยงคืน)

### 5.8 การค้นรอบ (deterministic)

ต่อจาก `ProductSearchService.read()` เดิม: หา product/variant ให้ได้ก่อน (route + ชั้น) ด้วยกลไกเดิมทั้งหมด แล้วถ้า preset เป็น `SLOT_CAPACITY` และ plan ต้องการรอบ (`when` ≠ null, `asks` มี SCHEDULE/STOCK, `operation=NEXT` หรือ `slotIds` ไม่ว่าง) จึงค้น slot ต่อ:

```sql
-- ใน transaction RepeatableRead เดียวกับ search
SELECT s.* FROM "productSlots" s
WHERE s."companyId" = $c AND s."variantId" = ANY($variantIds)
  AND s."startsAt" >= GREATEST($windowStart, $now)     -- รอบที่ออกไปแล้วไม่แสดงเป็นตัวเลือก
  AND s."startsAt" <  $windowEnd
  AND ($after  IS NULL OR (s."startsAt" AT TIME ZONE 'UTC' AT TIME ZONE $tz)::time >= $after)
  AND ($before IS NULL OR (s."startsAt" AT TIME ZONE 'UTC' AT TIME ZONE $tz)::time <  $before)
  AND s.status <> 'CANCELLED'
ORDER BY s."startsAt", s."variantId"
LIMIT 13;                                              -- 12 + 1 เพื่อรู้ว่าตัด (truncated)
```

- **window:** มี `date` → [00:00 ของวันนั้น, 00:00 วันถัดไป) ตาม tz · `NEXT` ไม่มี date → [now, now + 24 ชม.] · ไม่มีอะไรเลย → [now, today + horizonDays]
- **สถานะของแต่ละรอบ** (คำนวณในโค้ด ไม่ให้ model ตัดสิน):
  ```
  CANCELLED                                     → (ไม่แสดง)
  status=CLOSED หรือ startsAt < now + cutoff     → CLOSED
  capacity = null                               → UNKNOWN
  maxAge ตั้งไว้ และ availabilityAt เก่ากว่า      → UNKNOWN  (ข้อมูลเก่าห้ามอ้าง)
  left = max(0, capacity − reserved)
  left < (quantity ?? 1)                        → FULL     ("เต็มสำหรับ 3 คน" ไม่ใช่ "เต็มทั้งคัน")
  lowThreshold และ left ≤ lowThreshold           → LOW
  อื่นๆ                                          → AVAILABLE
  ```
- **รอบใกล้เคียง (alternatives)** เมื่อรอบที่ลูกค้าระบุ (เวลาเจาะจง) เป็น FULL/CLOSED หรือไม่มีรอบที่พอใน window:
  - anchor = เวลาที่ลูกค้าระบุ หรือต้น window
  - หาจาก variant ของ product เดียวกัน ช่วง [anchor − 12 ชม., anchor + 36 ชม.] ∩ [now + cutoff, horizon] ที่ AVAILABLE/LOW และพอสำหรับ `quantity`
  - เรียงตาม: ชั้นเดียวกับที่ขอก่อน แล้วตาม `|startsAt − anchor|` เอา 3 รอบ
  - ถ้ายังไม่เจอ → รอบแรกที่พอภายใน horizon (ตอบว่า "รอบที่ใกล้ที่สุดที่ยังว่างคือ…")
- **ผลลัพธ์:** `ProductSearchResult` เพิ่ม
  ```ts
  slotOutcome?: 'MATCHED' | 'NONE_FITS' | 'NO_SLOT_IN_WINDOW' | 'OUT_OF_WINDOW';
  query?: { date: string | null; after: string | null; before: string | null; quantity: number | null };
  slotSummary?: { count: number; first: string; last: string };   // สำหรับรอบถี่ เช่น ทุก 30 นาที
  ```
  และ `ProductEvidence` เพิ่ม `slot?: { slotId; startsAt; endsAt; state: AvailabilityState; seatsLeft: number | null; role: 'REQUESTED' | 'ALTERNATIVE' }` evidence 1 แถวต่อ (variant, slot) โดย `ref = SLOT:<slotId>`
- **Index:** `@@unique([variantId, startsAt])` รองรับ query นี้ตรงๆ ไม่ต้องมี index เพิ่ม
- **ไม่ re-embed:** slot ไม่เข้า product document เพิ่ม/แก้รอบไม่ bump `searchRevision`

### 5.9 Token และการ render คำตอบ

Token ใหม่ (format ในโค้ดด้วย `Intl.DateTimeFormat('th-TH', { timeZone })` แบบ 24 ชั่วโมง):

| token | ตัวอย่างค่า | อนุญาตเมื่อ |
|---|---|---|
| `e1.date` | ศุกร์ 6 พ.ย. | asks มี SCHEDULE หรือ operation NEXT/LIST ที่มีรอบ |
| `e1.time` | 20:00 น. | เหมือนบน |
| `e1.arrive` | 06:30 น. (วันถัดไป) | asks SCHEDULE |
| `e1.availability` | มีที่นั่งว่าง / ที่นั่งเต็ม | asks STOCK หรือ `quantity` ≠ null |
| `e1.seatsLeft` | 5 | เหมือนบน และ `showQuantity=true` และ state ≠ UNKNOWN |
| `query.date`, `query.time`, `query.quantity` | ศุกร์ 6 พ.ย., 20:00 น., 3 | ทวนคำถามของลูกค้าได้โดยไม่พิมพ์ตัวเลขเอง |
| `slots.count`, `slots.first`, `slots.last` | 33, 05:00 น., 21:00 น. | รอบถี่ที่ถูกตัด (`truncated`) |

ข้อกำหนดของ renderer ที่เพิ่ม (ของเดิมยังอยู่ทั้งหมด):
- รวม `lexicon.claimWords` เข้า regex ต้องห้ามนอก token แก้ A3 ข้อ 2 (ตัวเลขนอก token ถูกห้ามอยู่แล้ว เวลาจึงต้องมาจาก token แน่นอน)
- asks มี SCHEDULE และมี slot evidence → ต้องใช้ `.time` ของทุกรอบที่ระบุชื่อ
- `slotOutcome = NONE_FITS` → ต้องมี `.availability` ของรอบที่ขอ **และ** อย่างน้อยหนึ่งรอบที่ role = ALTERNATIVE
- ห้าม `e<n>.availability` ที่ state = UNKNOWN ถูกแสดงคู่กับ `seatsLeft`

**ทางลัดแบบไม่ใช้ LLM (แนะนำ ทำใน phase 2):** ถ้าคำถามเป็น lookup ตารางล้วน (operation LIST/NEXT หรือ asks เป็นแค่ SCHEDULE/STOCK/PRICE และ `matchedBy=CUSTOMER_NAMED`) ให้ render ด้วย template ของ preset เลย ไม่เรียก ANSWER ประหยัด 1 call ต่อ turn เร็วกว่า และไม่มีโอกาสแต่ง คำถามที่ต้องเรียบเรียง (เปรียบเทียบ, แนะนำ, หลายประเด็น) ยังใช้ LLM template + validator เหมือนเดิม และ `safeProductAnswer` ต้องรู้จัก slot ด้วย เพราะเป็นตาข่ายสุดท้ายทุกกรณี

**Follow-up:** `CatalogRef` เพิ่ม `slotId?` และ planner ได้ `presentedRefs` ที่มี slotId จึงตอบ "รอบนั้นเต็มยัง", "แล้วรอบถัดไปล่ะ" ได้ ID ที่ planner ส่งมาต้องอยู่ใน refs ที่แสดงแล้ว (ตรวจแบบเดียวกับ `variantIds`) **ต้องแก้ C1 ก่อน** ไม่งั้น refs ว่างจะกลับมาเป็นรอบเก่า

**Snapshot:** คำตอบที่ replay จาก `CommerceTurn` แสดงสถานะ ณ ตอนประมวลผลครั้งแรก ซึ่งถูกต้องสำหรับ retry ของ event เดิม ข้อความใหม่ของลูกค้าเป็น turn ใหม่และอ่านสดเสมอ

### 5.10 แหล่งข้อมูลที่นั่ง และการจองในอนาคต

- **Chatbot ไม่ใช่ระบบจองตั๋ว** ระบบจองจริงของ BKS คือ BKS E-Ticket ข้อมูลที่นั่งในแชตจึงเป็นตัวช่วยตัดสินใจ ห้ามสัญญาว่ากันที่ให้ ทุกคำตอบเรื่องที่นั่งให้บอกเวลาที่ตรวจ และคำตอบจองให้ชี้ไปช่องทางจอง (AnswerPattern `BKS_BOOKING_CHANNELS` ที่มีอยู่)
- **Phase 2:** `capacity = null` ได้ ตอบเวลา + ราคา + "ตรวจสอบที่นั่งล่าสุดได้ที่ BKS E-Ticket" ใช้งานได้ทันที
- **Phase 3a (กรอกเอง):** แอดมินตั้ง `capacity`/`reserved` ผ่าน catalog command (มี `requestId`, `expectedVersion`) และระบบตั้ง `availabilityAt = now` เหมาะกับบริษัททัวร์เล็กที่รับจองทางแชต แต่ตัวเลขเก่าเร็ว `maxAgeMinutes` จึงเป็นตัวกันไม่ให้อ้างตัวเลขเก่า
- **Phase 3b (sync):** job ดึงจาก API ของระบบจอง (นอก DB transaction ตามกฎ "never call an external provider inside a DB transaction") แล้วเขียน `reserved`, `capacity`, `availabilityAt` เป็น batch upsert ตาม `(variantId, startsAt)` **ไม่เรียก API ตอนตอบแชต** เว้นแต่ API เร็วและเสถียรมาก และถึงตอนนั้นก็ต้องมี timeout + fallback เป็น UNKNOWN
- **ถ้าวันหนึ่งจะจองผ่านแชต:** ใช้แบบเดียวกับ [audit-product-22 §4.4](../audit-product-22.md):
  ```sql
  UPDATE "productSlots" SET reserved = reserved + $q, version = version + 1
  WHERE id = $s AND "companyId" = $c AND status = 'OPEN'
    AND capacity IS NOT NULL AND capacity - reserved >= $q
  RETURNING capacity, reserved;          -- 0 แถว = ไม่พอ
  ```
  มีตาราง hold (HELD → COMMITTED/RELEASED, `expiresAt`, `operationKey`) และงานคืน hold ที่หมดเวลาแบบ conditional และต้องแก้ H4 เดิม (movement ที่ไม่มีแอดมิน) ก่อน **อยู่นอกขอบเขตเอกสารนี้**

### 5.11 การจัดการข้อมูล (admin)

| endpoint (ข้อเสนอ) | ทำอะไร | หมายเหตุ |
|---|---|---|
| `POST /admin/products/:id/variants/:vid/slots/bulk` | upsert รายการรอบ `[{startsAt, endsAt, capacity, meta}]` | ผ่าน `ProductCatalogCommand` (idempotent ด้วย `requestId`), `ON CONFLICT (variantId, startsAt)` |
| `POST …/slots/generate` | รับรูปแบบรายสัปดาห์ `{days:[1..7], times:["07:30","20:00"], from, to, durationMin, capacity}` แล้วขยายเป็นแถว | ไม่เก็บกฎ เก็บแค่ผลที่ขยาย, จำกัด 1,000 แถวต่อคำสั่ง |
| `PATCH …/slots/:sid` | ปิด/ยกเลิก/แก้ capacity/reserved | ต้องมี `expectedVersion`, ตั้ง `availabilityAt` |
| `GET …/slots?from&to` | หน้า admin ดูรอบ | |

- ทุก endpoint ผ่าน `CommerceScopeService.forAdmin` + role guard ตาม controller เดิม
- รอบที่ผ่านไปแล้วไม่ต้องลบ (query กรอง `startsAt >= now`) ถ้าต้องการเก็บกวาดให้ทำ job รายเดือนภายหลัง
- import BKS ครั้งแรก: แปลง `mock-timetable-*.json` เป็น product (6 เส้นทาง) × variant (VIP/ชั้น 1, ราคา) × slot (generate 30 วัน) แล้วปิด MicroKnowledge/AnswerPattern หมวด `MOCK_TIMETABLE` (A4)

---

## 6. ตัวอย่าง flow ใหม่ทีละ event (BKS)

สมมติ `now` = พฤหัสบดี 5 พ.ย. 2026 15:10 น.

**S1 "รถไปเชียงใหม่พรุ่งนี้มีรอบไหนบ้าง"**
1. signals (`รถ`, `รอบ`) → PLAN
2. parser: พรุ่งนี้ → `2026-11-06` · planner: `filters=[destination EQ เชียงใหม่]`, `asks=[SCHEDULE]`, `operation=LIST`
3. ต้นทางไม่ระบุ แต่มีเส้นทางไปเชียงใหม่เพียง 1 เส้น (จากหมอชิต) จึงใช้เส้นนั้น (ถ้ามีหลายต้นทาง → MISSING_INPUT พร้อมตัวเลือก "จากกรุงเทพฯ / จากขอนแก่น")
4. slot: 4 รอบ × 2 ชั้น · capacity = null → state UNKNOWN
5. คำตอบ (template ไม่ใช้ LLM):
   ```
   รอบรถ กรุงเทพฯ (หมอชิต 2) → เชียงใหม่ ศุกร์ 6 พ.ย.
   • 07:30 น. ชั้น 1 590.00 บาท
   • 09:00 น. VIP 890.00 บาท
   • 20:00 น. VIP 890.00 บาท
   • 21:30 น. ชั้น 1 590.00 บาท
   ยังตรวจสอบที่นั่งไม่ได้ ดูที่นั่งล่าสุดได้ที่ BKS E-Ticket ค่ะ
   ```

**S2 "VIP สองทุ่มวันศุกร์นี้ ไป 3 คน เต็มยัง"** (phase 3 มีข้อมูลที่นั่งแล้ว)
- parser: ศุกร์นี้ → 06-11, สองทุ่ม → after 19:30 / before 20:30 (±30 นาทีเมื่อระบุเวลาเจาะจง) · option `bus_class=VIP` · `quantity=3` · asks STOCK
- รอบ 20:00 VIP: capacity 24, reserved 22 → left 2 < 3 → FULL
- alternatives: 09:00 VIP (left 11), 21:30 ชั้น 1 (left 8) → `slotOutcome = NONE_FITS`
- คำตอบ: "VIP รอบ {{e1.time}} {{e1.date}} {{e1.availability}} สำหรับ {{query.quantity}} ท่านค่ะ รอบใกล้เคียงที่ยังว่าง: {{e2.time}} VIP ({{e2.availability}}), {{e3.time}} ชั้น 1 ({{e3.availability}})"

**S3 "รอบถัดไปไปโคราชกี่โมง"** · `operation=NEXT`, destination นครราชสีมา (alias โคราช) · window [15:10, +24 ชม.] · รอบแรก ≥ now + cutoff(30) = 15:30 → "{{e1.time}}" (รอบ 15:00 ไม่แสดงเพราะออกไปแล้ว)

**S4 "ตั๋วไปขอนแก่นราคาเท่าไหร่"** · ไม่มี when/SCHEDULE → ไม่ค้น slot · ตอบ priceRange ของ variant ด้วย path เดิมทั้งหมด

**S5 (ต่อจาก S1) "รอบ 2 ทุ่มใช้เวลากี่ชั่วโมง"** · presentedRefs มี slotIds ของ S1 · planner เลือก slot 20:00 · asks ATTRIBUTES → `attr.duration_min` + `e1.arrive`

**S6 "จองให้หน่อย 2 ที่"** · planner mode KNOWLEDGE (การจอง = นโยบาย/ช่องทาง) → DIRECT pattern `BKS_BOOKING_CHANNELS` · ไม่มีการกันที่นั่ง

**S7 "พรุ่งนี้มีรถไหม"** · signals → PLAN (planner 1 call) · ไม่มีต้นทาง/ปลายทาง → search คืน `MISSING_INPUT` → `safeProductAnswer` ใช้ `lexicon.clarify.none` "ต้องการเดินทางจากที่ไหนไปที่ไหนคะ" (ไม่เรียก ANSWER) และเก็บ `when.date` ไว้ใน history เพื่อให้ turn ถัดไป "ไปขอนแก่น" ได้วันที่เดิม

**S8 "รถไปเชียงใหม่วันที่ 20 ธันวา"** · date 2026-12-20 > today + 30 → `OUT_OF_WINDOW` → "ยังไม่มีข้อมูลรอบวันที่ {{query.date}} ค่ะ เปิดให้ตรวจสอบล่วงหน้า 30 วัน"

**S9 "รถเสียกลางทางทำยังไง"** · หลังแก้ M6 (เทียบเป็นคำ) `สี` ไม่ match `เสีย` อีกต่อไป · ไม่มีสัญญาณ catalog → legacy knowledge/handoff ตามปกติ

**S10 (ecom regression) "เสื้อลินินสีดำไซส์ L ราคาเท่าไหร่"** · preset ECOMMERCE, `inventory=VARIANT_STOCK` → ไม่มี slot · ผลต้องเหมือนวันนี้ทุกตัวอักษร

---

## 7. รายการงาน

### Phase 0 — แก้ของค้าง (ทำก่อน ไม่ขึ้นกับ BKS)
| งาน | ไฟล์ | ขนาด |
|---|---|---|
| C1 refs ว่างใน Redis | `context/load-context.service.ts` + เทสต์ redis | S |
| P1 policy อ่อน | `product-retrieval.service.ts`, `product-answer.service.ts` | S |
| M8 filter หาย | `product-retrieval.service.ts` | S |
| H3 LIMIT 60 | `product-search.service.ts` | S–M |
| M1 categories | `catalog-fields.ts` | S |
| C02 fixture + ลบ `custom/prasya.*` + เทสต์วนทุก preset | `product-answer.policy.spec.ts`, presets | S |
| แก้ `test:commerce`/`test:product-audit` ให้ชี้ไฟล์ที่มีอยู่จริงหรือลบออก | `package.json` | S |

### Phase 1 — preset เป็นตัวกำหนด (ไม่เปลี่ยนพฤติกรรม ecom)
- `BusinessCapabilities`, `BusinessLexicon` + `ECOMMERCE_*` defaults ที่ตรงกับค่าปัจจุบัน
- `catalog-fields.ts`: ส่ง capabilities/lexicon ออกไปด้วย
- `product-retrieval.service.ts`: สัญญาณจาก lexicon + เทียบเป็นคำ (A1, M6)
- `product-answer.policy.ts`: labels, หน่วย, ข้อความถามกลับ, claimWords (A3)
- `product-terms.ts`: รวม `lexicon.questionWords` (L-a)
- **เกณฑ์ผ่าน:** เทสต์ product เดิมทั้งหมด + golden set ecom ให้ผลเหมือนเดิม

### Phase 2 — TRANSPORT + รอบ (ตอบตาราง ราคา รอบถัดไป)
- migration `add_product_slots` (enum + table + CHECK)
- `presets/transport.preset.ts`, `prompts/transport.prompt.ts`, ลงทะเบียน
- `shared/date/thai-date.ts` (parser + calendar) + inject `now`/calendar ใน planner prompt
- `productPlanSchema`: `when`, `quantity`, `slotIds`, `NEXT`, `SCHEDULE` + ตรวจในตัววางแผน
- `ProductSearchService`: ขั้นค้น slot + สถานะ + alternatives + summary
- `product-answer.policy.ts`: token ใหม่, กฎ renderer, `safeProductAnswer` ที่รู้จัก slot, template ไม่ใช้ LLM
- `CatalogRef.slotId`
- admin: bulk / generate / patch / list slots
- import ข้อมูล BKS + ปิด MicroKnowledge `MOCK_TIMETABLE` (A4)

### Phase 3 — ที่นั่งจริง
- 3a: endpoint ตั้ง capacity/reserved + `availabilityAt` + guard อายุข้อมูล
- 3b: sync job จากระบบจอง (ต้องได้ API/feed จาก BKS ก่อน)

### ตั้งใจไม่ทำ (กัน over-engineer)
- seat map / เลือกที่นั่ง, จอง/ชำระเงินผ่านแชต, ค่าโดยสารต่อช่วงทาง, ราคาต่อรอบ (จนกว่าจะมีลูกค้าทัวร์), ตารางกฎปฏิทิน, ตาราง definition ที่ tenant แก้เองได้, RLS, text-to-SQL
- **ไม่ให้แชตบอต search internet ตอนตอบลูกค้า** เรื่องรอบ/ราคา/ที่นั่ง ข้อมูลเว็บทั่วไปเก่าได้ ตรวจไม่ได้ และเปิดช่อง prompt injection ข้อเท็จจริงของธุรกิจต้องมาจาก DB หรือ API ของเจ้าของเท่านั้น

---

## 8. แผนทดสอบ

ตาม [.claude/rules/rag-ai.md](../../.claude/rules/rag-ai.md): เปลี่ยน prompt/scoring/query ต้องมี retrieval test ด้วยคำถามไทยจริง ทุกเทสต์ mock AI/LINE

**Unit (ไม่มี I/O)**
- `thai-date`: วันนี้/พรุ่งนี้/มะรืน, วัน<x>นี้/หน้า (รวมกรณีวันนี้เป็นวันนั้นเอง), 20 พ.ย. ที่เลยไปแล้ว → ปีหน้า, n ทุ่ม/ตี n/บ่าย n/n โมงเย็น, "หลัง 6 โมง", ข้ามเที่ยงคืน, เลขไทย ๒๐:๐๐
- availability state: capacity null, ข้อมูลเก่า, quantity > left, LOW, CLOSED จาก cutoff, overbook (reserved > capacity)
- alternatives: ชั้นเดียวกันก่อน, ระยะเวลาใกล้สุด, ไม่เสนอรอบที่ออกไปแล้ว, ไม่มีรอบเลย → รอบแรกใน horizon
- renderer: ปฏิเสธ "ยังว่างค่ะ"/"เต็มแล้ว" นอก token, ปฏิเสธเวลาที่พิมพ์เอง, NONE_FITS ต้องมี alternative

**Search กับ DB ทดสอบ** (แยกจาก dev, ห้ามชี้ production)
- seed 6 เส้นทาง × 2 ชั้น × 30 วัน + เส้นทางขากลับ ตรวจทิศทาง, filter alias (โคราช), stops CONTAINS, window, LIMIT/truncated, รอบถี่ทุก 30 นาที → summary

**Golden set BKS** (ตรวจ route → plan → status → token ที่ใช้)

| # | ข้อความ | คาดหวัง |
|---|---|---|
| 1 | รถไปเชียงใหม่ออกกี่โมง | PLAN, destination=เชียงใหม่, SCHEDULE |
| 2 | พรุ่งนี้มีรถไปขอนแก่นไหม | date=+1, LIST |
| 3 | รอบถัดไปไปโคราช | NEXT, alias โคราช |
| 4 | VIP 2 ทุ่มศุกร์นี้ 3 คน เต็มยัง | option VIP, after/before, quantity=3, STOCK |
| 5 | ตั๋วไปหาดใหญ่เท่าไหร่ | PRICE, ไม่ค้น slot |
| 6 | รถไปเชียงใหม่ผ่านลำปางไหม | stops CONTAINS ลำปาง |
| 7 | จากเชียงใหม่กลับกรุงเทพมีรอบเย็นไหม | origin/destination กลับทิศ, ช่วงเย็น |
| 8 | พรุ่งนี้มีรถไหม | MISSING_INPUT (ไม่มีปลายทาง) |
| 9 | วันที่ 20 ธันวามีรถไปอุดรไหม | OUT_OF_WINDOW |
| 10 | รอบนั้นถึงกี่โมง (follow-up) | slotIds จาก refs, `arrive` |
| 11 | จองให้หน่อย | KNOWLEDGE → ช่องทางจอง |
| 12 | คืนตั๋วได้ไหม | KNOWLEDGE (policySignals) |
| 13 | รถเสียกลางทาง | ไม่เข้า PLAN |
| 14 | BKS คืออะไร | DIRECT pattern เดิม |
| 15 | มีรถไปไหนบ้าง | LIST products (เส้นทาง) |
| 16 | VIP กับชั้น 1 ต่างกันยังไง | COMPARE, amenities |
| 17 | ตอนนี้ยังทันรอบ 15:00 ไหม (now 15:10) | CLOSED/ออกแล้ว + รอบถัดไป |
| 18 | ไปเชียงใหม่ 12 คน | quantity > maxQuantity → แจ้งให้ติดต่อเจ้าหน้าที่ |

**Regression ecom:** golden set ecom ที่มีอยู่ (`test/audit-core-logic-opus/product-flow.spec.ts` และ `product-answer.policy.spec.ts`) ต้องผ่านเหมือนเดิมหลัง phase 1 และ 2

**ตัวชี้วัดหลังเปิดใช้** (จาก log ที่มีอยู่แล้ว: `[Routing]`, `productStatus`, `productMode`)
- สัดส่วน `MISSING_INPUT` ต่อ turn (สูงแปลว่าถามกลับมากเกินไป)
- สัดส่วนที่ renderer ปฏิเสธจนต้องใช้ `safeProductAnswer`
- `dateSource=PARSER_OVERRIDE` (model กับ parser ไม่ตรงกันบ่อยแค่ไหน)
- fallback/handoff ต่อ turn ของ product

---

## 9. Config, deploy และความเสี่ยง

- **Env:** `PRODUCT_ENABLED=true`, `PRODUCT_RAG_ENABLED=true`, `PRODUCT_SEMANTIC_ENABLED` (ตามต้องการ), `PRODUCT_TIMEZONE=Asia/Bangkok` (ใหม่, มีค่า default)
- **Migration additive** (enum + ตารางใหม่) แต่ **push ไป `main` จะ auto-deploy และรัน `prisma migrate deploy` บน production ทันที** ต้อง review SQL ก่อน merge
- **การเปลี่ยน BKS เป็น TRANSPORT:** apply preset ผ่าน endpoint เดิม (bump `searchRevision` → re-embed) แล้ว import route/slot แล้วจึงปิด MicroKnowledge timetable ลำดับนี้กันช่วงที่ไม่มีแหล่งข้อมูลไหนตอบได้
- **Go-live check:** `select "productBusinessType" from company` ต้องเป็น `TRANSPORT`, ไม่มี MicroKnowledge/AnswerPattern หมวด `MOCK_TIMETABLE` ที่ active, `count(*)` ของ slot ใน 7 วันข้างหน้า > 0
- **Rollback:** เปลี่ยน preset กลับ (หรือปิด `PRODUCT_RAG_ENABLED`) แล้วเปิด MicroKnowledge timetable กลับ ตาราง slot ค้างไว้ได้โดยไม่มีผล
- **ความเสี่ยงที่เหลือ:** ข้อมูลรอบที่ import ไม่ตรงกับระบบจองจริง (เป็นเรื่องกระบวนการ ไม่ใช่โค้ด ให้เริ่มด้วย `capacity = null` และข้อความ "ตรวจสอบล่าสุดที่ E-Ticket"), timezone ผิดหาก server ไม่ได้ตั้ง (ใช้ `Intl` + tz ชัดเจนทุกจุด ห้ามพึ่ง `TZ` ของเครื่อง)

---

## 10. สิ่งที่เจ้าของต้องตัดสินใจ

1. **แสดงจำนวนที่นั่งจริง** ("ว่าง 5 ที่") หรือ**แค่สถานะ** ("ว่าง/ใกล้เต็ม/เต็ม") (`showQuantity`)
2. **แหล่งข้อมูลที่นั่งของ BKS:** มี API/feed จาก E-Ticket ไหม ถ้าไม่มี ให้หยุดที่ phase 2 (ตอบตาราง + ราคา + ลิงก์จอง) ซึ่งตรงไปตรงมาที่สุด
3. **ช่วงเวลาที่เปิดให้ถาม** (`horizonDays`) และ **cutoff ก่อนรถออก** (`cutoffMinutes`)
4. **อายุข้อมูลที่ยอมรับ** (`maxAgeMinutes`) ก่อนเปลี่ยนเป็น "ตรวจสอบไม่ได้"
5. **ช่อง APP** ต้องตอบรอบรถด้วยไหม (A5 เป็นงานแยก)
6. **ชื่อ preset:** `TRANSPORT` ทั่วไป (แนะนำ ใช้กับบริษัทขนส่งไทยรายอื่นได้) หรือ `BKS` เฉพาะ

---

## แหล่งอ้างอิงภายนอก

- [GTFS Schedule: base features (routes, trips, stop_times, calendar)](https://gtfs.org/getting_started/features/base)
- [Trafiklab: static GTFS files](https://www.trafiklab.se/docs/using-trafiklab-data/using-gtfs-files/static-gtfs-files/)
- [Elastic: self-querying retrievers](https://www.elastic.co/search-labs/blog/self-querying-retrievers)
- [Vapi: accurate date and time](https://support.vapi.ai/t/33069119/accurate-date-and-time)
- [How to get LLMs to accurately infer relative days of the week](https://neura.market/answers/llm-accurate-relative-days-of-week)
- [CNOE: date handling guide](https://cnoe-io.github.io/ai-platform-engineering/changes/2025-10-27-date-handling-guide)
- [FareHarbor API (third-party summary)](https://supergood.ai/docs/fareharbor-api)
- [AlgoMaster: design a ticket booking system (concurrency)](https://algomaster.io/learn/concurrency-interview/design-ticket-booking-system)
- [AWS Builder: selling 100,000 tickets without overselling](https://builder.aws.com/content/3I7bWCnBud9DJilFAUsP5YS14CL/the-fair-seat-purchase-selling-100000-tickets-without-overselling-a-single-one)
- [System design: auto-expiring ticket reservations](https://prachub.com/questions/736)

แหล่งเรื่อง tour/booking (FareHarbor/Rezdy) เป็นบทสรุปจากแหล่งรอง ไม่ใช่เอกสาร API ทางการ ใช้ยืนยันได้แค่ pattern ทั่วไป (product → dated session + capacity) ไม่ใช่รายละเอียด schema
