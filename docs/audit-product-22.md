# Audit: Product feature (catalog, meta, Product RAG, สต็อก)

วันที่ 22 ตุลาคม 2026 · อ่านจาก working tree บน `main` (HEAD `6c7bc8d` + ไฟล์ที่ยังไม่ commit)

ขอบเขต: เฉพาะ feature product คือ preset/meta, การเขียนสินค้า, สต็อก, index/embedding, การค้นและตอบเรื่องสินค้าในแชต และความพร้อมสำหรับ phase ถัดไป (สั่งซื้อผ่านแชต, ตัดสต็อก, แอดมินถาม AI, หลายธุรกิจ, SaaS)

วิธีตรวจ: อ่านโค้ด schema migration และเอกสาร แล้วเทียบกับแนวปฏิบัติจากแหล่งภายนอก (รายการท้ายไฟล์) **ไม่ได้รัน load test หรือ `EXPLAIN ANALYZE`** ตัวเลขด้านประสิทธิภาพทั้งหมดในเอกสารนี้มาจากการนับในโค้ด ยกเว้น `catalogFields()` ที่วัดได้ 129 µs ต่อครั้ง

ภาพ flow ทั้งหมดแบบคลิกดูทีละขั้นอยู่ใน [product-flow.html](product-flow.html)

---

## สรุป

**ฐานแข็งแรงและมาถูกทาง** แนวทางหลักตรงกับที่ใช้กันในงาน e-commerce RAG:

- **แยกส่วนความหมายออกจากเงื่อนไขบังคับ:** LLM แปลงคำถามเป็น plan (options, filters, ช่วงราคา) แล้วโค้ดกรองแบบ deterministic
- **ราคาและสต็อกมาจาก DB เท่านั้น:** LLM ตอบเป็น template แล้ว renderer แทนค่าจริงจาก token ข้อนี้เข้มกว่าที่แหล่งส่วนใหญ่แนะนำ
- **idempotent ครบทุกชั้น:** catalog command, CommerceTurn ต่อ webhook event, slot ของ LLM, billing และ outbox ของ index
- **ownership เป็นของบริษัท:** มี `companyId` ทุกตาราง และใช้ composite FK `(id, companyId)`
- **รองรับหลายธุรกิจ:** เพิ่มธุรกิจด้วยไฟล์ preset ได้ (ตอนนี้มีแค่ ECOMMERCE)

**ต้องแก้ก่อนไป phase ถัดไป** (รายละเอียดในหัวข้อ 3):

1. ร้านที่ยังไม่ได้ apply ECOMMERCE จะได้ field ว่าง ทำให้ทั้ง admin และแชตพัง (H1)
2. เทสต์ของ product เกือบทั้งหมดถูกลบไปแล้ว ไม่มีอะไรจับ regression ของการค้น (H2)
3. การค้นแบบ DETAIL ตัด candidate ไว้ 60 ตัวก่อนกรองด้วย option/filter ร้านใหญ่จะหาสินค้าที่ตรงไม่เจอ (H3)
4. ตาราง `inventoryMovements` บังคับให้มีแอดมินและ catalog command ทุกแถว จึงบันทึกการตัดสต็อกจาก order ของลูกค้าไม่ได้ (H4)
5. AI ของแอดมินเป็นแชตเปล่า ไม่มีทางเข้าถึงข้อมูลสินค้าหรือสต็อก (M2)

**ไม่ต้องรื้อ** ที่ต้องทำส่วนใหญ่เป็นการเพิ่ม (order, hold, admin query) และแก้เฉพาะจุด (scope ของบริษัท, ลำดับการกรอง) โครงหลักใช้ต่อได้

---

## 1. Pipeline ปัจจุบันโดยย่อ

```
เขียน:   Admin API → DTO (zod, key ปลอดภัย) → ProductCommandService (idempotent ด้วย requestId)
         → lock (preset แบบ shared, product FOR UPDATE, version) → validate meta กับ preset → เขียน DB
         → enqueue index job (outbox ใน tx เดียวกัน)
สต็อก:   Admin API → command → lockProduct → balance FOR UPDATE → onHand + delta ≥ reserved → movement
Index:   worker ทุก 5s → claim (lease) → ตรวจว่ายังเป็นงานล่าสุด → embed นอก tx → ตรวจ hash ซ้ำ → upsert vector
แชต:     retrieve → gate (flag, regex นโยบาย, scope) → CommerceTurn (snapshot ต่อ event, lease)
         → plan (rule หรือ LLM PLAN) → ตรวจ plan กับ preset → search (RepeatableRead)
         → evidence (meta + ราคา/สต็อกสด) → LLM ANSWER (template) → renderer ตรวจ → [CRITICAL_REPAIR]
```

ส่วนที่ทำให้หลายธุรกิจใช้ร่วมกันได้คือ [catalog-fields.ts](../src/modules/products/search/catalog-fields.ts) ทุกจุดถามรายการ field ของร้านผ่านไฟล์นี้ ค่าจริงอยู่ใน `productVariants.meta` (jsonb)

---

## 2. เทียบกับแนวปฏิบัติ

| แนวปฏิบัติ | แหล่ง | ของเรา | สถานะ |
|---|---|---|---|
| แยก intent กับ hard constraint ให้ LLM แปลงเป็น filter (self-query) | fin.ai, LangChain self-query | planner คืน `options`/`filters`/`minPrice`/`category` ตาม `productPlanSchema` และตรวจ key กับ preset | ✓ |
| กรองด้วยเงื่อนไขก่อน แล้วค่อยจัดอันดับ (filter-then-rank) ไม่ให้ top-K ตัดของที่ตรงทิ้ง | fin.ai | aggregate (LIST/COUNT/CHEAPEST) scan ทั้ง catalog ✓ แต่ DETAIL/RECOMMEND/COMPARE ที่มีคำค้นตัด 60 ตัวก่อนกรอง ✗ | △ (H3) |
| embedding ใช้กับความหมายเท่านั้น ห้ามใช้บังคับตัวเลข | fin.ai | vector เป็นแค่ fallback ส่วนตัวเลขเทียบด้วย `Prisma.Decimal` | ✓ |
| ราคา/สต็อกเป็นข้อมูลมีโครงสร้าง ตรวจที่ระดับ variant | fin.ai, AGENTS.md | อ่านสดจาก `price`/`inventoryBalances` และแทนค่าผ่าน token | ✓ |
| รวม variant ต่อสินค้า ไม่ให้ variant ซ้ำกินช่องผลลัพธ์ | fin.ai | evidence จัดกลุ่มต่อ product ใน prompt, DETAIL เลือก 1 สินค้า | ✓ |
| ข้อมูลที่ดึงมาเป็น data ไม่ใช่คำสั่ง (กัน indirect prompt injection) | OWASP LLM01 | evidence อยู่ใน `dataSections` ผ่าน `safeJson` และ prompt บอกว่าเป็นข้อมูล | ✓ |
| LLM ไม่มีอำนาจทำธุรกรรมเอง (excessive agency) | OWASP LLM06 | ตอนนี้ LLM ไม่มี tool เลย และ order design ใช้ state machine | ✓ |
| การกระทำที่มีผลข้างเคียงต้องมี key กันซ้ำที่ server ออกให้ ไม่ใช่ให้ LLM ตัดสิน | channel.tel, wikidocs | `requestId`, `externalEventId`, slot `(turnId, slot)`, billing `operationKey` | ✓ |
| ชุดคำถามทดสอบตายตัว (golden set) วัด retrieval แยกจาก generation | wz-it, RAG eval guides | spec ของ search ถูกลบ, audit fixture เสีย, ไม่มี recall/precision | ✗ (H2) |
| เก็บ attribute ที่ต่างกันตามธุรกิจเป็น JSONB แทน EAV | postgresweekly, thebuild | `meta` jsonb + definition ในโค้ด | ✓ |
| ค้นภาษาไม่มีช่องว่าง (ไทย) | pg_bigm/pg_trgm discussions | ใช้ `position()` substring + BM25 ไทยใน JS พอสำหรับร้านเล็ก ยังไม่มี index | △ (ดูหัวข้อ 4.6) |
| จองสต็อกแบบมีวันหมดอายุ ตรวจและหักแบบ atomic มีงานคืน hold ที่ปลอดภัยจาก race | Shopify engineering, LLD guides | ยังไม่มี order/hold มีแค่คอลัมน์ `reserved` | ✗ (ยังไม่ถึง phase) |
| multi-tenant: กรอง tenant ทุก query และอาจใช้ RLS เป็นชั้นสำรอง | Atlas, oneuptime | `companyId` ทุก query ✓ ไม่มี RLS และ scope มาจากบริษัทเดียวในระบบ | △ (M3) |
| AI ของแอดมินเข้าถึงข้อมูลผ่านเครื่องมือแบบอ่านอย่างเดียวที่จำกัดขอบเขต ไม่ใช่ text-to-SQL อิสระ | towardsai, dev.to | ยังไม่มีทางเข้าถึงข้อมูลเลย | ✗ (M2) |

---

## 3. สิ่งที่พบ

ระดับ: **H** = แก้ก่อน phase ถัดไป · **M** = ควรแก้ตอนเริ่ม phase ที่เกี่ยวข้อง · **L** = แก้เมื่อสะดวก

### H1. ร้านที่ type ไม่ใช่ preset ที่ลงทะเบียน ได้ field ว่างทุกจุด
- **ที่:** [catalog-fields.ts:43](../src/modules/products/search/catalog-fields.ts#L43) คืน `[]` เมื่อ `BUSINESS_PRESETS[type]` ไม่มี
- **ผล:** ร้านที่ `productBusinessType` ยังเป็น null หรือ FASHION/HOTEL/… เขียน meta ไม่ได้ (400) planner ถูกตีกลับเมื่อลูกค้าระบุสี/ไซส์ (`Unknown planner option field`) แล้วไปตอบ fallback AI ไม่เห็น details และ vector ยังเป็น label เก่า
- **แก้:** ขั้นตอน deploy ต้องเรียก `POST /api/admin/products/attributes/presets/ECOMMERCE/apply` (bump searchRevision และ re-embed) อัปเดตไว้ใน README ของ migration `20261020000000` แล้ว ทางเลือกคือเพิ่ม data migration เปลี่ยนค่า type ให้อัตโนมัติ

### H2. เทสต์ของ product แทบไม่เหลือ
- **ที่:** commit `96fbb23` ลบ `product-search.service.spec.ts` และ spec ของ billing ส่วน `package.json` ยังมี `test:commerce` / `test:product-audit` ที่ชี้ไป `test/scripts/*.mjs` ซึ่งไม่มีอยู่แล้ว
- **เหลือ:** [product-answer.policy.spec.ts](../src/modules/chatbot/knowledge/product/product-answer.policy.spec.ts) 11 เคส (fail 1 เคสเพราะยังใช้ `businessType: 'FASHION'`) และ audit harness ใน `test/audit` ซึ่ง fixture ยัง `applyPreset('FASHION')`
- **ผล:** การแก้ scoring, planner หรือ meta ต่อจากนี้ไม่มีอะไรจับ regression ทั้งที่ AGENTS.md บังคับให้มี retrieval test ด้วยคำถามไทยจริง
- **แก้ (ขั้นต่ำ):** คืน spec ของ `ProductSearchService` แบบใช้ DB ทดสอบแยก ใส่ชุดคำถามไทยตายตัวประมาณ 20–30 ข้อที่ครอบคลุม: option บน variant เดียวกัน, filter ตัวเลข, ไม่มีตัวเลือก (VARIANT_UNAVAILABLE), กำกวม, COUNT/LIST, SKU, ของหมด, และร้านที่ไม่มี preset แล้วแก้ fixture ให้ใช้ ECOMMERCE

### H3. DETAIL/RECOMMEND/COMPARE ที่มีคำค้น ตัด 60 ตัวก่อนกรองด้วย option/filter
- **ที่:** [product-search.service.ts:331-366](../src/modules/products/search/product-search.service.ts#L331) lexical `LIMIT 60` (เรียงตาม relevance แล้ว id) จากนั้น `findMany take 80` แล้วค่อยเรียก `evidence()` ที่ใช้ `matchesBusinessFields` กรอง
- **ผล:** ถ้าร้านมีเสื้อ 200 ตัวและลูกค้าถาม "เสื้อสีแดงไซส์ XL" ตัวที่ตรงอาจไม่อยู่ใน 60 ตัวแรก ทำให้ได้ MISSING_INPUT หรือตอบตัวอื่น ตรงกับ failure mode "fixed top-K crowds out valid items" ที่ fin.ai รายงาน ร้านเล็ก (สินค้าที่ตรงคำค้นไม่เกิน 60) ยังไม่เจอปัญหา
- **แก้ (เลือกอย่างใดอย่างหนึ่ง):**
  1. เมื่อ plan มี options/filters ให้ใช้เส้นทาง keyset scan แบบเดียวกับ aggregate (มีอยู่แล้ว แก้เงื่อนไข `allCatalogOperation` ไม่กี่บรรทัด) แลกกับการ scan มากขึ้น
  2. ใส่เงื่อนไขที่แปลงเป็น SQL ได้แน่นอนลงใน candidate query ก่อน `LIMIT` เช่น `v.meta->>'size' = 'XL'` แล้วยังตรวจซ้ำด้วย `matchesBusinessFields` (alias/คำนำหน้ายังต้องใช้ JS)

### H4. `inventoryMovements` บันทึกการตัดสต็อกจาก order ไม่ได้
- **ที่:** [product.prisma:140-160](../prisma/models/products/product.prisma#L140) `commandId` (unique, FK ไป `productCatalogCommands`) และ `actorAdminId` (FK ไป `AdminMember`) เป็น NOT NULL
- **ผล:** การจอง/ตัดสต็อกจาก order ของลูกค้าหรือจากระบบ (หมดเวลาจอง) ไม่มีแอดมินและไม่ใช่ catalog command จึงสร้าง movement ไม่ได้ ถ้าข้ามการบันทึกจะเสีย audit trail ของสต็อก
- **ข้อดีที่มีอยู่:** คอลัมน์ `deltaReserved`, `reservedAfter`, `operationKey` (unique) รองรับการจองไว้แล้ว
- **แก้ (ตอนทำ order):** migration ให้ `commandId`/`actorAdminId` เป็น nullable และเพิ่ม `source` (`ADMIN` | `ORDER` | `SYSTEM`) กับ `orderId`/`holdId` พร้อม CHECK ว่าต้องมีอ้างอิงอย่างน้อยหนึ่งอย่างตาม source

### M1. categories ต่อ field ใน preset ถูกเขียนทับ
- **ที่:** [catalog-fields.ts:51](../src/modules/products/search/catalog-fields.ts#L51) `categories: [...categories]` ใช้หมวดของร้านกับทุก field
- **ผล:** ร้าน ECOMMERCE ที่ขายหลายหมวดกำหนดไม่ได้ว่า `size` ใช้กับเสื้อ ส่วน `weight_g` ใช้กับกระเป๋า และใช้ `required` แบบแยกหมวดไม่ได้
- **แก้:** ใช้ `field.categories` ของ preset ถ้ามี ไม่งั้นใช้ของร้าน (แก้ 1 บรรทัด + เทสต์)

### M2. AI ของแอดมินไม่มีทางเข้าถึงข้อมูลสินค้า
- **ที่:** [admin-chat.service.ts](../src/modules/admin/ai-chat/admin-chat.service.ts) ส่งประวัติแชตกับ system instruction ไปที่ provider เท่านั้น และ `src/ai-provider` ไม่มี tool calling
- **ผล:** แอดมินถาม "เสื้อ TEE-BK-L เหลือกี่ตัว" ได้คำตอบที่ไม่มีหลักฐาน (prompt บอกห้ามแต่ง แต่ไม่มีข้อมูลให้ตอบ)
- **แก้:** ดูหัวข้อ 4.5

### M3. Scope ของบริษัทมาจาก "มีบริษัทเดียวในระบบ"
- **ที่:** `CommerceScopeService.forLineDeployment` [commerce-scope.service.ts:51](../src/modules/commerce/commerce-scope.service.ts#L51) ใช้ทั้งใน `retrieveProduct` และ `ProductIndexService.tick/process`
- **ผล:** ถ้ามีบริษัทที่สอง Product RAG จะปิดตัวเอง (ตอบ legacy) และ index worker หยุด ซึ่งปลอดภัย (fail closed) แต่เป็นตัวกั้น SaaS
- **แก้ (ตอนทำ SaaS):** หา company จาก LINE channel ที่รับ event (`destination`/channel ไปเป็น company) และให้ index worker วนทุกบริษัทที่เปิด semantic เป็นการแก้เฉพาะจุดเพราะทุก query ด้านล่างรับ scope อยู่แล้ว

### M4. `plannerCatalog` scan variant ทั้งร้านทุก turn และค่า TAGS ออกมาเป็น JSON
- **ที่:** [product-search.service.ts:186-195](../src/modules/products/search/product-search.service.ts#L186)
- **ผล 1:** ทุก turn ที่ถึง planner คลี่ `meta` ของทุก variant ที่ active ค่าใช้จ่ายโตตามจำนวน variant
- **ผล 2:** `jsonb_each_text` กับค่าที่เป็น array (TAGS เช่น `features`) คืนข้อความ `["กันน้ำ","เบา"]` ทั้งก้อน planner จึงเห็นค่าเป็น JSON string ไม่ใช่รายการแท็ก
- **แก้:** cache ผลต่อบริษัท (Redis TTL ~60s หรือลบเมื่อ catalog command commit) ถ้า cache เก่าก็แค่ทำให้ planner ไม่รู้ค่าใหม่ชั่วคราว การค้นจริงยังเทียบกับ DB และใช้ `jsonb_array_elements_text` สำหรับ field TAGS/MULTI_SELECT

### M5. งานซ้ำในหนึ่ง turn
- นับจากโค้ด: turn สินค้าทั่วไป (plan + answer) มี DB round trip ประมาณ 30 ครั้ง ไม่นับ billing ส่วนใหญ่เป็น lookup ด้วย PK/unique ใช้เวลาไม่กี่ ms ต่อครั้ง เวลาหลักยังเป็น LLM 2 ครั้ง
- ซ้ำที่เห็นชัด: `probe` เรียกได้ถึง 3 ครั้ง (routing, plan, ใน search ถ้าไม่มี productIds), อ่านแถว company 3 ครั้ง, `forLineDeployment` ทุก turn
- **แก้ (ถูก):** ส่งผล `probe` ของ routing ต่อไปที่ plan stage และ cache scope ต่อ process (ค่าเปลี่ยนเมื่อมีการเพิ่มบริษัทเท่านั้น) **ห้าม** cache การอ่าน preset ใน `search()` เพราะต้องตรงกับข้อมูลใน transaction เดียวกัน

### M6. ไม่มีอะไรตรวจ key ใน preset
- **ที่:** `assertSafeDefinition` ใน [attribute-key.util.ts:19](../src/modules/products/attributes/utils/attribute-key.util.ts#L19) ไม่ถูกเรียกที่ไหน
- **ผล:** ถ้าประกาศ key อย่าง `stock_qty` หรือ `cost_price` ใน preset ตัว preset โหลดได้ แต่ DTO จะปฏิเสธทุกค่าที่เขียน (field ใช้ไม่ได้แบบเงียบๆ)
- **แก้:** unit test ที่วนทุก preset ทุก field แล้วเรียก `assertSafeDefinition(key, label)` และ `definitionIssues`

### M7. แชตค้นเฉพาะสินค้า `language = 'th'`
- **ที่:** [product-retrieval.service.ts:374](../src/modules/chatbot/knowledge/product/product-retrieval.service.ts#L374) ส่ง `'th'` ตายตัว รวมถึงค่า default ของ `probe` และ `plannerCatalog`
- **ผล:** สินค้าที่บันทึกเป็น `en` ไม่โผล่ในแชตเลย ตอนนี้ยังไม่กระทบ แต่ควรรู้ก่อนรองรับหลายภาษา

### M8. filter ที่ planner ส่งมาบางตัวหายเงียบ
- **ที่:** [product-retrieval.service.ts:313-330](../src/modules/chatbot/knowledge/product/product-retrieval.service.ts#L313) filter `EQ` บน key ที่เป็นตัวเลือกถูกลบออกจาก `filters` ทั้งหมด แต่ย้ายไป `options` ได้เฉพาะเมื่อยังไม่มี key นั้นและ options ยังไม่ครบ 6
- **ตัวอย่าง:** "เสื้อสีดำหรือสีแดง" planner ส่ง option สีดำ + filter สีแดง ผลคือสีแดงหายไป
- **แก้:** ลบออกจาก filters เฉพาะตัวที่ย้ายสำเร็จ

### L1–L5
- **L1** `POST /api/admin/products/bulk` (role dev) ไม่บังคับ `requestId` ต่อ item การส่งซ้ำจะสร้างซ้ำหรือชน SKU ให้บังคับใน `BulkCreateProductDto`
- **L2** lexical query คำนวณ `searchableValues` (คลี่ meta) ซ้ำ 3×T ครั้งต่อสินค้า (`condition`, `relevance`, `identityHits`) ใช้ `LEFT JOIN LATERAL` คำนวณครั้งเดียว
- **L3** `InventoryService.adjust` ล็อกแถว `products` ก่อนเสมอ ทำให้การปรับสต็อกทุก variant ของสินค้าเดียวกันต้องรอกัน ยังไม่เป็นปัญหาสำหรับการปรับโดยแอดมิน แต่ flow order ไม่ควรใช้ทางนี้ (ดู 4.4)
- **L4** `core-logic-erd.html` ยังแสดงตาราง fashion/restaurant/hotelVariants ที่ถูกลบแล้ว
- **L5** HEAD บน `main` compile ไม่ผ่าน เพราะไฟล์ที่ commit แล้ว import ไฟล์ที่ยังไม่ commit

---

## 4. ความพร้อมต่อเป้าหมายแต่ละข้อ

### 4.1 ดึงข้อมูลสินค้ารวมถึง meta มาตอบลูกค้าถูกต้อง: **พร้อม (แก้ H1, H3, M4 ก่อน)**
- meta ไปถึง LLM ผ่าน evidence (`details`/`options` เฉพาะ field ที่ `aiVisible`) และค่าที่แสดงมาจาก token ทุกตัว
- กลไกกันตอบมั่วครบ: ตรวจ token, ตรวจว่าไม่มีตัวเลขหรือคำเรื่องสต็อกนอก token, ตรวจว่าไม่พิมพ์ค่าตัวเลือกเอง, ต้องตอบครบตามที่ถาม และมี repair call เมื่อจำเป็น
- **ข้อควรตัดสินใจ:** ตอนนี้ลูกค้าถาม "เหลือกี่ชิ้น" จะได้จำนวนจริง (`stockQuantity`) บางร้านไม่อยากเปิดเผยตัวเลขนี้ ควรเป็นค่าตั้งของร้านหรือของ preset

### 4.2 เขียน logic บนข้อมูลใน meta: **ยังไม่มี แต่ต่อได้ง่าย**
- **แยกให้ชัด:** สต็อกและราคาไม่อยู่ใน meta และห้ามอยู่ (`onhand`, `stock`, `price`, `qty`, … เป็นคำต้องห้ามใน key) logic เรื่องสต็อกต้องอ่าน `inventoryBalances`
- **ข้อเสนอ (lean):** ให้ preset ประกาศ rule เป็นข้อมูล แล้วมีฟังก์ชันประเมินเดียวที่ไม่มี I/O ใช้ความหมายของ operator เดียวกับ `matchesBusinessFields`:

```ts
// ข้อเสนอ ยังไม่มีในโค้ด
type MetaRule = Readonly<{
  id: string;
  when: { key: string; operator: 'EQ' | 'CONTAINS' | 'NOT_CONTAINS' | 'GTE' | 'LTE' | 'MISSING'; value?: string | number | boolean }[];
  then: 'HIDE_FROM_AI' | 'NOT_PURCHASABLE' | 'REQUIRE_ADMIN' | { badge: string };
}>;
// BusinessPreset = { label, prompt, fields, rules?: readonly MetaRule[] }
```

- **จุดที่ต่อ:** `evidence()` (ตอนแชต), `validateAttributeValues` (ตอนเขียน), `catalogView` (หน้า admin)
- **ไม่แนะนำ:** ให้แต่ละธุรกิจเขียนโค้ด TypeScript อิสระต่อ rule หรือให้ LLM ตีความ rule เพราะทดสอบยากและผลไม่แน่นอน

### 4.3 สั่งซื้อผ่านแชต: **ยังไม่มี ฐานที่ใช้ต่อได้มีครบ**
ใช้ต่อได้:
- `catalogRefs` ใน context ทำให้ "เอาตัวนี้" อ้างถึง variant ได้
- `purchasable` ใน evidence
- CommerceTurn กันการ retry ซ้ำ
- [order-payment-claude.md](feature/order-payment-claude.md) ออกแบบแนวทาง "LLM คุย, state machine ทำธุรกรรม" ไว้แล้ว ตรงกับแนวปฏิบัติ (OWASP LLM06: ห้ามให้ LLM มีอำนาจทำธุรกรรมเอง; บันทึกเหตุการณ์จริงที่ agent retry แล้วตัดสต็อกซ้ำ)

ต้องเพิ่ม (ขั้นต่ำ):
- ตาราง `Order`, `OrderLine`, `InventoryHold` และแก้ H4
- Session `CHECKOUT` ที่ชี้ไป order ใน DB และปุ่ม quick reply ทุก step (ต้องขยาย `LineDelivery` ให้ส่งได้มากกว่า text)
- **ราคาและสต็อกต้องอ่านใหม่ตอนสร้าง order** ห้ามใช้ snapshot ใน `commerceTurns.retrieval` (snapshot มีไว้ตอบคำถามเท่านั้น)
- ลำดับข้อความต่อผู้ใช้ข้าม process ยังใช้ Map ใน memory (AGENTS.md ระบุว่าไม่พอ) ความถูกต้องของ checkout จึงต้องอยู่ที่ conditional update ใน DB ไม่ใช่ที่ลำดับของ worker

### 4.4 ตัดสต็อกถูกต้อง: **ออกแบบให้ใช้คำสั่งเดียวที่ atomic**
แนวที่แหล่งส่วนใหญ่เห็นตรงกัน: hold มีวันหมดอายุ, ตรวจและหักต้อง atomic, งานคืน hold ต้องปลอดภัยจาก race กับการยืนยันจ่ายเงิน

```sql
-- จอง (hold): ตรวจและจองในคำสั่งเดียว ไม่ต้องล็อกแถว products
UPDATE "inventoryBalances"
SET reserved = reserved + $q, version = version + 1
WHERE "variantId" = $v AND "companyId" = $c AND "onHand" - reserved >= $q
RETURNING "onHand", reserved;           -- 0 แถว = ของไม่พอ

-- ยืนยัน (จ่ายแล้ว): หักจริงและคืนส่วนที่จอง ทำใน tx เดียวกับเปลี่ยน hold HELD → COMMITTED
UPDATE "inventoryBalances" SET "onHand" = "onHand" - $q, reserved = reserved - $q, version = version + 1
WHERE "variantId" = $v AND "companyId" = $c AND reserved >= $q;

-- คืน (หมดเวลา/ยกเลิก): เฉพาะ hold ที่ยัง HELD เปลี่ยนสถานะแบบมีเงื่อนไขก่อน แล้วค่อยลด reserved
UPDATE "inventoryHolds" SET status = 'RELEASED' WHERE id = $h AND status = 'HELD';   -- 1 แถว จึงทำต่อ
```

- ทุกขั้นเขียน movement ที่มี `operationKey` เช่น `hold:<holdId>` / `commit:<holdId>` / `release:<holdId>` ทำให้การทำซ้ำไม่เปลี่ยนยอด
- ล็อกตามลำดับเดียวกันทุกเส้นทาง (เช่น hold → balance) เพื่อกัน deadlock (บทเรียนของ Shopify)
- มีงานตรวจยอดสม่ำเสมอ: `reserved = sum(quantity ของ hold ที่ HELD)` เหมือนที่ทำกับ credit reservation
- ระบบมีแบบอย่างนี้อยู่แล้วใน `CreditReservation` (reserve, settle, release ครั้งเดียว) ใช้ pattern เดียวกันได้

### 4.5 แอดมินถาม AI เรื่องสต็อกหรือรายละเอียดสินค้า: **ยังไม่มี แนะนำใช้ pipeline เดิมซ้ำ**
- **ไม่แนะนำ:**
  - text-to-SQL เพราะต้องมี DB user แบบอ่านอย่างเดียว ตรวจ SQL ด้วย AST และจำกัดขอบเขตเพิ่ม ซึ่งเกินความจำเป็น
  - เพิ่ม tool calling ให้ provider ทั้งสามตอนนี้ เพราะต้องแก้ adapter ทุกตัว
- **แนะนำ:** ใช้ planner + `ProductSearchService` + renderer ชุดเดิม เพิ่มโหมด `audience: 'ADMIN'` ที่:
  - scope จาก `admin.companyId` (ผ่าน `forAdmin`)
  - เห็นสินค้า DRAFT/ARCHIVED ได้ตามที่ถาม และ field ที่ไม่ใช่ `aiVisible` ได้
  - เพิ่ม token `onHand`, `reserved`, `available` และ movement ล่าสุด
  - อ่านอย่างเดียว ไม่มีคำสั่งเขียน
- แนวนี้ตรงกับที่แหล่งภายนอกแนะนำ (เครื่องมืออ่านอย่างเดียวที่จำกัดขอบเขต ตัวเลขมาจาก DB) และใช้โค้ดที่มีอยู่เกือบทั้งหมด
- ใช้ `AdminChatRequest.clientRequestId` เป็น key กันซ้ำ และ billing ฝั่ง admin เดิม

### 4.6 Scale ได้ไหม: **ได้สำหรับ SME ส่วนที่จะตันก่อนรู้แล้วและแก้ได้เฉพาะจุด**

| ส่วน | ตอนนี้ | จะเริ่มช้าเมื่อ (ประเมิน ยังไม่วัด) | แก้ |
|---|---|---|---|
| LLM | 2 call ต่อ turn (สูงสุด 3) | ตลอด เป็นต้นทุนหลัก | gate ที่มีอยู่ + cache คำตอบ FAQ (มีแล้ว) |
| `plannerCatalog` | scan variant ทั้งร้านทุก turn | variant หลักหมื่น | cache (M4) |
| lexical search | `position()` + subquery ต่อแถว | สินค้าหลักหมื่น | L2 ก่อน แล้วค่อยคอลัมน์ `searchText` + pg_bigm (ทดสอบกับภาษาไทยก่อน pg_trgm ใช้กับคำไทยสั้นๆ ได้ไม่ดี) |
| aggregate | keyset 100 แถวต่อหน้าใน RepeatableRead | catalog ใหญ่ + คนถามพร้อมกัน | ย้ายเงื่อนไขราคา/สต็อก/COUNT ไป SQL |
| connection | search tx timeout 15s | หลาย turn พร้อมกัน | ดู pool และเวลาที่ถือ connection (บทเรียนของ Shopify: คอขวดจริงคือเวลาถือ connection) |
| runtime/framework | Node + Fastify | ไม่ใช่คอขวด | ไม่ต้องเปลี่ยน (Bun/Elysia/microservice ไม่ช่วย query หรือ LLM) |

ขั้นตอนที่ควรทำก่อนตัดสินใจ: seed 1k/10k/100k variant ในฐานทดสอบแยก แล้ว `EXPLAIN (ANALYZE, BUFFERS)` ทั้ง `plannerCatalog` และ lexical query

### 4.7 ใช้ซ้ำกับหลายธุรกิจ โดยเปลี่ยนแค่ preset: **ได้ มีช่องว่างเล็กน้อย**
- **เพิ่มธุรกิจ** = ไฟล์ prompt + ไฟล์ preset + 1 บรรทัดใน registry ไม่ต้องแก้ schema/search/index/validation
- **ช่องว่าง:** H1 (ร้านเดิม), M1 (หมวดต่อ field), M6 (ตรวจ key), M4 (ค่า TAGS)
- **logic เฉพาะธุรกิจที่จำเป็นจริง** มี 2 ที่ ไม่ต้องกระจายไปทั้ง codebase:
  1. rule บน meta (4.2) เป็นข้อมูลใน preset
  2. fulfillment handler ตาม `fulfillmentType` (ส่งของ, จองห้อง, นัดบริการ) ตาม order design
- **ข้อจำกัดที่ควรรู้:** ตอนนี้ field ทุกตัวเป็นระดับ variant (`catalogFields` บังคับ `scope = VARIANT`) และร้านเพิ่ม field เองไม่ได้ (ตาราง definition ถูกลบไปแล้ว) ถ้าอนาคต tenant ต้องเพิ่ม field เอง ต้องเอาตาราง definition กลับมา ซึ่งเป็นการตัดสินใจเชิงผลิตภัณฑ์ ไม่ต้องทำตอนนี้

### 4.8 ต่อยอดเป็น SaaS โดยไม่รื้อ: **ได้**
- **มีแล้ว:** `companyId` ทุกตารางของ product, composite FK `(id, companyId)` กันอ้างข้ามบริษัทที่ระดับ DB, unique `(companyId, sku)`, `(companyId, requestId)`, preset เลือกได้ต่อบริษัท, index job/vector ผูกบริษัท
- **ต้องแก้เฉพาะจุดเมื่อถึงเวลา:**
  1. หา company จาก LINE channel แทน `forLineDeployment` (M3)
  2. index worker วนทุกบริษัท
  3. ค่า AI provider/model ต่อบริษัท (ตอนนี้ `selection()` อ่าน scope `USER` ระดับระบบ)
- **ทางเลือกภายหลัง:** Postgres RLS เป็นชั้นสำรองถ้าลืมกรอง (ต้องเขียน policy ใน migration เองและตั้ง tenant ต่อ transaction) ไม่จำเป็นต้องทำตอนนี้เพราะทุก query รับ scope อยู่แล้ว

---

## 5. ความ lean: เก็บอะไร ตัดอะไร ไม่เพิ่มอะไร

**เก็บไว้ (คุ้มกับความซับซ้อน):**
- CommerceTurn + lease + slot: กัน LLM/billing ซ้ำเมื่อ LINE retry ซึ่งเกิดจริง
- Renderer แบบ token: กันตัวเลขมั่ว ซึ่งเป็นความเสี่ยงหลักของ RAG ด้านสินค้า
- Outbox ของ index: ไม่มี network ใน transaction
- Catalog command: idempotent ทุกการเขียนของแอดมิน

**ทำให้เบาลง (แก้ไม่กี่บรรทัด):**
- ส่ง `probe` ต่อแทนเรียกซ้ำ, cache scope ต่อ process (M5)
- คำนวณ `searchableValues` ครั้งเดียวต่อแถว (L2)
- cache `plannerCatalog` (M4)
- semantic/vector ปิดได้ (`PRODUCT_SEMANTIC_ENABLED=false`) สำหรับร้านที่สินค้าน้อย ไม่เสียค่า embedding และไม่ต้องรัน worker

**ไม่ควรเพิ่มตอนนี้:**
- Elasticsearch/OpenSearch: ขนาด catalog ปัจจุบันยังไม่ต้องการ และต้องดูแล sync เพิ่ม
- Agent ที่ให้ LLM เรียก tool ทำธุรกรรม: ขัดกับ order design และ OWASP LLM06
- Text-to-SQL สำหรับแอดมิน: ใช้ pipeline ค้นเดิม (4.5)
- Bun runtime / Elysia / microservice: ไม่ช่วยคอขวดที่มีอยู่ (DB, LLM)
- RLS ก่อนมี tenant ที่สอง

---

## 6. ลำดับงานที่แนะนำ

| ช่วง | งาน | ขนาด |
|---|---|---|
| **ตอนนี้** | commit ให้ HEAD compile (L5) | เล็ก |
| | apply ECOMMERCE หลัง deploy หรือ data migration (H1) | เล็ก |
| | แก้ spec/fixture ที่ยังใช้ FASHION และคืน spec ของการค้นพร้อมคำถามไทยตายตัว (H2) | กลาง |
| | unit test ตรวจ key ของทุก preset (M6) | เล็ก |
| **ก่อนเปิดให้ร้านที่สินค้าเยอะ** | แก้ลำดับกรองของ DETAIL (H3) | กลาง |
| | categories ต่อ field (M1), ค่า TAGS + cache `plannerCatalog` (M4), filter หาย (M8) | เล็ก |
| | วัด `EXPLAIN ANALYZE` ที่ 1k/10k/100k variant | เล็ก |
| **ก่อนทำ order** | migration ของ `inventoryMovements` (H4) | กลาง |
| | `InventoryHold` + hold/commit/release แบบ atomic + sweeper + งานตรวจยอด (4.4) | ใหญ่ |
| | แอดมินถามสินค้า/สต็อกผ่าน pipeline เดิม (4.5) | กลาง |
| **ตอนทำ order** | Order/OrderLine, session CHECKOUT, quick reply, payment ตาม order design | ใหญ่ |
| **ตอนทำ SaaS** | scope จาก LINE channel, index worker หลายบริษัท, AI setting ต่อบริษัท (4.8) | กลาง |
| **เมื่อจำเป็น** | rule บน meta (4.2), `searchText` + pg_bigm (4.6), RLS | กลาง |

---

## 7. สิ่งที่ไม่ได้ตรวจหรือยังไม่ยืนยัน
- ไม่ได้รัน load test, `EXPLAIN ANALYZE` หรือวัด latency จริงของ query และ LLM
- ไม่ได้รัน audit harness กับ provider จริง (fixture ยังใช้ FASHION)
- ไม่ได้ตรวจ billing/ledger ของ AI ในรอบนี้ (spec ถูกลบใน `96fbb23` ควร audit แยก)
- ไม่ได้ทดสอบว่า pg_trgm/pg_bigm ใช้กับภาษาไทยได้ดีแค่ไหน (แหล่งที่หาได้เป็นภาษาญี่ปุ่นและแบบทั่วไป)
- ไม่ได้ตรวจฝั่ง LINE ingress/delivery นอกเหนือจากส่วนที่ product ใช้

---

## แหล่งอ้างอิง
แหล่งส่วนใหญ่เป็นบทความของผู้ใช้งานจริงและผู้ขาย ไม่ใช่มาตรฐานทางการ ใช้เป็นแนวทางเปรียบเทียบ

- [fin.ai: Structured, agentic RAG for e-commerce](https://fin.ai/research/structured-agentic-rag-for-e-commerce/): แยก intent/constraint, filter-then-rank, top-K crowd-out, ตรวจสต็อกระดับ variant
- [LangChain self-query retriever (DEV Community)](https://dev.to/sreeni5018/beyond-keyword-search-how-langchains-self-query-retriever-transforms-natural-language-into-smart-4aj)
- [Shopify Engineering: Scaling inventory reservations](https://shopify.engineering/scaling-inventory-reservations): ลำดับล็อก, isolation, เวลาที่ถือ connection
- [Inventory reservation LLD: soft locks, expiry](https://www.techinterview.org/post/3233469923/lld-inventory-reservation/) และ [Flash sale oversell prevention](https://www.techinterview.org/post/3233466672/lld-flash-sale/)
- [Idempotent tool calls and agent retry safety](https://www.channel.tel/blog/idempotent-tool-calls-agent-retry-safety) และ [AI agent tool calling reliability (wikidocs)](https://wikidocs.net/blog/@datalearners/27413/)
- [OWASP Top 10 for LLM Applications 2025: practical guide (Gravitee)](https://www.gravitee.io/blog/owasp-top-10-for-llm-applications-2025-a-practical-guide) และ [Barracuda: 2025 updates](https://blog.barracuda.com/2024/11/20/owasp-top-10-risks-large-language-models-2025-updates)
- [Replacing EAV with JSONB in PostgreSQL](https://postgresweekly.com/link/8041/web) และ [JSON in PostgreSQL slides (thebuild)](https://thebuild.com/presentations/json2015-pgconfus.pdf)
- [pg_bigm (NEC)](https://jpn.nec.com/postgresql/oss_tool/pg_bigm.html) และ [pgsql thread: pg_trgm กับภาษาที่ไม่มีช่องว่าง](https://www.postgresql.org/message-id/CAHGQGwFDzxn2z3VPMi39pWUf%2BCd3ZF-s7tMyPiiKYvZPftiF5Q%40mail.gmail.com)
- [Text-to-SQL และ function calling ใน production (Towards AI)](https://pub.towardsai.net/how-i-built-a-production-ai-query-engine-on-28-tables-and-why-i-used-both-text-to-sql-and-5794d407d6ab) และ [Best practices for connecting LLMs to SQL databases](https://dev.to/rakesh_tanwar_8a7d83bc8f0/best-practices-for-connecting-llms-to-sql-databases-47pn)
- [RAG evaluation: test set, metrics and acceptance](https://wz-it.com/en/knowledge/ki/rag-evaluation/)
- [Prisma + PostgreSQL row-level security (Atlas)](https://atlasgo.io/guides/orms/prisma/row-level-security) และ [RLS for multi-tenant data (OneUptime)](https://oneuptime.com/blog/post/2026-01-25-row-level-security-postgresql/markdown)
