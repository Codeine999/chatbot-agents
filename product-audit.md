# Product feature audit — 12 ตุลาคม 2026

## ขอบเขตและวิธีตรวจ

ตรวจจาก working tree ปัจจุบัน รวมไฟล์ใหม่ที่ยังไม่ commit ไม่ได้อ้างว่าเป็นโค้ดบน production การตรวจรอบนี้เพิ่มเอกสารและชุดทดสอบ ไม่เปลี่ยน production search/prompt/schema เพื่อให้เห็นพฤติกรรมเดิมจริง

เป้าหมาย: เลือก business ของร้าน → ใช้ field/match ของธุรกิจนั้น → ค้น Product/Variant → อ่านราคา/สต็อกจริง → สร้าง evidence → ใช้ prompt ธุรกิจนั้น → ตอบตรงคำถามหรือถามเพิ่มเมื่อข้อมูลไม่พอ

ตรวจ DB แอปแบบอ่านอย่างเดียว: มีสินค้า Stussy Box Logo หนึ่งรายการ, category `t-shirt`, ภาษา `th`, Fashion สีดำ/M/new, ราคา `2500.00`, onHand=10, reserved=0, vector หนึ่งรายการ ใช้รูปแบบนี้สร้าง fixture แยก ไม่คัดลอกข้อมูลลูกค้า/admin/ledger ของร้านจริง

ชุดทดสอบอยู่ [test/product-test.mjs](test/product-test.mjs), [test/audit/product-test.cjs](test/audit/product-test.cjs), [catalog และ 40 expected decisions](test/audit/product-test-data.cjs) ใช้ Nest HTTP API จริงสำหรับ preset/product/stock/JWT/validation, PostgreSQL/pgvector และ Redis ชั่วคราว, AI API จริงผ่าน provider/billing ของแอป ส่วนข้อความเข้าใช้ HTTP adapter **เฉพาะการทดสอบ** ที่เรียก MessageProcessorService; LINE acceptance จำลอง ไม่ใช่ live webhook/LINE delivery test

ผลทดสอบจริงและข้อจำกัดสรุปท้ายเอกสาร ผลสีแดงเป็นข้อค้นพบ ไม่แก้ expected เพื่อให้ผ่าน ไม่รับรองว่าไม่มีบั๊กทุก input หรือทุก concurrent interleaving

## โครงสร้างที่ใช้งานจริง

| ส่วน | เก็บอะไร | ผู้ใช้ข้อมูล |
| --- | --- | --- |
| Company | `productBusinessType`, `productPresetCategories` | เลือก metadata, ตาราง, prompt |
| Product | name, aliases, description, category, language, status, revisions | ระบุตัวสินค้า/ประเภท/เอกสารค้น |
| ProductVariant | SKU, price, compareAtPrice, currency, trackStock, meta, active | หน่วยขายและ facts ราย variant |
| FashionVariant | color, size, condition | ตัวเลือก Fashion |
| RestaurantVariant | portion, spiceLevel | ตัวเลือกอาหาร |
| HotelVariant | bedType, maxGuests, roomArea | เตียง/ความจุ/พื้นที่ |
| InventoryBalance | onHand, reserved, version | จำนวนจริง ณ snapshot |
| InventoryMovement + ProductCatalogCommand | ผล command และ audit stock | idempotency/ประวัติ/ตรวจสอบ |
| ProductVector + ProductIndexJob | derived embedding และ outbox | semantic candidates เท่านั้น |
| CommerceTurn + CommerceLlmCall | input/plan/evidence/response และ call slots | replay, lease, AI operation keys |

อ้างอิง [schema](prisma/models/products/product.prisma), [business registry](src/modules/products/business/business-registry.ts), [presets](src/modules/products/attributes/attribute-definition.ts)

`ProductAttributeDefinition` ไม่มีตารางใช้งานแล้ว แต่ยังมี TypeScript type `AttributeDefinition` เพื่อระบุ label/type/searchable/aiVisible ของ preset ในโค้ด ไม่ใช่ข้อมูลสินค้าที่ให้ LLM ตอบ

**Business เป็นค่าระดับ Company ทั้งร้าน** ไม่มี businessType ต่อ Product ดังนั้นการ apply ธุรกิจใหม่เปลี่ยนวิธีตีความ field ของสินค้าทั้งร้าน ไม่ได้ย้ายสินค้าหรือ archive สินค้าธุรกิจเก่าอัตโนมัติ

| Business | ฟิลด์ในตารางจริง | ฟิลด์ใน Variant.meta | Prompt |
| --- | --- | --- | --- |
| FASHION | color, size, condition | brand, material, tags | fashion-prompt |
| RESTAURANT | portion, spiceLevel → spice_level | ingredients, allergens, tags | restaurant-prompt |
| HOTEL | bedType → bed_type, maxGuests → max_guests, roomArea → room_area | amenities, tags | hotel-prompt |
| ELECTRONICS | — | brand, tags, warranty, color, storage | general-product-prompt |
| FOOD | — | brand, tags, ingredients, allergens, shelf_life, flavor, net_weight | general-product-prompt |
| BEAUTY | — | brand, tags, skin_type, shade, volume | general-product-prompt |
| GENERAL | — | brand, tags | general-product-prompt |

จึงมี prompt เฉพาะธุรกิจเพียง **3 ธุรกิจ** ปัจจุบัน อีก 4 ใช้ generic prompt พร้อม field allowlist ของตัวเอง ถ้าข้อกำหนดคือทุก business ต้องมี prompt คนละไฟล์ ยังไม่ครบตามนั้น

## Flow 1: เปิดธุรกิจ / เปิดฟอร์ม

1. [ProductAttributeController.applyPreset](src/modules/products/attributes/product-attribute.controller.ts) รับ `POST /api/admin/products/attributes/presets/:type/apply`, JWT owner/admin/dev, body `{}` หรือ `{categories:[]}`; ไม่มี body จะไม่ผ่าน Zod
2. `scope()` → [CommerceScopeService.forAdmin](src/modules/commerce/commerce-scope.service.ts) ตรวจ company; feature ใช้ **PRODUCT_ENABLED**, PRODUCT_RAG_ENABLED, PRODUCT_SEMANTIC_ENABLED
3. [ProductAttributeService.applyPreset](src/modules/products/attributes/product-attribute.service.ts) validate type/body, generate requestId ถ้าไม่ส่ง → [ProductCommandService.execute](src/modules/products/product-command.service.ts)
4. `execute()` ตรวจ actor, hash canonical input, advisory lock company/requestId, replay ผลเดิม หรือ reject requestId เดิมคนละ payload
5. `lockProductPreset(exclusive)` กัน create/update ใช้ fieldset ระหว่างเปลี่ยน preset → update Company → เพิ่ม searchRevision ของ Product เมื่อ type/categories เปลี่ยน
6. คืน field metadata + `storage.object/field`; frontend ต้องใช้ response นี้วาดฟอร์มเอง ไม่มี frontend ใน repo ที่ audit นี้ตรวจยืนยัน
7. ไม่ ALTER TABLE ขณะ apply; typed tables ถูกสร้างด้วย migration แล้ว ไม่สร้าง Product/Variant หรือเติมค่าที่ว่างให้อัตโนมัติ
8. `list()`/`presets()` → [catalogFields/loadCatalogContext](src/modules/products/search/catalog-fields.ts) ใช้ BUSINESS_PRESETS ใน code เป็น metadata source

ข้อดี: config ของฟอร์ม/search/evidence มาจาก preset เดียวกัน, มี transaction/locks, switch invalidates vector revisions อย่างถูกทิศทาง

## Flow 2: เพิ่ม/แก้ไข/ลบสินค้าและสต็อก

อ้างอิง [controller](src/modules/admin/product/admin-product.controller.ts), [admin wrapper](src/modules/admin/product/admin-product.service.ts), [DTO](src/modules/products/dto/product.dto.ts), [ProductService](src/modules/products/product.service.ts)

1. `POST /api/admin/products` → controller validation/scope → AdminProductService.create → ProductService.create → commands.execute
2. shared preset lock → โหลด definitions → ตรวจ compareAtPrice ด้วย Decimal → insert Product
3. แต่ละ Variant: `coreVariant` แยก relation input; `checked`/`validateAttributeValues` ตรวจ meta + normalized typed fields → insert ProductVariant
4. [saveBusiness](src/modules/products/variant-business.ts) ตรวจ relation ตรงธุรกิจที่เลือก, upsert typed row ด้วย composite company FK, ลบ canonical physical keys ออกจาก JSON ที่เพิ่งเขียน ป้องกันข้อมูลสอง source
5. ถ้า trackStock=true สร้าง balance=0; หากไม่ส่ง variants ระบบสร้าง default variant SKU `V-<requestId>` ราคา null
6. semantic เปิดอยู่ → `enqueueProductIndex` ใน transaction เดียวกัน; ไม่มี network/provider ใน transaction
7. `catalogView()` serialize Decimal/Date, คำนวณส่วนลดและ available, คืนทั้ง relation และ merged meta สำหรับ admin
8. `PATCH product`: expectedVersion เทียบ revision; field ที่มีผลค้นเปลี่ยนจึงเพิ่ม searchRevision/enqueue
9. `POST/PATCH variants`: lock parent, ตรวจ product/variant version, validate business fields, update revisions; ราคาที่เปลี่ยนอย่างเดียวไม่ต้อง re-embed
10. เปลี่ยน trackStock เมื่อ reserved>0 ถูก reject; เปิด tracking ใหม่สร้าง balance เมื่อไม่มี; ปิดไม่ได้ลบ movement/history
11. `DELETE product` เป็น archive ผ่าน update ไม่ hard-delete จึงเก็บ commands/stock history และกรองออกจาก search
12. `POST .../stock-adjustments` → [InventoryService.adjust](src/modules/products/inventory.service.ts): company/product/variant scope → lock parent + balance FOR UPDATE → expectedVersion → onHand + delta → ต้องไม่น้อยกว่า reserved → update balance + append movement + command result ใน transaction เดียว

Stock ที่ตอบ: **availableStock = onHand − reserved** ทำใน backend; ราคา/ส่วนลดทำด้วย Prisma.Decimal; เงิน API เป็น decimal string; stock เป็น PostgreSQL Int ไม่ให้ LLM บวก/ลบ

การ retry create/apply ที่ไม่ส่ง requestId/Idempotency-Key จะสร้าง UUID ใหม่ทุกครั้ง จึง **ไม่ deduplicate network retry อัตโนมัติ** frontend ควรสร้าง Idempotency-Key หนึ่งค่าต่อหนึ่งการกดและ reuse ตอน retry

## Flow 3: สร้างและรักษา embedding

อ้างอิง [document](src/modules/products/search/product-document.ts), [outbox](src/modules/products/search/product-index-outbox.ts), [index service](src/modules/products/search/product-index.service.ts), [vector repository](src/modules/products/search/product-vector.repository.ts)

1. `enqueueProductIndex`: อ่าน Product/variants/business, build stable document → contentHash → unique `(productId, searchRevision, embeddingModel)`
2. `buildProductDocument`: name/aliases/category, description ที่ตัดประโยคราคา/stock, active variants SKU + searchable label/value ตาม selected business; ไม่ใส่ price/onHand/reserved columns
3. `onModuleInit` เริ่ม poll ทุก 5 วินาที; `tick` resolve singleton company, backfill missing jobs ครั้งละ 20, claim/process ครั้งละไม่เกิน 10
4. `process`: CAS claim lease → ตรวจ ACTIVE/revision/model → embedDocument **นอก transaction** ผ่าน billing → lock parent → re-read hash/revision → upsert vector ถ้ายัง fresh
5. เปลี่ยน revision ระหว่าง embed → SUPERSEDED; timeout/crash → lease reclaim; failure exponential retry ไม่เกิน 5 attempts; pending billable usage → FAILED/PENDING_AI_USAGE ไม่ยิงซ้ำแบบสุ่ม
6. `ProductVectorRepository.search` กรอง company/language/status/model/revision + มี active variant ก่อนใช้ cosine candidate top20
7. apply ธุรกิจเพิ่ม revision ทำให้ vector ธุรกิจเก่าถูกตัดทันที; semantic จะกลับมาเมื่อ poller สร้าง index ใหม่ ส่วน SQL search ใช้ข้อมูลปัจจุบันได้ก่อน

ราคาและสต็อกใหม่ไม่ต้องรอ embedding เพราะ hydrate จาก DB หลัง match ทุก turn ใหม่ ส่วน replay event เดิมตั้งใจใช้ snapshot เดิม

## Flow 4: ข้อความลูกค้า → planner

1. เส้น production: LINE raw signature/webhook queue → [LineEventsProcessor](src/modules/line/line-events.processor.ts) → [MessageProcessorService.process](src/modules/events/message/message-processor.service.ts)
2. `process` เช็ก persisted delivery ก่อน → save incoming → load bounded context → [ChatbotService.handleTextMessage](src/modules/chatbot/chatbot.service.ts)
3. mute/empty/length/session/menu/cancel/registration ตามของเดิม → [IntentRouterService.resolve](src/modules/chatbot/intent-router.service.ts) → [KnowledgeRetrievalService.retrieve](src/modules/chatbot/knowledge/knowledge-retrieval.service.ts) เป็น retrieval entry point เดียว
4. `retrieve` cache promise ของ legacy retrieval ต่อ turn แล้วเรียก [ProductRetrievalService.retrieveProduct](src/modules/chatbot/knowledge/product/product-retrieval.service.ts)
5. feature/context ไม่ครบ หรือ exact policy question บางแบบ → legacy; singleton scope ไม่ชัด → fail closed
6. history ล่าสุด 6 ข้อความ, ตัด registration, redact PII; `CommerceTurn.find` ถ้าเคยมี retrieval แล้ว replay
7. `routeWithoutPlanner`: regex product/reference, exact probe, mentionsCatalog; ไม่มี signal จึงลอง legacy ก่อน ถ้า legacy confident หรือ settled safety result จะไม่เข้า product planner
8. `CommerceTurn.open/withLease` ผูก company/connection/event/member/conversation, pin provider/model และ lease ข้าม process
9. broad inquiry `สอบถามสินค้า` → deterministic MISSING_INPUT; exact SKU บางรูปประโยค → skip LLM planner; อื่น ๆ `probe` + `plannerCatalog`
10. `plannerCatalog` ส่ง businessType, searchable+aiVisible field key/label/type/operators/unit/aliases, ตัวอย่างค่าจริงสูงสุด 30 ต่อ field, categories สูงสุด 50
11. [buildProductPlannerPrompt](src/modules/chatbot/knowledge/product/utils/prompt/product-prompt.ts) = business planner rules + shared JSON contract + probe สูงสุด10 + delivered refs + field metadata
12. `turns.call(PLAN)` → shared provider/billing; parse **productPlannerSchema**; reject unverified product/variant IDs, unknown options/filter operators, reversed price range
13. [groundStockFilter](src/modules/products/search/product-plan-policy.ts) จำกัด inStockOnly ตามข้อความจริง และเลือก ON_HAND/AVAILABLE หลังบ้าน; stockQuantitySource ไม่ใช่ output ที่เชื่อจาก LLM
14. invalid/provider failure → failed workflow และ safe fallback ไม่แต่ง catalog facts

## Flow 5: match / scoring / การถามเพิ่ม

อ้างอิง [ProductSearchService](src/modules/products/search/product-search.service.ts), [terms](src/modules/products/search/product-terms.ts), [Thai BM25](src/modules/chatbot/knowledge/thai-bm25.ts), [business match](src/modules/products/business/business-match.ts)

### ฟังก์ชันและลำดับค้น

1. `search`: RepeatableRead transaction อ่าน business snapshot → เทียบ expectedBusinessType จาก PLAN → validate filters → `read`
2. `productContentTerms`: Intl.Segmenter Thai → ตัดคำถาม/stopwords/เลขโดด ๆ/option และ filter values ที่แยกแล้ว; จำกัด12 terms
3. `read`: ถ้ามี productIds ใช้ scoped IDs เป็น reliable; DETAIL ไม่มี IDs เรียก `probe` ชื่อ/alias/SKU; หลาย exact products → MISSING_INPUT ก่อนกรอง variant
4. CATEGORY filter เป็น contains(category/name) หรือ aliases.has ไม่ใช่ enum category equality
5. LIST/COUNT/CHEAPEST หรือ query ไม่มี subject แต่มี business `filters` → scan catalog; ถ้ามี subject ทุก term ต้องอยู่ identity fields ก่อน
6. ปกติ lexical candidate SQL ใช้ name/aliases/description/category และ searchable non-option meta/typed fields ของธุรกิจที่เลือก top60; SQL weight: name/alias hit=4, description/category/business values=1
7. เมื่อมี embedding รวม cosine top20 จาก ProductVector; hydrate candidates Product/active variants + inventory + **selected business relation** ใน snapshot เดียว
8. BM25 ใช้ variant SKUs+aliases weight4, title2, category/description/business values1 (questionExamples/intentKey ไม่มีค่าใน Product path); k1=1.2, b=0.75; IDF คำนวณบนชุด candidates ไม่ใช่ corpus ทั้งร้าน
9. RRF รวมอันดับ lexical/vector: `sum(1/(60+rank+1))`; vector เข้าลำดับเมื่อ similarity >= config ค่าเริ่มต้น0.65
10. DETAIL ที่ไม่ reliable ใช้จำนวน identity subject hits ช่วยเลือก; tie ถามเพิ่ม ไม่เลือก rank1 เงียบ ๆ; `ambiguous=true` ถามเพิ่มใน non-aggregate branch
11. เลือก DETAIL1 product หรืออื่น5 products → `evidence` กรอง variant IDs/SKU/options/filters/ราคา/stock **บน variant เดียวกัน** → จำกัด12 evidence
12. `matchesBusinessFields`: options canonical aliases; TEXT EQ/CONTAINS; NUMBER Decimal EQ/GTE/LTE; array CONTAINS/NOT_CONTAINS; ข้อมูล null/missing ไม่ผ่าน negative filter
13. requested options ไม่พบแต่ product รู้จัก → VARIANT_UNAVAILABLE พร้อมค่าจริง; COMPARE ต้องมีอย่างน้อย2 variant; ถ้าไม่พอถามเพิ่ม
14. aggregate scan keyset100, COUNT PRODUCTS นับ parent ที่มี variant ผ่าน filter, VARIANTS นับ variant; CHEAPEST เทียบ Decimal ข้ามทุก page
15. [ProductRetrievalService](src/modules/chatbot/knowledge/product/product-retrieval.service.ts) เริ่ม SQL ก่อน; semantic เปิดและไม่มี explicit productIds และ NO_MATCH/NO_RELIABLE หรือ RECOMMEND จึง embedQuery แล้ว search อีกรอบ

### ความหมายคะแนน

**score=1.000 / match=EXACT ใน log ไม่ใช่ confidence 100%** `retrieveProduct` ใส่ score1 ให้ Product evidence ทุกตัว และถ้าไม่ได้ใช้ embedding เรียก EXACT แม้ค้นจาก lexical/list/filter `identified` ใช้บอก named/reference vs candidate อีกชั้น แต่ไม่มี score explanation เก็บออกไป

RRF เป็น ranking score ไม่ใช่ probability; 0.65 เป็น cosine floor ไม่ใช่เปอร์เซ็นต์ความถูกต้อง สูตรเหล่านี้เหมาะกับการรวม candidates แต่ต้องวัดจากคำถามจริงต่อ corpus การเพิ่ม threshold โดยไม่มี evaluation อาจทำให้สินค้าถูกตัดออก

pgvector ระบุ hybrid + RRF เป็นแนวทางที่รองรับ และ ANN filtered query อาจได้ผลน้อยเพราะ filter หลัง index scan; iterative scan เป็นตัวเลือกเมื่อวัดแล้วพบ recall problem ไม่จำเป็นต้องเพิ่มระบบ search ใหม่ตอน catalog ยังเล็ก [pgvector README](https://github.com/pgvector/pgvector)

RepeatableRead ทำให้ facts ในหนึ่ง read เห็น snapshot เดียว แต่ไม่ได้ทำให้คำตอบเป็นสถานะปัจจุบันตลอดเวลา ต้องระบุ fetchedAt และอ่านใหม่ใน event ใหม่ตามที่โค้ดทำอยู่ [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)

## Flow 6: evidence → LLM → renderer → context

1. `evidence` สร้าง ref/IDs/name/category/aliases/SKU/description, details และ options จาก selected business, price/compareAt/discount Decimal strings, stock/onHand/reserved/availableStock, fetchedAt/revision
2. `trackStock=false` → NOT_TRACKED และจำนวน null; ไม่มี balance → UNKNOWN; 0 เป็นจำนวนที่ทราบ ไม่เท่ากับ null; inStockOnly รับเฉพาะ IN_STOCK
3. BOTH เรียก knowledge policy flow เพิ่ม และบังคับ grounded; policy ขาดยังตอบ product ส่วนที่มีหลักฐาน พร้อมบอกว่ายังยืนยัน policy ไม่ได้
4. AiChatService.answerKnowledge → [ProductAnswerService.answer](src/modules/chatbot/knowledge/product/product-answer.service.ts) → response replay หรือ safe branch
5. [productPromptEvidence](src/modules/chatbot/knowledge/product/product-answer.policy.ts) จัด products/variants พร้อม fields ที่ aiVisible; snapshot ใหม่ส่งข้อมูลธุรกิจเต็มเพื่อเข้าใจบริบท แต่ `productFieldPolicy` จำกัด token ที่แสดงตามคำถาม
6. [businessPrompt](src/modules/chatbot/knowledge/product/utils/prompt/business-prompt.ts) เลือก Fashion/Restaurant/Hotel จาก businessType ของ retrieval snapshot ไม่อ่าน Company ใหม่ระหว่างตอบ; contract JSON/grounding/token ใช้ร่วมกัน
7. `selectedStockQuantity` เลือกจำนวนในคลังหรือพร้อมขาย **ก่อน LLM**; model ได้ `stockQuantity` และ label ไม่ต้องคำนวณ
8. ANSWER JSON → `renderProductAnswer`: schema/citations/token allowlist/price-stock coverage/compare/count/options coverage → แทนค่า token ด้วย DB facts → reject raw numeric/stock claims หลายรูปแบบ
9. invalid format และเป็น PRICE+STOCK/BOTH/COMPARE → CRITICAL_REPAIR ได้อีกหนึ่ง slot; limitรวม3 calls; provider fail ไม่ retryแบบสุ่ม; explicit INSUFFICIENT_CONTEXT ไม่ repair
10. render ไม่ผ่าน → safeProductAnswer; evidence ไม่พอ → clarify/not found/fallback ตามสถานะ; persisted response ใช้ retry event เดิม
11. `presentedProductRefs` เก็บเฉพาะ variant ที่แสดงจริง → simulated/production delivery ACCEPTED จึง append context; follow-up ใช้ refs หาใหม่ ไม่ใช้ราคาเก่าเป็น truth

Hotel stock คือ catalog quantity **ไม่ใช่ห้องว่างตามช่วงวัน**; Restaurant ingredient/allergen facts **ไม่ใช่การรับรองไม่มีการปนเปื้อน** prompt ของสองธุรกิจเขียนขอบเขตนี้แล้ว

## ประเด็นจากการอ่านโค้ดที่ต้องจัดการ

### A01 — P1: เลือก product ก่อนใช้ variant constraints อาจถามเพิ่มทั้งที่ระบุพอ

`read()` คืน MISSING_INPUT เมื่อ probe เจอหลาย product ก่อนเรียก `evidence` เช่นหลายเสื้อแชร์ alias เสื้อยืด แต่ถามสีครีม/L ที่มีตัวเดียว ระบบยังถามเลือกรุ่นได้ ใน non-exact branch ก็เลือก leaders ก่อนกรอง business/ราคา/stock จึงเกิด false ambiguity ได้ แนวทางเล็กสุด: hydrate candidates แล้วใช้ eligible variants กรองก่อนตัดสิน ambiguity โดยยังไม่เลือกตัวแรกเงียบ ๆ

### A02 — P1: price-only / option-only query บาง operation ไม่ scan

`allCatalogOperation` ครอบคลุม LIST/COUNT/CHEAPEST หรือไม่มี terms+มี filters แต่ไม่ครอบคลุม options/minPrice/maxPrice/inStockOnly เมื่อ planner ส่ง DETAIL/RECOMMEND และ query ว่าง candidate SQL=false ทำให้ NO_MATCH ทั้งที่มีของตรงเงื่อนไข ต้องใช้ search domain ของ constraints จริง ไม่ขึ้นกับการเดา operation ว่าต้องเป็น LIST เท่านั้น

### A03 — P1: เปลี่ยน business ไม่แยกสินค้าธุรกิจเก่า

apply เปลี่ยน Company metadata; `read` กรอง company/status/language แต่ไม่มีเงื่อนไขว่า variant ต้องมี selected typed relation จึงอาจได้ Stussy ใน HOTEL broad list แม้สี/ไซส์จะไม่หลุดเข้า evidence นี่เป็น **catalog membership gap** ไม่ใช่ cross-company leak ต้องกำหนด policy ชัด: archive/convert ก่อน switch หรือกำหนด business membership ระดับสินค้าเมื่อมี requirement ใช้หลาย catalog; ไม่ควร ALTER TABLE ตอนผู้ใช้กด

### A04 — P1: PATCH meta ไม่ใช่ merge ของฟิลด์ active เดิม

`checked` → `validateAttributeValues` เก็บจาก stored เฉพาะ unknown/archived keys; active keys ที่ไม่ได้อยู่ใน values ใหม่ไม่ถูก copy ถ้า PATCH แค่ `fashion.color` อาจทำให้ `meta.brand/material/tags` หาย ขณะที่ physical size/condition ยังอยู่ใน relation เนื่องจาก upsert partial ส่งผล search/index/evidence รอบถัดไป ต้องพิสูจน์และกำหนด PATCH semantics: partial merge ชัดเจน หรือ explicit replacement พร้อมชื่อ contract

### A05 — P2: ถามจำนวนสต็อก แต่ renderer อนุญาตตอบแค่สถานะ

STOCK coverage ยอมรับ stockStatus อย่างเดียว แม้คำถามคือมีกี่ชิ้น ดังนั้น DB คำนวณถูกแต่ LLM อาจตอบเพียงมีสินค้าคงเหลือ ซึ่ง renderer รับได้ ควร backend แยก `stock intent = STATUS / QUANTITY / TOTAL_QUANTITY` แล้วบังคับ quantity token เมื่อมีจำนวน ไม่ต้องเพิ่มคำสั่งคำนวณให้ prompt

### A06 — P2: ยังไม่มี aggregate stock total ที่ชัดเจน

COUNT นับ products/variants ไม่ใช่ SUM available; evidence มีจำนวนราย variant แต่ไม่มี backend stock total เมื่อถามรวมทุกสีทุกไซส์เหลือกี่ชิ้น ไม่ควรให้ LLM บวก token เอง ควรมี total ที่ backend คำนวณตาม filter + completeness ของ catalog และแยก known/unknown ไม่ถือ missing เป็น0

### A07 — P2: categories ใช้ไม่สม่ำเสมอระหว่าง index/planner/evidence

`evidence` ใช้ appliesToCategory แต่ `buildProductDocument/labelledAttributes`, `plannerCatalog`, `searchableValues` ไม่ได้กรอง category applicability ทุกจุด ฟิลด์ที่ปิดสำหรับ category อื่นจึงอาจเข้า index/planner หรือมีผลเลือก candidates ถึงแม้ final evidence ไม่แสดง ควร reuse การเลือก applicable definitions เดียวกันก่อน projection

### A08 — P2: business ยังไม่ถูก pin ด้วย revision ของ field config

PLAN pin เฉพาะ type; เปลี่ยน categories ระหว่าง plan/search แต่ typeเดิมไม่ถูก conflict guard จับ ส่วน plannerCatalog โหลด company metadata และ values/categories หลาย statement นอก snapshot เดียวกัน มีช่วงเห็น metadataเดิมกับ valuesธุรกิจใหม่ได้ ควร pin config revision/hash ของ type+categories และอ่าน planner metadata ภายใน read snapshot สั้น ๆ

### A09 — P2: follow-up บางคำเสี่ยงตกเข้า FAQ เดิม

`referenceSignal` ไม่ครอบคลุม มีกี่ชิ้น/กี่คน/พื้นที่เท่าไร/เผ็ดไหม ทั้งหมด ถ้าไม่มี productSignal/identity hit จะลอง legacy ก่อน แม้มี delivered refs หาก legacy confidently match คำสั้นผิดโดเมน product planner จะไม่ได้ทำงาน ควรใช้ refs + business-specific follow-up intents ก่อน legacy ทั้งนี้ policy-only exact shortcut ยังควรคงไว้

### A10 — P2: renderer จำกัด facts แบบตัวเลขได้มากกว่า prose

`renderProductAnswer` ตรวจ token/citations/coverage และ regex แต่ไม่ได้พิสูจน์ทุกประโยค เช่นของแท้แน่นอนหรือใส่พอดีแน่นอนที่เป็นข้อความล้วน จึงยังอาศัย prompt ใน部分นี้ การเพิ่ม regex ทุกคำไม่ใช่คำตอบระยะยาว ใช้ backend decision/allowlisted answer facts สำหรับ claim สำคัญ และ targeted adversarial tests

### A11 — P2: fallback ยังใช้ภาษาของ Fashion ร่วมทุกธุรกิจ

safeProductAnswer MISSING_INPUT แนะนำสีและขนาด; stock fallback ลงท้ายชิ้น ทั้ง Hotel/Restaurant และ fallback details/description ไม่ครอบคลุม requested facts เสมอ หาก LLM render ไม่ผ่านอาจได้คำตอบปลอดภัยแต่ตอบไม่ครบ ควรแยกข้อความ fallback/หน่วยตาม business profile และใช้ facts ของคำถามนั้น

### A12 — P2: option enumeration และ candidate budgets มีขอบเขต

evidence จำกัด12 และ safe fallback5; opts.* สร้างจาก evidence ที่ถูกตัด ไม่ใช่ทุก variant ถ้าสินค้ามีมากกว่า12 variant จะ list สี/ไซส์ไม่ครบพร้อม partial warning; probe LIMIT21 ก่อน post-filter และ planner ส่งแค่10; lexical60/vector20 ก่อนเงื่อนไข variant อาจตัดสินค้าที่ตรง constraints ออกจาก candidates ควรทดสอบ recall ตามขนาดจริงก่อนเพิ่ม limits

### A13 — P2: model text ยังมีหน้าที่ตัดสิน relevance ขั้นสุดท้าย

FOUND ไม่รับประกันว่า LLM ตอบ ANSWER; model สามารถ INSUFFICIENT_CONTEXT แล้วไป unmatched/fallback ได้ ตาม log ที่เคยพบ คะแนนแสดง1ไม่ได้บังคับ model หาก deterministic match มีข้อยืนยันเพียงพอควรมี backend answerability decision ชัดเจน แต่ไม่บังคับตอบคำถามที่ DB ไม่มี fact เช่น authenticity

### A14 — P3: metrics/documentation ทำให้อ่านระบบผิด

score1/EXACT ไม่มี match provenance, `presetVersion` ถูกตรึง1ใน DB constraint จึงไม่ใช่ business config revision; Product.active ยังมีแต่ search ใช้ status; docs บางส่วนยังใช้ PRODUCT_CATALOG_ENABLED แต่ code ใช้ PRODUCT_ENABLED; `test:commerce` และ `test:product-audit` ใน package.json ชี้ runner ที่ไม่อยู่ใน tree ผล tests เก่าจึงไม่ใช่ test suite ที่รันได้ในปัจจุบัน

### A15 — integration risk เดิม: per-user ordering ข้าม worker

[LineEventsProcessor.processQueuedJob](src/modules/line/line-events.processor.ts) ใช้ Map promise tails ภายใน process; CommerceTurn lease กันซ้ำ event เดียว แต่ไม่ serialize คนละ event ของ conversation เดียวข้าม process การเพิ่ม worker อาจทำให้ follow-up ใช้ refs เก่า ต้องทดสอบหลาย process และเพิ่ม distributed conversation sequencing เมื่อ scale ข้าม worker จริง

## สิ่งที่ทำถูกและควรรักษา

- composite company FKs, scoped services, JWT/roles, immutable commands/movements, optimistic versions + row/advisory locks
- backend Decimal pricing/discount, stock snapshot จาก DB, no price/stock columns ใน vector documents
- selected-business SQL/JS projection ใช้ registry ร่วม, ignore other typed relations ใน RAG evidence
- match options/filters ทุกข้อใน variant เดียว, null ไม่ผ่าน NOT_CONTAINS, แยก missing price/stock จาก0
- planner output validation, ID allowlist, filtered categories/language/status, no adequate evidence → safe branch
- business type snapshot เลือก answer prompt, vector revision/model gate, provider outside transaction, durable LLM slots/replay
- shared JSON/token contract + business-specific prompts เป็นโครงสร้างเหมาะสม ไม่ต้องคัดลอก entire pipeline ต่อธุรกิจ

## Test coverage และสิ่งที่ยังไม่ครอบคลุม

ชุด Fashion40 มี category/brand/material, exact name/SKU, options+aliases, same-variant mismatch, price bounds/cheapest/discount, product/variant count, stock available/onHand/zero/unknown, new stock after index, follow-ups, replay, draft/unrelated, vague question, authenticity/fit/prompt injection

ชุด business diagnostics แยก API persistence, typed field filters, planner metadata, selected prompt/evidence, switch/race guard, company isolation, stock idempotency/version/oversell และ generic presets

ไม่ใช่ exhaustive test ของ billing pricing/settlement/provider uncertainty, real LINE signatures/queue recovery/quota, frontend form, load/performance catalog ใหญ่, all concurrent interleavings หรือ date-based hotel availability ส่วนเหล่านี้เป็นขอบเขตที่ต้องมี regression suites แยก

รันซ้ำ (มีค่าใช้ AI จริง):

```bash
node --env-file=.env test/product-test.mjs --live
# เฉพาะบางคำถาม แต่ยังสร้าง fixture และรัน diagnostics
PRODUCT_TEST_FILTER='^F(09|10|34|35)$' node --env-file=.env test/product-test.mjs --live
```

Runner build source → Docker PostgreSQL/pgvector + Redis แยก → migrations → seedผ่าน API → live model → report → ลบเฉพาะ containers ที่สร้างเอง เก็บ results.json/results.md ไม่มี API keys/passwords/provider costs/ข้อมูลลูกค้าจริง

## แนวทางลดความซับซ้อนโดยไม่เพิ่ม framework

1. แยก `ProductSearchService.read` ออกเป็น candidate retrieval, variant eligibility, ranking/decision, evidence projection เป็น pure helpers ที่มี input/output ชัดเจนก่อนแยกไฟล์ตามจำนวนบรรทัด แก้ ordering ของ constraints ไปพร้อม targeted tests
2. รวม field key/type/storage/operator/prompt identity ใน registry ให้ authoritative จุดเดียว; ตอนนี้ registry/preset/Zod schema/saveBusiness มี mapping ซ้ำ เพิ่ม field ต้องแก้หลายจุด ไม่จำเป็นต้องทำ dynamic schema engine
3. แยก `attribute-definition.ts` เป็น preset data กับ value validation/formatting ชื่อ `catalog-field` สื่อว่ามาจาก code ไม่ใช่ DB definition table ที่ถูกลบแล้ว
4. `product-answer.policy.ts` แยก evidence/tokens/renderer/fallback ตามหน้าที่ แต่รักษา public contract เดิมและ legacy turn compatibility; ไม่ copy renderer ต่อ business
5. เลิกเพิ่ม regex ทีละคำเพื่อทำความเข้าใจทุกประโยค; planner รับภาษาธรรมชาติ, backendตรวจ constraints/answerability/aggregation;เพิ่ม structured diagnostics เพื่อบอกว่าผิดที่ route/plan/candidate/filter/render

## ลำดับปรับปรุงที่แนะนำ

1. แก้ข้อที่มี deterministic reproduction ก่อน: PATCH field loss, filtering ก่อน ambiguity, constraint-only retrieval, policy ของสินค้าหลัง switch
2. ทำ stock intent/aggregate หลังบ้านและบังคับ token ให้ตอบคำถามจำนวน; ปรับ safe fallback ให้ตรงธุรกิจ
3. ทำ field applicability/config revision ให้ตรงกันทั้ง planner/index/search/evidence และทดสอบสลับ FASHION→HOTEL→RESTAURANT→FASHION
4. เก็บ match provenance/เหตุผล reject และผล renderer; เปลี่ยน log label เพื่อไม่ให้ score1 ถูกอ่านเป็นความมั่นใจ100%
5. ใช้ชุด40เป็น regression baseline วัด expected decision และ final answer แยกกัน ขยาย Hotel/Restaurant live cases ก่อนเปิดจริง; tune semantic threshold หลังมี false-positive/false-negative data
6. ค่อยแยกไฟล์ตามหน้าที่ด้านบน ไม่ rewrite ทั้ง feature และไม่แยก search engine หรือ framework ใหม่ในช่วงนี้
