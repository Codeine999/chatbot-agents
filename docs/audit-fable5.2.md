# Audit ระบบ AI RAG ตอบแชตลูกค้า + แผนพัฒนา (audit-fable5.2)

วันที่ 11 พ.ย. 2026 · branch `decisionLog` (HEAD `8609155`) + working tree ที่ยังไม่ commit 59 ไฟล์ (channel gateway, retrieval, decision log) · ผู้ตรวจ: Claude Fable 5.2

เลขบรรทัดในเอกสารนี้อ้างจาก working tree ณ วันที่ตรวจ ไม่ใช่ `main` (`17a1af8`)

## Context

เจ้าของต้องการ audit ระบบ end-to-end (core routing/RAG, product, รูปภาพ, channel gateway, billing, รากฐาน SaaS) ว่าเป็น best practice หรือยัง และต้องการแผนพัฒนาที่ lean ไม่ over-engineer เป้าหมายคือ AI ตอบตรงประเด็น ไม่ fallback มั่ว และ product pipeline ใช้ซ้ำข้ามธุรกิจได้ (ร้านค้า, รอบรถ บขส, ต่อไปเป็น SaaS)

**สถานะเอกสาร: ผล audit + แผน ยังไม่ได้ implement** (ระดับเดียวกับ `docs/feature/*`) รอบนี้ไม่มีการแก้ code path ของไฟล์ในเอกสารนี้นับจาก `src/modules/` เว้นแต่ระบุเป็นอย่างอื่น

### การตัดสินใจของเจ้าของที่ใช้ในแผนนี้

| เรื่อง | ที่เลือก |
|---|---|
| ลำดับความสำคัญ | Core RAG ตอบตรง ก่อน แล้ว Product ข้ามธุรกิจ + รอบรถ |
| คำถามต่อเนื่อง / หลายคำถาม | ใช้ LLM เฉพาะเมื่อจำเป็น (เส้นทางมั่นใจสูงไม่เพิ่มต้นทุน) |
| ตอบได้บางส่วน | ตอบส่วนที่มีหลักฐาน + แจ้ง admin + เก็บ context ไว้ |
| Custom field ของ product | เจ้าของถามว่าควรทำท่าไหน คำตอบอยู่หัวข้อ 3.1 |

### วิธีตรวจ และข้อจำกัด

- **อ่าน code เต็มไฟล์:** `chatbot/*` (router, retrieval, answer, product, prompt), `products/search/*`, `products/attributes/*`, `commerce/*`, `channels/*` (gateway core), `events/message/*`, `usage/*` (credit, billing, rate limit), `ai-provider/providers/openrouter*`, prisma ทุก model ยกเว้น registration/payment
- **อ่านเอกสารเดิม:** `ai-chatbot-architecture.md`, `channel-gateway-current.md`, `report-11-8.md`, `investigation-credit-wallet-contention.md`, `future/product-bks.md`
- **Query DB local (อ่านอย่างเดียว):** จำนวน knowledge, product, decisionLogs, wallet, reservation, AiSetting
- **ไม่ได้ทำ:** รันเทสต์, tsc, lint, build, load test, เรียก AI (ใช้ 0 จาก 50 ครั้ง) เพราะอยู่ใน plan mode
- **ไม่มีข้อมูลจริงให้วัด:** `decisionLogs` ใน DB local มี 1 แถว ทุกข้อที่เขียนว่า "ความเสี่ยง" คือสรุปจากการอ่าน code ยังไม่ได้วัดความถี่จริง

---

## 1. สรุปผู้บริหาร

| ส่วน | คำตัดสิน |
|---|---|
| ท่า core (cache → DB → embedding → classifier) | **ถูกทางและประหยัด** เป็น retrieval-first + LLM router เฉพาะตอนไม่มั่นใจ แต่มี 5 จุดที่ทำให้ "มีความรู้แต่ fallback" และ "general หลุดไป handoff" (หัวข้อ 2) |
| คำถามต่อเนื่อง / หลายคำถาม | **ยังอ่อน** ใช้ regex และ embedding เดียวต่อข้อความ คำตอบเป็นแบบได้ทั้งหมดหรือไม่ได้เลย |
| รูปภาพ | **ยังไม่มี RAG** รูปที่เกี่ยวกับธุรกิจถูก block แล้ว handoff ทุกครั้ง |
| Product pipeline | **หลักการดี** (LLM วางแผน, code กรอง, ราคา/สต็อกจาก DB ผ่าน token) แต่ผูกคำศัพท์ ecom, ไม่มีแนวคิดวันเวลา/รอบ, ใช้ได้เฉพาะ LINE |
| Channel gateway | **เป็น gateway แล้ว**สำหรับช่องใหม่ (connector + ตาราง `channel*`) แต่ LINE ยังเป็นอีก stack และรับส่งได้แค่ข้อความ |
| Billing | **ตัดเงินถูกต้องแม้ concurrent สูง** ไม่ตัดซ้ำ ไม่ติดลบ จุดอ่อนคือยอดจองค้างและ turn ค้างเมื่อ settle ล้ม ไม่ใช่ตัวเลขผิด |
| รากฐาน SaaS | **ยังไม่พร้อม** key ของ tenant ไม่ตรงกัน 3 แบบ (`tenantId` จาก env, `companyId`, ไม่มีเลย) แก้แบบ additive ได้โดยไม่รื้อ |

---

## 2. Core pipeline

### 2.1 ท่าที่ใช้อยู่ เป็น best practice ไหม

Flow จริง: rule gate → exact match (in-memory cache แล้ว DB) → BM25 (AnswerPattern + MicroKnowledge) + vector 1 embedding → RRF → เลือก context ≤ 3 → ถ้า exact หรือ vector ≥ 0.75 เข้า grounded answer เลย ไม่เช่นนั้น classifier BUSINESS/GENERAL

สิ่งที่ทำถูกแล้ว (ไม่ต้องแตะ):

- Hybrid BM25 + vector รวมด้วย RRF, ความมั่นใจคิดจาก cosine ของหลักฐานที่ส่งจริง
- Grounded answer ต้องอ้าง evidence ID และมี sentinel `INSUFFICIENT_CONTEXT`
- DIRECT preset ไม่เรียก model, ทุก call มี idempotency ต่อ turn, PII ถูก redact ก่อนเข้า model
- มี `decisionLogs` เก็บทุกขั้นของการตัดสินใจ (ใช้วัดผลได้ทันทีเมื่อมี traffic จริง)

สิ่งที่ขาดเทียบกับแนวปฏิบัติของ RAG งาน support: query rewrite ตามบริบท, การแยกคำถามย่อย, คำตอบบางส่วน, การจัดการ output ที่ถูกตัด, ชุดวัดผลจาก log จริง ส่วน reranker **ยังไม่แนะนำ** เพราะต้องเพิ่ม dependency และ context มีแค่ 3 ถึง 5 ชิ้นที่ model กรองเองได้

หมายเหตุ: "cache" ของ AnswerPattern เป็น **memory ใน process** (`answer-pattern-cache.service.ts`, TTL 240 วินาที) ไม่ใช่ Redis ถ้ารันหลาย instance แต่ละตัวจะเห็นข้อมูลเก่าได้นานสุด 4 นาทีหลัง admin แก้

### 2.2 ต้นเหตุ "มี knowledge คะแนนสูง แต่ fallback"

| # | ระดับ | ปัญหา | หลักฐาน | แนวแก้ |
|---|---|---|---|---|
| C1 | สูง | **JSON ถูกตัดเพราะ token ไม่พอ** grounded answer ใช้ `AI_MAX_OUTPUT_TOKENS` (default 500, dev ตั้ง 800) พร้อม reasoning `medium` บน OpenRouter ซึ่ง `max_tokens` นับรวม reasoning ไม่มีที่ไหนตรวจ `finish_reason` JSON ที่ขาดจึงกลายเป็น `INVALID_GROUNDED_OUTPUT` แล้ว handoff | `answer/answer.service.ts:364-385`, `ai-provider/providers/openrouter-ai.provider.ts:115`, `intent/ai-intent-classifier.service.ts:62-64` | adapter คืน `finishReason`; call ที่ต้องการ JSON ใช้เพดานแยก (เช่น 2000); ถ้าถูกตัดให้ลองใหม่ 1 ครั้งด้วย reasoning `low` ห้ามนับเป็น "หลักฐานไม่พอ" |
| C2 | สูง | **อ้าง ID ผิด 1 ตัว ทิ้งทั้งคำตอบ** ใช้ `every` | `answer.service.ts:399-403` | ตัด ID ที่ไม่รู้จักออก ถ้ายังเหลือ ID ถูกอย่างน้อย 1 ตัวให้รับคำตอบ |
| C3 | สูง | **classifier ล้ม = handoff แม้มีหลักฐาน** เงื่อนไข `!analysis.failed` | `intent/intent-router.service.ts:186` | ถ้ามี `selectedItems` ให้ไป grounded answer ต่อ (มี sentinel ของตัวเองอยู่แล้ว) |
| C4 | สูง | **AI rate limit กลายเป็น handoff** limit กลาง (default 30 ครั้ง/วินาที แบบ fixed window) และ limit ต่อผู้ใช้ (60 ครั้ง/ชม. โดย 1 ข้อความกิน 2 ถึง 4 ครั้ง) พอเต็มจะตอบ fallback + เรียก admin ส่วน embedding ที่ถูก limit จะกลายเป็น `RETRIEVAL_ERROR` แล้ว handoff เช่นกัน | `answer.service.ts:296,355`, `ai-intent-classifier.service.ts:49`, `ai/embeding/embedding.service.ts:82`, `usage/rate-limit/ai-budget.service.ts` | limit กลางเต็ม ให้โยน error แบบ retry ได้ (คิว backoff) ไม่ใช่ fallback; limit ต่อผู้ใช้นับเป็นต่อข้อความ ไม่ใช่ต่อ call |
| C5 | กลาง | **ทุก fallback ล้าง context** ข้อความถัดไปของลูกค้าจึงขาดบริบท | `chatbot.service.ts:409,430` | ใช้ `EXCLUDE` (ไม่เก็บข้อความ fallback แต่ไม่ลบประวัติ) |

### 2.3 ต้นเหตุ "general question ไปเข้า needKnowledge"

| # | ระดับ | ปัญหา | หลักฐาน | แนวแก้ |
|---|---|---|---|---|
| C6 | สูง | **เส้นทาง RAG ไม่มีทางออกไป general** ถ้าข้อความทั่วไปบังเอิญได้ vector ≥ 0.75 หรือ exact จะเข้า grounded แล้ว model ตอบ `INSUFFICIENT_CONTEXT` ระบบ handoff ทันทีโดยไม่ถาม classifier | `intent/utils/route-stages.ts:158-168`, `answer.service.ts:399-432` | เพิ่มค่าที่สามใน schema ของ grounded: `NOT_BUSINESS` แล้วส่งต่อ `answerGeneral` (เพิ่ม 1 call เฉพาะเคสนี้) |
| C7 | กลาง | เมื่อเปิด product, regex `productSignal` มีคำกว้าง (`แนะนำ`, `อยากได้`, `สี`, `ขนาด`, `ซื้อ`) ทุกข้อความที่มีคำเหล่านี้จ่ายค่า planner | `knowledge/product/product-retrieval.service.ts:51-52` | ย้ายสัญญาณไปที่ preset ของธุรกิจ (หัวข้อ 3) |

### 2.4 คำถามต่อเนื่อง

ตอนนี้ `resolveRetrievalQuery` จับได้เฉพาะคำชี้เฉพาะ (`อันนี้`, `ตัวนั้น`, `เมื่อกี้`) ข้อความอย่าง "แล้วราคาล่ะ", "มีสีอื่นไหม", "เท่าไหร่" ถูกค้นด้วยคำเปล่า ๆ ประวัติถูกส่งให้ model ตอนตอบ แต่หลักฐานที่ค้นมาเป็นของคำถามผิดตัว (`knowledge/retrieval-query-planner.service.ts:8-9,54`)

**แนวแก้ (C8, ตามที่เจ้าของเลือก):** ขยาย classifier เดิมให้เป็น "ขั้นเข้าใจคำถาม" ใน call เดียว

```
ผลลัพธ์เดิม:  { classification, confidence, reason }
ผลลัพธ์ใหม่:  { classification, confidence, reason,
               standaloneQuery,      // คำถามที่เติมบริบทจากประวัติแล้ว
               questions[] }         // คำถามย่อย สูงสุด 3
```

- เส้นทางมั่นใจสูง (exact, vector ≥ 0.75) เหมือนเดิม ไม่มี call เพิ่ม
- low confidence + BUSINESS + `standaloneQuery` ต่างจากข้อความเดิม: ค้นใหม่ 1 รอบด้วย query นั้น (เพิ่ม 1 embedding) แล้วเข้า grounded
- regex เดิมคงไว้เป็นทางลัดที่ไม่เสียเงิน
- ไฟล์: `shared/prompt/low-confidence-classifier.prompt.ts`, `ai-intent-classifier.service.ts`, `intent-router.service.ts` (`resolveLowConfidence`), `knowledge-retrieval.service.ts` (รับ query ที่ rewrite แล้ว ผ่าน `retrieve` ตัวเดิม)

### 2.5 หลายคำถามในประโยคเดียว

| # | ปัญหา | แนวแก้ |
|---|---|---|
| C9 | embedding เดียวทั้งข้อความ ความคล้ายของแต่ละเรื่องเจือจาง มักต่ำกว่า 0.75 แล้วตกไป classifier; context สูงสุด 3 ชิ้น (`shared/knowledge-routing.constants.ts:4`) | ใช้ `questions[]` จาก C8: ค้นทีละคำถามย่อย (สูงสุด 3) รวมด้วย RRF ตัวเดิม และเพิ่มเพดาน context เป็น 5 เฉพาะเมื่อมีมากกว่า 1 คำถาม |
| C10 | คำตอบเป็นแบบได้หมดหรือไม่ได้เลย `directlyAnswered` ต้องจริงทั้งข้อความ | เพิ่ม `unanswered: string[]` ใน schema; ถ้า `ANSWER` และ `unanswered` ไม่ว่าง ให้ส่งคำตอบส่วนที่รู้ + ประโยคว่าส่วนที่เหลือเจ้าหน้าที่จะตรวจให้ + `requestAdmin` + context `INCLUDE` ไฟล์: `answer/grounded/grounded-response.schema.ts`, `answer.service.ts`, `chatbot.service.ts` (`aiResponse`), `AiAnswerResult` เพิ่ม `handoff?: boolean` |

กฎ "ไม่มีหลักฐาน ห้ามแต่งคำตอบธุรกิจ" ยังอยู่ครบ เพราะส่วนที่ตอบยังต้องอ้าง evidence ID

### 2.6 ประสิทธิภาพและของเล็ก

| # | ระดับ | ปัญหา | แนวแก้ |
|---|---|---|---|
| C11 | กลาง | ทุกข้อความอ่าน AnswerPattern 500 แถวจาก DB ซ้ำหลังผ่าน cache แล้ว + MicroKnowledge 500 แถว และตัดคำไทยใหม่ทุกแถวทุกครั้ง (`answer-pattern.service.ts:55`, `micro-knowledge.service.ts:21`, `utils/thai-bm25.ts:97`) รายงานเดิมวัดได้ ~37 ms ต่อ query ที่ 480 แถว เป็นงาน CPU ที่บล็อก event loop | ทำ index ใน memory ชุดเดียวสำหรับทั้งสองตาราง ตัดคำครั้งเดียวตอน refresh; อ่าน DB เฉพาะเมื่อ cache หมดอายุ; แจ้ง invalidate ข้าม instance ผ่าน Redis pub/sub ที่มีอยู่ |
| C12 | กลาง | เพดาน 500 แถวตัดความรู้ส่วนเกินทิ้งเงียบ ๆ และปิด DIRECT เมื่อครบ 500 | log เตือนเมื่อถึงเพดาน; ยกเพดานได้หลัง C11 |
| C13 | ต่ำ | `chatbot.service.ts:79` log `user session [object Object]` ระดับ warn ทุกข้อความ | ลบ |
| C14 | ต่ำ | `isUsableKnowledge` ถูก comment ออกใน `eligible()` (`knowledge-retrieval.service.ts:322`) หลักฐาน SNAPSHOT จาก vector จึงกินช่อง context ก่อนถูกกรองทีหลัง | เปิดกลับ |
| C15 | ต่ำ | เอกสาร drift: architecture บอกว่า structured output มีเฉพาะ Gemini แต่ OpenRouter adapter ส่ง `json_schema` แล้ว; บอกว่า cache เป็นชั้นแยกแต่เป็น memory ใน process | แก้เอกสารพร้อม phase 1 |

---

## 3. Product pipeline

### 3.1 คำตอบเรื่อง meta: ท่าที่ถูกคือ 3 ชั้น

การเก็บค่าใน `productVariants.meta` (JSON) **ถูกแล้วสำหรับคุณสมบัติที่ค่อนข้างคงที่** สิ่งที่ยังขาดคือ "คำนิยามของ field" ที่บอกระบบว่า key ไหนค้นได้ แสดงให้ AI ได้ เป็นตัวเลือกของ variant หรือไม่

| ชั้น | เก็บอะไร | เก็บที่ไหน | สถานะ |
|---|---|---|---|
| 1. ค่าคงที่ของสินค้า | แบรนด์ วัสดุ ต้นทาง ปลายทาง ชั้นรถ สถานีขึ้นรถ สิ่งอำนวยความสะดวก | `meta` JSON | มีแล้ว |
| 2. ค่าที่เปลี่ยนเร็วหรือเป็นธุรกรรม | ราคา, สต็อก, เวลารอบ, ที่นั่ง | คอลัมน์จริง: `price`, `inventoryBalances`, ตารางรอบ (ใหม่) | ราคา/สต็อกมีแล้ว รอบยังไม่มี |
| 3. คำนิยาม field | key, label, type, ค้นได้ไหม, AI เห็นไหม, เป็น option ไหม | preset ใน code เป็นแม่แบบ + **field เสริมต่อบริษัท** | มีแค่ preset `ECOMMERCE` |

ข้อเสนอสำหรับชั้น 3 (lean ที่สุดที่ยังไม่ต้อง deploy เมื่อเพิ่ม field):

- เพิ่มคอลัมน์เดียว `company.productCustomFields Json @default("[]")` เก็บ array ของ field definition ตรวจด้วย `attributeDefinitionSchema` ตัวเดิม
- `catalogFields()` ใน `products/search/catalog-fields.ts` รวม preset + field เสริม (จุดเดียวที่อ่าน preset อยู่แล้ว ส่วนอื่นไม่ต้องแก้)
- ไม่ทำตาราง definition เต็มรูปแบบ (เคยทำแล้วลบใน migration `20261011050000`) จนกว่าจะมี UI ให้ลูกค้า SaaS แก้เอง

กติกา: "เก้าอี้ VIP ราคาต่างกัน" คือ **Variant** (มีราคาของตัวเอง) ไม่ใช่ meta; "ขึ้นรถที่สถานี" คือ meta; "ว่างกี่ที่" คือคอลัมน์ของรอบ

### 3.2 ข้อค้นพบ

| # | ระดับ | ปัญหา | หลักฐาน |
|---|---|---|---|
| P1 | สูง | **DB local ตั้ง `productBusinessType = 'ELECTRONICS'` ซึ่งไม่มี preset** (`BUSINESS_PRESETS` มีแค่ `ECOMMERCE`) ผลคือ `catalogFields()` คืน `[]` meta ทุกตัว (brand, warranty, connectivity) จึงไม่ถูกค้น ไม่ถูกส่งให้ AI และ filter จะ error ต้องตรวจค่าบน production | `products/attributes/presets/index.ts`, `products/search/catalog-fields.ts:346-358`, query `company` |
| P2 | สูง | **คำศัพท์ ecom เขียนตายตัว** สัญญาณเข้า flow (`เสื้อ`, `รองเท้า`, `สีดำ`, `สีขาว`), ข้อความตอบ (`สินค้า`, `ชิ้น`, `สีและขนาด`), คำต้องห้ามใน prose (`มีของ`, `พร้อมส่ง`) ไม่มี `ว่าง`/`เต็ม` | `product-retrieval.service.ts:49-61,103`, `product-answer.policy.ts:26-32,405-407,611-618`, `products/search/product-terms.ts` |
| P3 | สูง | **ไม่มีแนวคิดวันเวลา** ไม่มี field ชนิดวัน/เวลา, ไม่มีวันปัจจุบันใน prompt ใด ๆ ("พรุ่งนี้" ตีความไม่ได้), ไม่มีตารางรอบ ตารางเวลา บขส ตอนนี้อยู่ใน MicroKnowledge ซึ่งขัดกฎ "ราคา/สต็อกมาจาก DB" | `product-search.types.ts`, `attribute-definition.types.ts`, `.claude/rules/rag-ai.md` |
| P4 | สูง | **Product RAG ใช้ได้เฉพาะ LINE** `CommerceTurn` มี FK ไป `lineMember`/`lineConversation` และ `open()` ตรวจ `lineConversation` | `prisma/models/customers/commerce-turn.prisma`, `commerce/commerce-turn.service.ts:81-96`, `product-retrieval.service.ts:93-100` |
| P5 | กลาง | renderer ปฏิเสธ template ที่มีตัวเลขใด ๆ นอก token ("มี 2 สี" ไม่ผ่าน) แล้วตกไป template สำเร็จรูปที่อ่านแข็ง ยังไม่ได้วัดอัตราจริง | `product-answer.policy.ts:398-410` |
| P6 | กลาง | `currency: 'THB'` และ `language = 'th'` เขียนตายตัว ทั้งที่ variant มีคอลัมน์ currency; `forLineDeployment()` ต้องมีบริษัทเดียวในระบบ | `product-search.service.ts:659`, `commerce/commerce-scope.service.ts` |
| P7 | กลาง | ของค้างจาก `docs/future/product-bks.md` (C1 refs ว่างใน Redis, P1 policy อ่อน, H3 LIMIT 60, M8, M1, เทสต์ C02) **ไม่ได้ตรวจซ้ำรอบนี้** ยกเว้นไฟล์ `custom/prasya.*` ที่ยืนยันว่ายังซ้ำกับ ECOMMERCE อยู่ | `products/attributes/presets/custom/`, `prompts/custom/` |
| P8 | ต่ำ | ค้นด้วย `position(lower(...))` ไม่มี index และคำนวณ BM25 ใน JS พอสำหรับสินค้าหลักพัน ถ้าเป็น SaaS ต้องมี `pg_trgm` | `product-search.service.ts:118-133,335-354` |

สิ่งที่ดีอยู่แล้ว: ราคา/สต็อกอ่านสดจาก DB ใน transaction ทุกครั้ง (ไม่ cache) จึง "real-time" โดยโครงสร้าง; ID ที่ planner คืนต้องอยู่ใน allowlist; replay ต่อ event ไม่เรียก model ซ้ำ

### 3.3 Design ที่แนะนำ (ยืนยันตาม `docs/future/product-bks.md` + ส่วนเพิ่ม)

เห็นด้วยกับโครง Product / Variant / Slot ในเอกสารเดิม ไม่เสนอโครงใหม่

```
Product   สิ่งที่ลูกค้าเรียกชื่อ      ร้านค้า: เสื้อเชิ้ตลินิน    รอบรถ: กรุงเทพ - ขอนแก่น
 Variant  ตัวเลือกที่มีราคา           ร้านค้า: สีดำ / L          รอบรถ: VIP, ชั้น 1
  Slot    ครั้งที่เกิดจริง + ความจุ    ร้านค้า: ไม่ใช้             รอบรถ: 12 พ.ย. 00:00 ถึง 12:00, 49 ที่
```

ส่วนที่เพิ่มจากเอกสารเดิม:

1. **field เสริมต่อบริษัท** (หัวข้อ 3.1) เอกสารเดิมตั้งใจไม่ทำ แต่จำเป็นต่อเป้า "ธุรกิจใหม่ไม่ต้องแก้ code"
2. **`CommerceTurn` ไม่ผูก LINE** เปลี่ยน `lineMemberId` / `conversationId` เป็น nullable และเพิ่ม `channel` + `threadId` ทั่วไป ตรวจความเป็นเจ้าของผ่าน adapter ของแต่ละช่อง (แก้ P4)
3. **ที่นั่ง 3 สถานะ** ("ว่าง 32, จอง 5, จองจริง 12") ใน MVP ใช้ `capacity` + `reserved` ตามเอกสารเดิม เมื่อเปิดจองในแชตค่อยเพิ่มตาราง hold ที่มีวันหมดอายุ "จอง" = ผลรวม hold ที่ยังไม่หมดอายุ "จองจริง" = `reserved`
4. **โรงแรม** ไม่ครอบคลุมด้วย Slot (ต้องเช็คทุกคืนในช่วงที่พัก) ถ้าจะทำต้องออกแบบแยก

รากฐานสำหรับซื้อ/จองในแชต (ยังไม่ทำ แค่ไม่ปิดทาง): `ProductSlot` มี `@@unique([id, companyId])` ให้ตาราง order/hold อ้างได้; หักที่นั่งด้วย conditional update คำสั่งเดียว (`... SET reserved = reserved + n WHERE capacity - reserved >= n`); ใช้ `InventoryMovement` + `operationKey` ที่มีอยู่เป็นแบบของ idempotency

---

## 4. รูปภาพ

ตอนนี้ `answerImage` ส่งรูปให้ model พร้อมกฎจำแนกความปลอดภัยเท่านั้น **ไม่มี retrieval** รูปที่ต้องใช้ข้อมูลร้านถูกจัดเป็น `BUSINESS_UNVERIFIED` แล้ว fallback + handoff และคำตอบที่มีคำว่า `ราคา`, `สต็อก`, `โปรโมชั่น` ถูก block ซ้ำอีกชั้น (`answer.service.ts:170-230`, `answer/image/image-answer.rules.ts`, `intent/utils/image-analysis.policy.ts:18-24`) ช่องอื่นนอกจาก LINE รูปเป็น `unsupported` ตอบข้อความสำเร็จรูป (`channels/channel-inbound.service.ts:24-28`)

Design ที่แนะนำ (1 vision call + pipeline ข้อความเดิม ไม่มี embedding รูป ไม่มีตารางใหม่):

```
รูป → vision call คืน { kind: TRANSACTION | UNREADABLE | QUERY, description, visibleText, searchQuery }
  TRANSACTION (สลิป/บัญชี)  → handoff เหมือนเดิม ไม่ส่งต่อ
  UNREADABLE               → ขอให้ส่งใหม่หรือพิมพ์คำถาม
  QUERY                    → เรียก answerText ด้วย searchQuery (+ ข้อความล่าสุดของลูกค้าถ้ามี)
                             → retrieval / product / grounded ตามปกติ
                             → ตอบไม่ได้: ตอบส่วนที่รู้ + handoff (C10)
```

ตัวอย่าง: รูปตารางรอบรถ → `searchQuery = "รอบรถ กรุงเทพ ขอนแก่น VIP"` → ค้น product/knowledge → ตอบจากหลักฐาน

ไฟล์: `answer.service.ts` (แยก `describeImage`), `chatbot.service.ts` (`handleImageMessage` เรียกต่อ `answerText`), `image-answer.rules.ts`, `image-analysis.policy.ts`

---

## 5. Channel gateway

| # | สถานะ | รายละเอียด |
|---|---|---|
| G1 | ดี | ช่องใหม่ = แถวใน `CHANNEL_KINDS` + ค่าใน enum `ChatChannel` + โฟลเดอร์ connector (`verifySignature`, `parse`, `resolveCompany`, `send`) เข้า `MessageProcessorService` ตัวเดียวกัน ไม่ต้องแตะ router/retrieval/billing (`channels/channel-connector.ts`, `events/message/message-processor.service.ts`) |
| G2 | รับได้ | LINE ยังเป็นอีก stack (`line*`, คิวและ delivery ของตัวเอง) ไม่แนะนำให้ย้ายตอนนี้ ให้ถือกติกาว่าช่องใหม่ทุกช่องเข้า `channel*` เท่านั้น |
| G3 | ต้องแก้เมื่อทำรูป | `InboundMessage` มีแค่ `text` + `unsupported`, `send()` ส่งได้แค่ข้อความ ต้องเพิ่ม attachment ขาเข้าและรูป/การ์ดขาออก |
| G4 | ต้องแก้ก่อน SaaS | credential ของ Facebook อยู่ใน env (page เดียว) ต้องมีตาราง connection ต่อบริษัทแบบเดียวกับ `lineChannels` |
| G5 | ต้องแก้ | Product RAG เฉพาะ LINE (P4); usage ทุกช่องบันทึกเป็น `LINE_AI_REPLY` |
| G6 | ข้อจำกัดภายนอก | TikTok ต้องขออนุมัติ Business Messaging; Shopee ยังไม่พบ webhook แชตทางการ อาจต้อง poll (ตามที่ `channel-gateway-current.md` บันทึกไว้) |

---

## 6. Billing ภายใต้ concurrent สูง

### 6.1 ความถูกต้อง: ผ่าน

- **จองไม่ซ้อน:** `reserveAiCredit` เพิ่ม `reservedCredit` ก่อน แล้วตรวจจากค่าที่ UPDATE คืนมาขณะถือ row lock ผู้เรียกพร้อมกันต้องรอคิวและเห็นยอดจองของกัน (`credit.service.ts:206-303`)
- **ตัดครั้งเดียว:** settle เปลี่ยน `HELD → SETTLED` แบบมีเงื่อนไขก่อน, ledger มี `idempotencyKey` unique, replay คืนผลเดิมโดยไม่เรียก provider (`credit.service.ts:355-464`, `ai-billing.service.ts:91-97`)
- **ไม่ติดลบ:** ยอดจองคำนวณจากเพดาน `max_tokens` ซึ่งครอบทั้ง reasoning และ output

ไม่ว่าจะ 100 หรือ 10,000 ข้อความพร้อมกัน ตัวเลขยังถูก เพราะทุกอย่างเรียงคิวบนแถว wallet ของบริษัทเดียวกัน ข้อจำกัดคือ **throughput ไม่ใช่ความถูกต้อง** และคิว LINE จำกัดไว้ที่ 12 งาน/วินาทีอยู่แล้ว (`line/line-events.queue.ts`) ข้อความส่วนเกินจะรอในคิว ถ้ารอเกิน 50 วินาที reply token หมดอายุและต้องส่งแบบ PUSH ซึ่งกิน quota ของ LINE

### 6.2 จุดอ่อน

| # | ระดับ | ปัญหา | แนวแก้ |
|---|---|---|---|
| B1 | สูง | **ยอดจองค้างไม่ถูกคืนเอง** `HELD` ที่หมดอายุและ `UNKNOWN` ถูกจัดการเฉพาะตอน admin เปิดหน้ารายการ (`credit.service.ts:515-535`) เมื่อค้างสะสม available ลดลงจนถึง `InsufficientCredit` ซึ่งทำให้ **บอทเงียบ ไม่ตอบ ไม่แจ้งใคร** (`chatbot.service.ts:377-393`) | งาน sweep ตามเวลา: `HELD` หมดอายุ → `UNKNOWN`; `UNKNOWN` ที่เก่ากว่าค่าที่กำหนดและไม่มี result → คืนยอดจอง (ต้องให้เจ้าของตัดสิน เพราะเปลี่ยนกฎ "หมดอายุไม่คืนอัตโนมัติ") |
| B2 | สูง | **settle retry เฉพาะ P2034** ถ้าล้มด้วย timeout ของ transaction (Prisma default 5 วินาที) หรือรอ connection ไม่ได้ ผลสำเร็จจะกลายเป็น `UNKNOWN` แล้ว turn เดิมจะติด `PendingAiUsageError` ทุกครั้งที่ retry ลูกค้าไม่ได้คำตอบทั้งที่จ่าย provider แล้ว (`credit.service.ts:600-628`, `ai-billing.service.ts:318-327`) | retry รหัส timeout ด้วย, ตั้ง `timeout`/`maxWait` ของ transaction billing ชัดเจน |
| B3 | กลาง | 1 AI call = 2 transaction บนแถว wallet + budget เดียวกัน แต่ละอันหลาย round trip ขณะถือ lock; 1 ข้อความมี 2 ถึง 4 call | เมื่อจำเป็น: รวมเป็น SQL คำสั่งเดียวต่อ reserve/settle หรือจองครั้งเดียวต่อ turn ยังไม่ต้องทำที่ปริมาณปัจจุบัน |
| B4 | กลาง | เครดิตหมด = เงียบ ไม่มี notification ถึงเจ้าของ | สร้าง `AdminNotification` เมื่อเกิดครั้งแรกในช่วงเวลา |
| B5 | ต่ำ | usage ทุกช่องเป็น `LINE_AI_REPLY` scope `*` แยกต้นทุนต่อช่องไม่ได้ | เพิ่ม scope ต่อช่องเมื่อทำ G5 |

ไม่ได้รัน load test รอบนี้ ข้อ 6.1 สรุปจากการอ่าน code และผลใน `investigation-credit-wallet-contention.md` (ยอดรวมถูกต้อง แต่ยอดจองค้างเมื่อ settle ล้ม)

---

## 7. รากฐาน SaaS

ปัญหาเดียวที่ใหญ่: **key ของ tenant มี 3 แบบ**

| กลุ่มตาราง | key ตอนนี้ |
|---|---|
| `answerPattern`, `microKnowledge`, `aiSettings` | `tenantId` nullable, ค่ามาจาก env (`KNOWLEDGE_TENANT_ID`, `AI_SETTING_TENANT_ID`), ไม่มี FK ไม่มี index |
| product, `channel*`, billing, `decisionLogs`, `lineChannels` | `companyId` มี FK |
| `lineMember`, `lineConversation`, `lineChatHistory`, `lineDelivery`, `aiProviderSettings`, `adminNotifications` | ไม่มี (ทั้งระบบ = 1 บริษัท; `lineUserId` unique ทั้งตาราง) |

และ service อ่าน scope จาก constructor (env) หรือ singleton (`CompanyService.getCompanyId`, `forLineDeployment`) ไม่ได้รับจาก request

แนวทาง additive ไม่รื้อ (ทำเป็น phase ท้าย):

1. `ChatRequest` เพิ่ม `companyId` ที่ adapter ของช่องเป็นผู้ resolve (LINE: จาก `lineChannels.channelKey` ที่มีอยู่, ช่องอื่น: มีในแถวอยู่แล้ว)
2. retrieval / AiSetting / commerce scope รับ `companyId` เป็นพารามิเตอร์ ค่า default = พฤติกรรมเดิม
3. เพิ่ม `companyId` nullable + index ใน `answerPattern`, `microKnowledge`, `aiSettings`, `lineMember` แล้ว backfill ด้วยบริษัทเดียวที่มี ยังไม่เปลี่ยน unique จนกว่าจะมี tenant ที่สอง
4. cache ใน memory (C11, rich menu) ใช้ `companyId` เป็น key

---

## 8. แผนงานตาม phase

### Phase 0 แก้เร็ว ผลสูง (ไม่มี migration)

C1 (เพดาน token + `finishReason` + retry 1 ครั้ง), C2, C3, C5, C13, C14 และตรวจค่า `productBusinessType` บน production (P1)

ไฟล์หลัก: `answer/answer.service.ts`, `intent/intent-router.service.ts`, `chatbot.service.ts`, `knowledge/knowledge-retrieval.service.ts`, `ai-provider/providers/*` + `types/ai-provider.types.ts` (เพิ่ม `finishReason`)

### Phase 1 Core RAG ตอบตรง (ไม่มี migration)

C4 (rate limit เป็น backpressure), C6 (`NOT_BUSINESS`), C8 (ขั้นเข้าใจคำถาม), C9 (ค้นตามคำถามย่อย), C10 (ตอบบางส่วน + handoff), C11 + C12 (index ใน memory), C15 (เอกสาร)

ของเดิมที่ใช้ซ้ำ: `toAiProviderMessages`, `KnowledgeRetrievalService.retrieve` (ทางเข้าเดียวของ retrieval ตามกฎ), `rank()` RRF, `UserSessionService.requestAdmin`, `DecisionTraceService`

### Phase 2 Product ข้ามธุรกิจ

- แก้ของค้าง P7 ตาม Phase 0 ของ `product-bks.md`
- preset กำหนดคำศัพท์และความสามารถ (`BusinessCapabilities`, `BusinessLexicon`) ตาม Phase 1 ของ `product-bks.md` โดย ECOMMERCE ต้องได้ผลเหมือนเดิมทุกตัวอักษร (แก้ P2, C7)
- field เสริมต่อบริษัท (3.1) + preset `GENERAL` ที่ลงทะเบียนจริง (แก้ P1)
- `CommerceTurn` ไม่ผูก LINE (แก้ P4), ใช้ `variant.currency` (แก้ P6)

### Phase 3 รอบรถ (TRANSPORT)

ตาม Phase 2 ของ `product-bks.md`: ตาราง `productSlots`, `shared/date/thai-date.ts` + วันเวลาปัจจุบันใน planner prompt, plan เพิ่ม `when` / `quantity` / `slotIds`, ค้นรอบแบบ deterministic, token และ renderer ของรอบ, import ข้อมูล บขส แล้วปิดตารางเวลาใน MicroKnowledge

### Phase 4 รูปภาพ → RAG

หัวข้อ 4 + G3 (attachment ใน `InboundMessage` สำหรับช่อง `channel*`)

### Phase 5 Billing hardening

B1, B2, B4

### Phase 6 รากฐาน SaaS + gateway

หัวข้อ 7 ข้อ 1 ถึง 4, G4 (ตาราง connection ต่อบริษัท), B5

### ตั้งใจไม่ทำ (กัน over-engineer)

reranker, embedding ของรูป, agentic multi-step search, ตาราง definition ที่ tenant แก้ผ่าน UI, RLS, ย้าย LINE เข้า `channel*`, seat map, จอง/จ่ายเงินในแชต, รองรับโรงแรมหลายคืน

---

## 9. การเปลี่ยน DB (ทั้งหมด additive)

| Phase | การเปลี่ยน | Backfill |
|---|---|---|
| 2 | `company.productCustomFields Json @default("[]")` | ไม่ต้อง |
| 2 | `commerceTurns`: `lineMemberId`, `conversationId` เป็น nullable; เพิ่ม `channel`, `threadId` | แถวเดิม: `channel = 'LINE'`, `threadId = conversationId` |
| 3 | enum `ProductSlotStatus` + ตาราง `productSlots` (ตาม `product-bks.md` 5.4) | ไม่ต้อง |
| 6 | `companyId` nullable + index ใน `answerPattern`, `microKnowledge`, `aiSettings`, `lineMember` | ใส่บริษัทเดียวที่มี |
| 6 | ตาราง connection ของช่องต่อบริษัท | ย้ายค่าจาก env ของ Facebook |

ทุก migration ทำตาม `.claude/rules/prisma.md`: `migrate dev --create-only` บน DB local, ตรวจ SQL, **push ไป `main` จะรัน `migrate deploy` บน production ทันที**

---

## 10. การทดสอบและการวัดผล

ทุก phase:

- เทสต์เฉพาะส่วน: `bunx jest src/modules/chatbot` , `bunx jest src/modules/products` , `bunx jest src/modules/usage`
- `bunx tsc --noEmit`, `bun run lint`, `bun run build`
- เทสต์ mock LINE/AI ทั้งหมด ไม่ส่งข้อความจริง

เฉพาะ phase:

| Phase | วิธียืนยัน |
|---|---|
| 0 | unit test: JSON ถูกตัด → retry แล้วได้คำตอบ; citation ผิด 1 จาก 2 → รับคำตอบ; classifier ล้ม + มีหลักฐาน → grounded |
| 1 | เพิ่มเคสใน `knowledge/test/retrieval-eval.cases.ts`: follow-up ไม่มีคำชี้ ("แล้วราคาล่ะ"), 2 คำถามที่ตอบได้ 1, ข้อความทั่วไปที่ vector สูง; รัน `retrieval-eval.spec.ts` เทียบตัวเลขก่อน/หลัง |
| 1 | live eval ด้วย `test/live/chatbot-answer.live-eval.ts` **เฉพาะเมื่อเจ้าของสั่ง** งบรวมไม่เกิน 50 AI call: 20 เคส core (ประมาณ 40 call) + สำรอง 10 |
| 2 | golden set ecom เดิมต้องได้ผลเหมือนเดิม; เทสต์ company ที่มี field เสริม; เทสต์ product บนช่อง APP |
| 3 | golden set บขส 18 ข้อใน `product-bks.md` หัวข้อ 8 |
| 5 | เทสต์ DB จริงบน local: settle ล้มด้วย timeout แล้ว retry สำเร็จ; sweep คืนยอดจองครั้งเดียว; ยอด wallet = ผลรวม ledger |

ตัวชี้วัดจาก `decisionLogs` (วัดก่อนและหลังแต่ละ phase บน production):

```sql
-- สัดส่วน fallback แยกตามสาเหตุ
select "fallbackReason", count(*) from "decisionLogs"
where "isFallback" group by 1 order by 2 desc;
-- มีหลักฐานดีแต่ fallback (เป้า: ลดลงหลัง phase 0)
select count(*) from "decisionLogs"
where "isFallback" and "topVectorSimilarity" >= 0.75;
```

เป้าหลัง Phase 0: `INVALID_GROUNDED_OUTPUT`, `INVALID_EVIDENCE_REFERENCE`, `AI_BUDGET_EXHAUSTED` ใกล้ศูนย์

---

## 11. สิ่งที่เจ้าของต้องตัดสินใจก่อนเริ่มแต่ละ phase

1. **Phase 0:** ค่า `productBusinessType` บน production คืออะไร (ถ้าเป็น `ELECTRONICS` เหมือน local แปลว่า meta ไม่ถูกใช้เลยตอนนี้)
2. **Phase 1:** ยอมให้ข้อความรอในคิวเมื่อ AI limit เต็ม แทนการตอบ fallback ทันทีหรือไม่ (แนะนำ: ยอม)
3. **Phase 3:** 6 ข้อใน `product-bks.md` หัวข้อ 10 (แสดงจำนวนที่นั่งจริงหรือแค่สถานะ, แหล่งข้อมูลที่นั่ง, ช่วงวันที่เปิดให้ถาม ฯลฯ)
4. **Phase 5:** ยอมให้ระบบคืนยอดจองที่ค้างเองหลังกี่นาที (ความเสี่ยง: provider อาจคิดเงินไปแล้วแต่เราไม่ได้ตัดเครดิตลูกค้า)
5. **เครดิตหมด:** ให้บอทเงียบเหมือนเดิม หรือส่งข้อความสำเร็จรูป + แจ้งเจ้าของ

---

## 12. เทียบคู่แข่ง

"Zappie" ที่ระบุมา ค้นไม่พบ ที่ใกล้ที่สุดคือ **Zaapi** (zaapi.com) จึงเทียบกับตัวนี้ ถ้าหมายถึงเจ้าอื่นแจ้งได้

| ด้าน | Zaapi (จากหน้าเว็บ) | ระบบนี้ |
|---|---|---|
| ช่องทาง | inbox เดียวรวม Shopee, Lazada, TikTok Shop, Facebook, Instagram, LINE OA, เว็บ | LINE, Facebook, App; มี gateway พร้อมเพิ่มช่อง |
| AI | ตอบ FAQ + แนะนำสินค้า, chatbot แบบ rule | RAG แบบ grounded + ราคา/สต็อกจาก DB จริง + decision log ตรวจย้อนได้ |
| อื่น ๆ | broadcast ด้วย AI | ยังไม่มี |

จุดที่ชนะได้: ความถูกต้องของข้อมูลที่เปลี่ยนเร็ว (ราคา สต็อก ที่นั่ง) และธุรกิจที่ไม่ใช่ร้านค้า (รอบรถ ทัวร์ คอร์ส) จุดที่ต้องตามให้ทัน: จำนวนช่องทาง (marketplace), ข้อความแบบรูป/การ์ด, broadcast

แหล่งอ้างอิง: [Zaapi LINE integration](https://www.zaapi.com/integration/line), [Zaapi pricing](https://en.zaapi.com/pricing), [Zaapi chat integration](https://www.zaapi.com/blog/zaapi-chat-integration), [Enhancing RAG for customer support (arXiv 2508.05664)](https://arxiv.deeppaper.ai/papers/2508.05664v1?locale=en), [Domain-specific QA with hybrid search (arXiv 2412.03736)](https://arxiv.org/html/2412.03736v1)
