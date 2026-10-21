# Product RAG — Phase 2–3

อัปเดต 6 ตุลาคม 2026 ตาม [แผน implementation](impliment-product.md) เพิ่มการค้นและตอบข้อมูลสินค้าในแชต ส่วน checkout/payment ของ Phase 4 เป็นต้นไปยังทำภายหลัง

## Message flow

Menu/cancel/REGISTER/admin mute ใช้ router เดิมก่อน retrieval และไม่ส่ง registration slots เข้า planner `KnowledgeRetrievalService` เป็น entry point เดียว เมื่อเปิด Product feature และมี verified LINE thread/event จะใช้ snapshot ของ `CommerceTurn`:

1. SKU ชัดใช้ exact scoped lookup; กรณีอื่นให้ LLM วางแผน PRODUCT/KNOWLEDGE/BOTH/GENERAL พร้อม query, variant options ของร้าน ([store fields](product-attributes.md)), price range, in-stock filter, count/list/cheapest/compare/recommend
2. Product IDs/variant IDs จาก planner ต้องอยู่ใน catalog probe หรือ refs ที่แสดงในคำตอบที่ delivery ยอมรับแล้ว ห้ามเดา ID/เลือกอันดับหนึ่งแทนผู้ใช้เมื่อกำกวม
3. Exact/name/alias probe → bounded SQL lexical candidates → Thai BM25; หากจำเป็นใช้ query embedding และ ProductVector cosine candidates ผสมด้วย RRF โดยแยก similarity threshold ออกจาก rank score
4. Hydrate ACTIVE Product/active variants และ inventory ใน exact company/language scope; variant options ที่ถามทั้งหมดต้องอยู่บน variant เดียวกัน ราคา `ProductVariant.price` เป็น Decimal string; available = onHand − reserved
5. COUNT/LIST/CHEAPEST scan catalog ด้วย keyset pagination ภายใน repeatable-read transaction จึงไม่สรุปภาพรวมร้านจาก vector top-k; COUNT แยก PRODUCTS/VARIANTS
6. BOTH ค้น policy evidence ด้วย knowledge path โดยไม่ใช้ FAQ DIRECT shortcut ที่ตอบครึ่งคำถาม ถ้า query เดียวกันใช้ embedding เดียว; คนละ query ไม่แชร์ vector ผิดความหมาย
7. AiChatService ส่งไป ProductAnswerService เพื่อเรียบเรียง; renderer ตรวจ refs/coverage/allowlisted fact tokens และใส่ราคา/stock/ชื่อ/variant จาก snapshot เท่านั้น

ตัวอย่าง: “LIN-A-BK-M ราคาเท่าไร มีของไหม” exact lookup + generation; “แล้วตัวสีดำเท่าไร” planner ใช้ presented product IDs แล้ว hydrate ราคาใหม่; “เสื้อไปทะเล ส่งฟรีไหม” Product + policy; “วันนี้เหนื่อยจัง” GENERAL ไม่ค้น Product vector; candidate ไม่ชัดถามกลับและไม่ยืนยันว่าร้านไม่มีสินค้า

### Routing gate และ evidence ที่ส่งให้ LLM (ปรับ 6 ตุลาคม 2026)

ตรวจทั้ง flow แล้วพบว่า planner ถูกเรียกเกือบทุกข้อความ ทำให้ FAQ เสีย DIRECT/CLARIFY/conflict gate และ evidence ซ้ำมาก จึงปรับดังนี้

- Gate ก่อน planner (`ProductRetrievalService.routeWithoutPlanner`): event ที่เคยมี CommerceTurn ใช้ snapshot เดิมเสมอ; ข้อความใหม่ที่ไม่มี product signal (ไม่มี keyword สินค้า, ไม่อ้าง refs ที่แสดงแล้ว, ไม่มีชื่อ/alias/sku/category ของสินค้าใน catalog) จะรัน legacy knowledge ก่อน ถ้าได้ DIRECT/RAG หรือ CONFLICTING/RETRIEVAL_ERROR/MISSING_USER_INFORMATION ให้ legacy router ตอบตามเดิม ไม่มี planner/product search/CommerceTurn; ข้อความนโยบายที่ไม่มั่นใจได้ `plannerIntent=KNOWLEDGE` โดยไม่เรียก LLM; ที่เหลือ planner ทำหน้าที่แทน BUSINESS/GENERAL classifier (จำนวน call เท่าเดิม)
- Planner ตอบ KNOWLEDGE: คืนผล legacy knowledge (`plannerIntent=KNOWLEDGE`) ไม่มี product evidence ใน prompt router คง DIRECT/CLARIFY/conflict handoff และข้าม classifier รอบสอง (มีหลักฐาน → ANSWER_KNOWLEDGE, ไม่มี → CONTACT_ADMIN)
- Commerce scope ไม่ชัด (หลายบริษัท/ไม่มีบริษัท) หรือ ownership ไม่ตรง: log แล้วใช้ legacy route ไม่ทำให้ทุกข้อความล้ม; lease ชนกันยัง throw เพื่อ retry
- ค้นสินค้า: ตัดคำถาม/คำลักษณนาม/คำสุภาพ/ตัวเลข และสี/ไซส์ที่ planner แยกแล้วออกจาก subject terms (`product-terms.ts`); DETAIL ตัดสินค้าที่ไม่มี variant ตรง options/filters ออกก่อน ("เสื้อเชิ้ตผ้าลินิน") แล้วเลือกสินค้าที่ชื่อ/alias/sku/category ครอบคลุม subject terms มากกว่าอย่างเคร่งครัด เสมอกันให้ถามกลับ; prose ใน description ไม่ทำให้เป็นผู้ชนะ; BM25 ใช้ subject terms เดียวกัน
- ไม่มี subject (ไม่มี IDs/terms/vector candidates): ถ้าไม่มีข้อจำกัดเลย ("ราคาเท่าไร") คืน `MISSING_INPUT` เพื่อถามกลับ ไม่ยิง lexical SQL และไม่ส่งแอดมิน; ถ้ามีข้อจำกัด (category/options/filters/ราคา/พร้อมส่ง) scan catalog ตามข้อจำกัดนั้น
- `ambiguous` จาก planner ถามกลับเฉพาะเมื่อเหลือ candidate มากกว่าหนึ่ง สินค้าที่ระบุชื่อชัดแต่ไม่ระบุ variant ตอบทุก variant ของสินค้านั้น
- COUNT/LIST/CHEAPEST: ต้องตรง subject ทุกคำใน identity fields ("รองเท้าที่ถูกที่สุด" ไม่คืนเสื้อ, "หมวกกันน็อก" ไม่คืนหมวกแก๊ป); category ที่ตรงกับ category ของร้านจับคู่แบบ exact (case-insensitive, "shirt" ไม่รวม "t-shirt") และ planner ไม่ใส่คำประเภทนั้นซ้ำใน query ส่วน category อิสระยัง match แบบ contains กับ category/name/alias; ผลเป็นศูนย์คืน NO_MATCH ไม่ตอบว่า "มี 0 รายการ"
- Answer grounding (`product-answer.grounding.ts`, generic ทุก business): สินค้าที่ตอบต้องแสดงราคาทุกค่าที่ต่างกันของ variants หรือ `{{eN.priceRange}}` (ยกเว้น CHEAPEST); ถาม ATTRIBUTES/DESCRIPTION ต้องใช้ token `attr.*`/`attributes`/`description`; prose นอก token ห้ามระบุค่า option ของร้าน (จาก evidence และค่า/aliases ที่ field ประกาศ) ยกเว้นค่าที่ลูกค้าเลือกหรือเป็นคำในชื่อสินค้า ไม่ผ่านแล้ว fallback เป็นคำตอบจาก DB ซึ่งแสดงรายละเอียดเมื่อถาม ข้อจำกัด: คุณสมบัติที่แต่งขึ้นใหม่ใน prose โดยมี attr token ครบแล้วยังตรวจ deterministic ไม่ได้
- ตัวเลือกสินค้า: เทียบแบบ canonical ตาม field ของร้าน (เดิมเฉพาะสี/ไซส์ ตอนนี้ generic ดู [store fields](product-attributes.md)); ถ้ารู้สินค้าแต่ไม่มี variant ที่ถาม คืน `VARIANT_UNAVAILABLE` พร้อมค่าที่มีจริงต่อ field แทนการถามว่า "สินค้ารุ่นไหน"
- คำถามรายการทั่วไป เช่น "มีเสื้อไรบ้าง" ไม่กรองเฉพาะสินค้ามีสต็อก แม้ planner จะตั้ง inStockOnly เอง ระบบตัดเงื่อนไขนั้นก่อนบันทึก plan; กรองสต็อกได้เมื่อคำถามขอของที่มีสต็อก/พร้อมส่งจริง สินค้าสถานะ ACTIVE ที่สต็อกศูนย์ยังแสดงในรายการ โดยสถานะสต็อกอ่านจาก DB
- คำถามจำนวนคงเหลือใช้ DETAIL/asks=STOCK ไม่ใช้ COUNT: evidence อ่าน onHand/reserved และ availableStock=onHand-reserved จาก InventoryBalance หลังบ้านเลือก `stockQuantitySource` จากข้อความลูกค้าเดิม (ไม่ใช่คำค้นที่ LLM ย่อ) เป็น AVAILABLE หรือ ON_HAND เมื่อระบุในคลัง/ในโกดัง แล้วส่ง stockQuantity กับ stockQuantityLabel ให้ answer model ใช้ token stockQuantity เดียว ศูนย์เป็นค่าจริง ส่วนไม่ติดตามสต็อกหรือไม่มี balance เป็น null ไม่เดาจำนวน
- Evidence ระบุ category และ aliases จาก Product เสมอ เพื่อให้ answer model ตรวจประเภทของสินค้าที่ชื่อเป็นภาษาอังกฤษได้โดยไม่ต้องเปิดเผยรายละเอียดที่ลูกค้าไม่ได้ถาม คำถามว่าร้านมีสินค้าประเภทนั้นหรือไม่ตอบจากรายการ catalog ได้ ส่วนการพร้อมขายใช้ stockStatus เมื่อถามสต็อก
- Evidence ใหม่ที่ส่งให้ answer model: จัดกลุ่มต่อ Product (ชื่อ/category/aliases/description ครั้งเดียว) แต่ details เช่น material อยู่ในแต่ละ variant พร้อม options, ราคา/ราคาเดิม/ส่วนลด, stockStatus, onHand/reserved/availableStock และ fetchedAt เฉพาะฟิลด์ `aiVisible` ของ business ที่เลือก `productFieldPolicy` คุม token ที่อนุญาตให้แสดงตามคำถาม แม้ model มี context ครบ; snapshot เก่าที่ไม่มี businessType คง projection เดิมเพื่อ replay
- BOTH ที่ไม่พบ policy evidence: ตอบส่วนสินค้าจาก evidence แล้วแจ้งว่าเงื่อนไขของร้านยังไม่มีข้อมูลยืนยัน แทน fallback ทั้งคำตอบ

## LLM 1–3 calls

นโยบายเต็มอยู่ใน [แผน §7](impliment-product.md#นโยบายจำนวน-llm-calls-ของ-product-feature-แก้ตาม-requirement-6-ตุลาคม-2026): ปกติ 1 ครั้งสำหรับ exact SKU หรือ 2 ครั้งสำหรับ planner + answer สูงสุด 3 เฉพาะ critical correction ของ BOTH/COMPARE/ราคา+stock เมื่อ output ไม่ผ่าน validation ไม่วน repair และไม่ใช้ third call กับ small talk/provider failure/หลักฐานไม่พอ

`CommerceLlmCall` เก็บ request ก่อน provider call, pinned provider/model, stable billing operation key, result, slot และ ordinal CHECK ordinal<=3 และ ordinal=3 ต้องเป็น CRITICAL_REPAIR ข้อผิดพลาด/invalid outputs ก็นับ slot นี้ Replay ของ event เดิมใช้ result/snapshot เดิม; turn ใหม่ hydrate facts ใหม่

Text generation ทุกครั้งผ่าน UsersAiProviderService/AiBillingService เดิม โดยเพิ่ม optional pinned selection/key และ budget hook ที่ไม่รันซ้ำเมื่อ billing replay ผล settled ไม่มี provider call ภายใน DB transaction Query/document embeddings ยังผ่าน EmbeddingService และ scopeKey แยกกัน ไม่นับ embeddings ในเพดาน text-generation 3 ครั้ง

## Indexing และ recovery

ProductVector ใช้ vector(1536), model และ searchRevision มี HNSW cosine index ProductIndexJob เป็น durable DB outbox: catalog create/searchable mutation commit job/document/hash กับ Product transaction เดียว ราคา/stock-only ไม่สร้าง index job

Document มี sku/name/aliases/description และ field ที่ร้านตั้ง `searchable` (พร้อม label) ของสินค้าและ active variants ไม่มีราคา/inventory/PII Description ตัดข้อความที่อ้างราคา/stock และ redact PII Hash เรียง variants ให้ deterministic

Implementation ใช้ bounded DB poller ทุก 5 วินาทีใน ProductSearchModule แทน Redis dispatch อีกชั้น: claim job ด้วย CAS + lease, embed นอก transaction, lock Product แล้ว recheck revision/hash/owner ก่อน upsert Old revision เป็น SUPERSEDED, archive/deactivation/model mismatch ถูกกรองตั้งแต่ search Retry/backfill ใช้ job/key เดิม กรณี uncertain billable result quarantine FAILED/PENDING_AI_USAGE เพื่อ review

Poller resolve deployment company แบบ singleton และ exact tenant scope ก่อนอ่าน/คิดเครดิต; ไม่ scan/bill ข้ามบริษัท startup เมื่อมีหลายบริษัท fail closed เช่นเดียวกับ LINE scope ปัจจุบัน

Admin JWT owner/admin/dev APIs เพิ่ม:

- GET `/api/admin/products/index/status`: สถานะ jobs/model ของบริษัทตนเอง ไม่คืน documents/raw errors/provider costs
- POST `/api/admin/products/:id/reindex`: `{requestId, expectedVersion}` เป็น idempotent command สำหรับ enqueue/retry job เดิม; billing pending ต้อง review ไม่สร้าง key ใหม่หนี reservation

## Business search flow (12 ตุลาคม 2026)

อ่าน `Company.productBusinessType` → เลือกฟิลด์และ prompt ของ preset ผ่าน `catalogFields`/`loadCatalogFields` → planner ของ business นั้นแปลงข้อความเป็น subject/options/filters → `ProductSearchService.search` ค้น Product + active Variant ใน company/language scope → match เงื่อนไขบน variant เดียวกัน → hydrate ราคาและ inventory จาก DB → evidence ระบุ businessType → `ProductAnswerService` เลือก answer prompt จาก businessType ใน snapshot

ค่าฟิลด์ทุกธุรกิจอยู่ใน `ProductVariant.meta` (ไม่มีตารางรายละเอียดรายธุรกิจตั้งแต่ 20 ตุลาคม 2026)

| Business | กติกาตัวเลือกและเงื่อนไข |
| --- | --- |
| ECOMMERCE | color/size เป็นตัวเลือก; brand/model/material/origin เป็น EQ/CONTAINS; features ใช้ CONTAINS; weight_g ใช้ EQ/GTE/LTE |

Planner รับเฉพาะ storeFields/storeOptions ของ business ที่เลือก พร้อม type/operators/unit/aliases/ค่าจริง ฟิลด์นอก preset หรือ operator ผิดถูกปฏิเสธ `filters` เป็น `{key, operator, value}`; เงินและสต็อกยังใช้ minPrice/maxPrice/inStockOnly ของเดิม Query มีเฉพาะ subject ได้ และคำถามมีเพียง field constraints จะ scan catalog แบบ keyset เพื่อกรองจริง

Schema ที่ส่งให้ planner และใช้ตรวจ output คือ `productPlannerSchema` ซึ่งไม่ประกาศ `stockQuantitySource` ฟิลด์นี้อยู่เฉพาะ `productPlanSchema` สำหรับแผนภายใน/การ replay และถูกกำหนดหลังบ้านจากข้อความจริง การส่ง optional field นี้เข้า OpenRouter/OpenAI พร้อม `strict: true` ทำให้ผิดข้อกำหนด required ทุก property และ request ถูกปฏิเสธได้

SQL lexical อ่าน `variant.meta` เฉพาะ key ของ preset ที่เลือก Ranking ใช้ Thai BM25 + RRF เดิม ไม่ใช่เปอร์เซ็นต์ความมั่นใจ Semantic fallback ยังอ่าน ProductVector ที่ตรวจ model/searchRevision แล้ว hydrate facts ใหม่จาก DB; ดัชนีไม่เก็บราคา/สต็อก

กติกา match อยู่ `business-match.ts`; planner/answer rules ของแต่ละธุรกิจอยู่ใน `src/modules/products/attributes/prompts/` และผูกกับ preset ผ่าน `prompt` อ่านผ่าน `businessPromptRules` ส่วนกติกา JSON/token/grounding ใช้ร่วมกัน Preset ที่ไม่มี `prompt` ใช้ generic prompt

หาก business เปลี่ยนหลัง PLAN แต่ก่อน search จะ fail safely ไม่ใช้แผนของธุรกิจเดิมกับธุรกิจใหม่ หากเปลี่ยนหลัง retrieval คำตอบ turn เดิมใช้ business/evidence snapshot เดิม ส่วน turn ใหม่ใช้ธุรกิจปัจจุบัน ข้อมูลตารางธุรกิจเดิมคงอยู่แต่ไม่ส่งเข้า prompt ของอีกธุรกิจ Hotel catalog stock ไม่ใช่ availability ตามวัน; Restaurant ไม่รับรองความปลอดภัยผู้แพ้อาหารจาก ingredient list เพียงอย่างเดียว

การเปลี่ยนนี้ไม่แก้ schema หรือรูปแบบ embedding document จึงไม่มี migration เพิ่มและไม่จำเป็นต้อง sync DB ใหม่ การ apply business เดิมยังเพิ่ม searchRevision เพื่อ reindex เมื่อ business/categories เปลี่ยน

## Context และ replay

CommerceScope ที่ service รับเป็น `{companyId}` เท่านั้น `CommerceScopeService` คืนบริษัทที่ตรวจสิทธิ์แล้ว ส่วน `commerceDbScope()` เติม `tenantId:null` เฉพาะ query/data ของ Customer, CommerceTurn และ ProductCatalogCommand ที่ยังมีคอลัมน์นี้อยู่ เพื่อรักษา standalone partition และปฏิเสธแถว tenant อื่น Lease/heartbeat/save/provider ownership lock ใช้ขอบเขตเดียวกัน Product/Variant/index ใช้ company scope โดยตรง Fingerprint ของ catalog command คง tenantId:null เพื่อให้คำสั่งที่บันทึกก่อนเปลี่ยน type replay ได้ ไม่เปลี่ยนประวัติคำสั่งหรือข้อมูล tenant

ตรวจแก้ scope วันที่ 12 ตุลาคม 2026: build และ targeted lint ผ่าน; 13 regression checks บน disposable PostgreSQL/pgvector ครอบคลุม admin scope/customer/identity/turn lease/command replay/partition isolation/product indexing/ราคาและสต็อก DB จริง พร้อม mock provider/LINE และตรวจ schema regression แบบ mock 6 เคส รัน `npm run db:sync` บน DB แอปแล้ว: 48 migrations ไม่มีรายการค้างและ regenerate Prisma Client สำเร็จ ไม่แก้ schema หรือสร้าง migration ลบ tenant columns การเทียบ schema ทั้งโครงการยังพบความต่างเดิมนอกงานนี้ เช่น Payment และ legacy tables จึงไม่อ้างว่า current schema ทุกส่วนตรงกับ DB

Presented refs เก็บ product/variant IDs กับ delivered turn ใน bounded Redis context เดิม TTL 30 นาที ไม่เก็บราคาเป็น source of truth Ref ถูก append เฉพาะหลัง LINE delivery ACCEPTED; clear/resume-bot/reset ล้าง refs พร้อม chat context คำถาม policy แทรกคง catalog refs ส่วน GENERAL topic ใหม่ reset refs

CommerceTurn unique company/LINE connection namespace/externalEvent เก็บ redacted message/history, plan, retrieval/evidence และ final response Stage leases มี heartbeat/fence ระหว่าง processes คำตอบเกิดแล้วแต่ persist delivery ล้มใช้ saved response; provider settled แล้วแต่ local call-result write ล้มใช้ settled billing replay

ข้อจำกัดเดิมของ usage: provider acceptance ก่อน local settlement อาจเป็น unknown outcome ใช้ pending/reconciliation ไม่อ้างว่า snapshot แก้ช่องว่างนี้ทั้งหมด และยังไม่รับรอง distributed LINE conversation ordering ที่ worker เดิมใช้ memory Map แม้ Product turn/job/accounting จะ DB-safe

## Configuration และ deployment

Default ปิดทั้งหมด ไม่ได้แก้ `.env` หรือ deploy ลง DB ของแอป:

```dotenv
PRODUCT_CATALOG_ENABLED=true
PRODUCT_RAG_ENABLED=true
PRODUCT_SEMANTIC_ENABLED=true
PRODUCT_VECTOR_MIN_SIMILARITY=0.65
COMMERCE_LINE_CONNECTION_KEY=standalone-line
```

`PRODUCT_VECTOR_MIN_SIMILARITY` เป็น initial candidate floor ที่ปรับได้ ไม่ใช่ calibrated accuracy guarantee สำหรับ catalog จริง ใช้ embedding model เดียวกับ infrastructure config เดิม ต้องมี effective pricing ของ model/usage scopes และ wallet/budget พร้อมก่อนเปิด

Migration `20261006000000_add_product_rag` additive เพิ่ม productVectors/productIndexJobs/commerceTurns/commerceLlmCalls, scoped FKs/uniques/checks ไม่แก้ Decimal precision/dimensions/ledger Deploy migration + regenerate/build ก่อนเปิด flags ตาราง Product เดิมไม่ถูกแก้หรือ backfill guesses; poller lazy-backfill ACTIVE products เป็น batches

ก่อนเปิด read rollout audit AnswerPattern/MicroKnowledge ที่ซ้ำราคา/stock ของ Product และย้ายเฉพาะรายการที่ verified mapping แล้ว ใช้ flags rollback หยุด new Product calls/index polling โดยคง snapshots/jobs/usage/ledger สำหรับ audit ไม่ drop ตาราง

## Verification และพื้นที่ที่ยังไม่รับรอง

ผลตรวจ business flow 12 ตุลาคม 2026: Product/Commerce unit + integration 246 เคส และ admin-product/product-rag E2E 9 เคสผ่านบน PostgreSQL/pgvector แบบ disposable รวม migration clean/upgrade ใช้ mock AI/LINE และ reject unexpected fetch; `npm run build` และ targeted ESLint ของไฟล์ที่แก้ผ่าน ทดสอบ Fashion brand/material/color, Restaurant portion/spice/allergens, Hotel capacity/Decimal area, same-variant constraints, company isolation, business switching, full variant evidence และ stockQuantity ที่ backend เลือก

`npx tsc --noEmit --incremental false` ยังมี 4 errors ใน line-ingress audit, prompt composer test, line-admin-control และ line-conversation-order ตามรายการเดิม ไม่ได้เรียก AI/LINE จริง ไม่ใช่ผลประเมินความแม่นยำของ live model ขณะนี้ script `test:commerce` ใน package.json อ้างถึงไฟล์ runner ที่ไม่มีใน working tree; การตรวจรอบนี้เรียก Jest suites โดยตรงด้วย COMMERCE_TEST_DATABASE_URL ของ DB ทดสอบแยก

`bun run test:commerce` ใช้ disposable PostgreSQL/pgvector แยกจาก DB แอป ทดสอบ migration clean/upgrade, SQL/vector filters, revision/hash/model, live price/stock, same-variant constraints, Thai follow-up/mixed/general, critical third-call cap, cross-process leases, settled-result replay, wallet/budget/reservation/ledger และ Nest/router/processor/accepted delivery context โดย mock provider/LINE/Redis และ reject unexpected outbound

ผลตรวจ 6 ตุลาคม 2026:

- `bun run test:commerce` (หลังปรับ routing gate/evidence): 153 unit/integration + 9 HTTP/processor E2E = 162 ผ่าน เพิ่ม `product-rag-routing.spec.ts` และ `product-rag-scenarios.integration.spec.ts` (ประโยคลูกค้าจริงบน catalog ไทย 8 สินค้า) และ E2E FAQ DIRECT ที่ไม่เปิด CommerceTurn; ก่อนปรับ: 87 unit/integration + 8 HTTP/processor E2E = 95 ผ่าน; migration clean install, legacy upgrade และ Phase 1 → Phase 2/3 upgrade ผ่านบน disposable pgvector DB รวมการเปรียบเทียบราคา/stock ครบทุก variant และ COUNT/CHEAPEST ข้าม keyset page boundary
- `bun run build`: ผ่าน; Prisma client regenerate ผ่าน; `git diff --check`: ผ่าน
- Targeted ESLint ของ Products/Commerce, Product planner/answer/renderer และ Product E2E: ผ่าน ไม่ใช้ `--fix` กับไฟล์อื่น
- Regression 7 suites: 94 ผ่าน / 11 ล้ม (7 ใน knowledge-retrieval, 4 ใน core-chat-e2e audit); รันซ้ำจาก isolated source snapshot ของ `HEAD` ได้ failures/count เดิม ไม่ได้แก้ business behavior เพื่อให้ tests เก่าผ่าน
- `bunx tsc --noEmit --incremental false`: ยังมี 4 errors เดิมจาก line-ingress audit, prompt composer test, line-admin-control และ line-conversation-order; ยืนยันเหมือนกันบน `HEAD` snapshot
- Lint เมื่อรวม legacy chatbot/retrieval files ยังมี 3 errors เดิม (session stringification และ unused import) ยืนยันบน `HEAD` snapshot เช่นกัน จึงไม่อ้างว่า full-repository checks ผ่าน

ยังไม่เรียก provider จริง/live LINE ผล synthetic vectors และ mock classifier ไม่ใช่การรับรอง precision/recall ของข้อความจริง ต้องทำ opt-in representative Thai catalog evaluation ก่อนเปิดเต็มระบบ ยังไม่ได้ deploy migration หรือเปิด flags บน DB แอป

CheckoutDraft/quote/order/stock hold/payment/slip/fulfillment และ frontend dashboard เป็น Phase 4–7 ถัดไป การถามซื้อในช่วงนี้ตอบข้อมูลสินค้าได้ แต่ยังไม่สร้างรายการขายหรือแจ้งรับชำระสำเร็จ
