# Review การเปลี่ยนแปลงในบรานช์ `product` (รายบรรทัด: ทำไม)

ผู้อ่าน: ผู้พัฒนาที่จะ review หรือ merge การเปลี่ยนแปลงนี้
ขอบเขต: ไฟล์ `.ts` ที่แก้ใน `src/` และ `test/` และไฟล์ใหม่ที่เป็นโค้ด
ไม่รวม: `*lexicon*`, `*prompt*`, `.md`, `.json`, `.mjs` ตามที่ขอ

**วิธีอ่านเหตุผล:** ทุกเหตุผลอ้างจากโค้ดและคอมเมนต์ในไฟล์ หรือจาก `docs/product-action-report.md` และ `docs/audit-product.md` หากไม่มีหลักฐานชัด จะระบุว่า **(ตีความ)**

---

## 1. `src/main.ts` — CORS ของ dashboard

**สิ่งที่เปลี่ยน:** ย้ายรายการ origin ออกจากฟังก์ชันไปไว้ที่ระดับ bootstrap และเพิ่มการยอมรับ same-origin

- `dashboardOrigins` และ `isDashboardOrigin(origin)`: รวมรายการที่ประกาศไว้เดิมใน callback ให้อ่านและทดสอบง่ายขึ้น ตรรกะเดิมเหมือนเดิม (ไม่มี origin, อยู่ในรายการ, หรือเป็น Vercel preview ของโปรเจกต์)
- `isSameOrigin(request, origin)`: หน้า Swagger ที่ `/docs` ส่ง `POST`/`PATCH` จาก origin ของตัวเอง เบราว์เซอร์จะส่ง header `Origin` มาด้วย เดิม CORS จะบล็อกทั้งที่เป็น same-origin ทั้งหมด ข้อนี้ตรงกับคอมเมนต์ในโค้ด
- `delegator`: เดิม `dashboardCors` เป็น object ที่มี `origin` เป็น callback ตัวเดียว ตอนนี้ย้าย `origin` เข้าไปใน object ตอนเรียกใช้ เพื่อให้ `isSameOrigin` เข้าถึง `request` ได้ (callback ของ `origin` เดิมไม่มี request)
- `if (request.url.startsWith(APP_API_PREFIX)) return callback(null, appCors)`: เขียนเป็น early return เพื่อให้เส้นทาง app ไม่ปนกับ dashboard ตรรกะเดิม

## 2. `src/modules/channels/app/app-maintenance.service.ts` — ลบ turn สินค้าเมื่อหมดอายุ

- `import { Prisma }`: ใช้ type `Prisma.CommerceTurnWhereInput`
- `purgeProductTurns(cutoff)`: ลบ `commerceLlmCall` ก่อนแล้วจึงลบ `commerceTurn` ของห้อง APP ที่เก่ากว่า `cutoff`
  - **ทำไมต้องลบ call ก่อน:** ความสัมพันธ์เป็น RESTRICT (ดู `CLAUDE.md` §12) ลบ turn ก่อนจะ error
  - **ทำไมอยู่ใน transaction:** ทั้งสองคำสั่งต้องสำเร็จพร้อมกัน ไม่งั้น turn ค้างโดยไม่มี call หรือกลับกัน
- `purgePreviewTurns(now)`: ลบ turn ของหน้า back-office (preview) ที่เก่ากว่า 1 วัน
  - **ทำไมต้องแยก:** turn preview ไม่มี room ให้ผูกกับ `historyRetentionDays` จึงไม่มีตัวจับเวลาหมดอายุ เอกสาร `CLAUDE.md` §10–11 ระบุว่า preview purge หลัง 1 วัน
  - คอมเมนต์ระบุว่า session อยู่ 30 นาที 1 วันจึงเพียงพอ
- `productTurns: ...` ใน `report`: รวมจำนวนที่ลบไว้ใน report เดิม
- `commerceTurns: { none: {} }` ใน filter ของการลบ `channelConversation`: ห้องที่ยังมี turn สินค้าอยู่จะไม่ถูกลบ เพราะ turn ต้องผูกกับห้อง (FK RESTRICT) ถ้าลบห้องก่อนจะ error
- แก้คอมเมนต์ของ class ให้ครอบคลุม turn สินค้าด้วย

## 3. `src/modules/channels/core/channel-store.adapter.ts` — คอมเมนต์

- เปลี่ยนคอมเมนต์เดิม "No lineMemberId, so product RAG is skipped" เป็นคำอธิบายใหม่ เพราะตอนนี้ product RAG ทำงานบนช่อง App แล้ว โดยหา channel จาก prefix ของ userId และ room จาก `conversationId`
- **ไม่มีการเปลี่ยนโค้ดที่ทำงานจริง** เป็นการแก้คอมเมนต์ที่เคยผิด

## 4. `src/modules/chatbot/context/load-context.service.ts` — ซ่อม refs ที่หายไป (S3)

ที่มา: `docs/product-action-report.md` และ `audit-product.md` ระบุ S3 — `catalogRefs: []` ถูกเก็บใน Redis เป็น `{}` แล้วโหลดกลับเป็น `undefined`

- ใน `catalogRefs()` เพิ่มเงื่อนไข: ถ้าค่าเป็น object ว่าง (`{}`) ให้ถือเป็น `[]`
  - **ทำไม:** `[]` ที่ถูกล้างโดยตั้งใจ (เช่น turn ที่เป็น GENERAL) จะไม่ถูกตีความว่า "ไม่มี refs" แล้วไปใช้ refs ของ turn ก่อนหน้า
- `slotId: z.string().uuid().optional()` ใน schema ของ ref: เพิ่มช่อง `slotId` เพราะ refs ของรอบรถต้องชี้ไปที่รอบ (slot) ไม่ใช่แค่ variant `.strict()` จะปฏิเสธ key ที่ไม่รู้จัก ถ้าไม่เพิ่ม ref ที่มี `slotId` จะตกทั้งอัน

## 5. `src/modules/commerce/commerce-feature.service.ts` — `connectionKeyFor`

- เพิ่มเมธอด `connectionKeyFor(owner)` คืนค่า partition key ของ turn สินค้า:
  - LINE → `lineConnectionKey` (ค่าเดิม)
  - PREVIEW → `standalone-preview`
  - ช่องอื่น (App, Facebook) → `standalone-<channel>`
- **ทำไม:** `commerceTurn` มี unique key `(companyId, connectionKey, externalEventId)` การมี key แยกตามช่องทำให้ id ของ App กับ LINE ไม่ชนกัน ตรงกับ `CLAUDE.md` §12 (`standalone-app`, `standalone-facebook`)

## 6. `src/modules/knowledge/knowledge-retrieval.service.ts` — ซ่อมการค้นหา knowledge และส่ง entity markers

สามจุดในไฟล์นี้:

1. **เปลี่ยนชื่อ `runRetrieval` เป็น `matchKnowledgePipeline`** ทั้งเรียกและนิยาม ชื่อใหม่บอกว่าเป็นท่อหลัก (legacy pipeline) ไม่ได้เป็นแค่ "run" ไม่มีการเปลี่ยนพฤติกรรม
2. **เพิ่ม dependency `scopes` และ `prisma` แบบ `@Optional()`:** ใช้โหลด catalog context สำหรับ `entityMarkers`
   - `@Optional()` ทำให้ test ที่สร้าง service โดยไม่ส่งตัวเหล่านี้ยังทำงานได้
3. **เมธอด `entityMarkers()`:** อ่านคำที่ธุรกิจใช้นำหน้าชื่อสินค้า ("รุ่น", "เส้นทาง", "หลักสูตร") จาก lexicon ของ preset
   - ถ้าอ่าน catalog ไม่ได้ ใช้ค่า default (ECOMMERCE) และ log warning แทนการ error
   - **ทำไม:** การเติมคำถามติดตาม (follow-up) ต้องรู้ว่า "เส้นทาง กรุงเทพ" เป็นชื่อสินค้าของธุรกิจนี้ ไม่ใช่คำทั่วไป
   - ตรงกับ `BusinessLexicon.entityMarkers` ใน `attribute-definition.types.ts`
4. **ส่ง `await this.entityMarkers()` เป็น argument ที่ 3 ของ `resolveRetrievalQuery`**

## 7. `src/modules/knowledge/retrieval-query-planner.service.ts` — คำถามติดตาม (follow-up)

**สิ่งที่เปลี่ยน:** ย้าย regex ที่ผูกกับธุรกิจออกจากไฟล์นี้ และทำให้ entity markers เป็นข้อมูลที่รับเข้ามา

- `import { FOLLOW_UP, AMBIGUOUS_CONTEXT, PRIVATE_CONTEXT, SOCIAL_MESSAGE } from './utils/follow-up-patterns'`: ย้ายค่าเดิมไปไฟล์ใหม่ (regex ไม่เปลี่ยน) เพื่อให้แยกจากตรรกะการเติมคำถาม
- `import { catalogLexicon }`: ใช้เป็นค่า default ของ `entityMarkers`
- **คอมเมนต์เดิมถูกแทนที่:** "to tell rag to know about production that user wanna know price" เป็นคอมเมนต์ที่ไม่ตรงกับฟังก์ชันจริง จึงเปลี่ยนเป็นคำอธิบายที่ตรงกว่า
- **`entityMarkers` parameter (default = ECOMMERCE):** ให้ธุรกิจอื่นส่ง marker ของตัวเองได้ โดยไม่แก้ฟังก์ชันนี้
- **`markerPattern`:** สร้าง regex จาก marker ทั้งหมด แล้วจับคู่ `<marker> <ชื่อ>` แทน regex ฮาร์ดโค้ด `(?:รุ่น|model)\s+...` เดิม
  - ผลคือ "เส้นทาง กรุงเทพ" จับได้เหมือน "รุ่น A"
- `mentions()` คืน `{marker, name}` แทนแค่ชื่อ เพื่อให้ query ที่สร้างใหม่ใช้คำเดิมของลูกค้า
- **`entities` เป็น Map จากชื่อ → marker** แทน Set: ใช้คำนำหน้าที่ลูกค้าเขียนจริงตอนสร้าง query
- `const [[name, marker]] = entities` และ `${marker} ${name}`: แทนค่าเดิม `รุ่น ${entity}` ที่ตายตัว
- `escapeRegExp`: ป้องกัน marker ที่มีอักขระพิเศษ (เช่น `.`) ทำให้ regex พัง

## 8. `src/shared/channel/channel-kinds.ts` — `parseChannelUserId`

- ฟังก์ชันใหม่คือ inverse ของ `channelUserId`: รับ userId แล้วคืน `{channel, contactId}` หรือ `undefined`
- **ทำไม:** `commerce-owner.ts` ต้องรู้ว่า turn มาจากช่องไหนจาก prefix ของ userId ไม่มีค่า LINE (ไม่มี prefix)
- ตรวจ `contactId` ด้วย regex UUID (36 ตัว) เพื่อไม่ให้ id ที่ผิดรูปแบบถูกมองว่าเป็นของช่องใด
- ลูป `STORED_CHANNEL_KINDS` ตรวจ prefix ที่ไม่ว่าง เพราะ LINE ไม่มี prefix

## 9. `test/audit/chat-product-ecom.audit.ts` — แก้ชื่อ runner ในคอมเมนต์และข้อความ error

- เปลี่ยน `run-product-ecom-audit.mjs` เป็น `run-product-audit.mjs` ทั้งในคอมเมนต์และข้อความ error
- **ทำไม:** ชื่อไฟล์ที่ระบุไว้ไม่มีอยู่จริง (ดู `audit-product.md` T1 ที่บอกว่า script ชี้ไฟล์ที่ไม่มี) ข้อความ error จะช่วยผู้ใช้ไม่ได้ถ้าชื่อผิด

---

## 10. ชั้นธุรกิจ (business / attributes / dto / pricing)

### 10.1 `attributes/presets/ecommerce.preset.ts`
- import และใส่ `capabilities` กับ `lexicon` ของ ECOMMERCE เข้า preset
- **ทำไม:** เป้าหมายข้อ 4 ของ `audit-product.md` (SC1) คือให้คำศัพท์และพฤติกรรมของธุรกิจอยู่ใน preset ไม่ใช่ใน core
- ค่า lexicon ของ ECOMMERCE ถูกย้ายมาจากค่าที่ฝังใน core เดิม โดยมีเงื่อนไขว่า "ecom ไม่เปลี่ยน" (ดู `product-action-report.md` Step 1)
- ไฟล์ `ecommerce.lexicon.ts` ไม่ได้รีวิวตามที่ขอ

### 10.2 `attributes/presets/index.ts`
- ลงทะเบียน `TRANSPORT` และ `EDUCATION` ใน registry `BUSINESS_PRESETS`
- **ทำไม:** `catalogFields` / `catalogLexicon` อ่านค่าจาก registry นี้ ธุรกิจที่ไม่อยู่ในรายการจะได้ 0 field (ดู `audit-product.md` SC3)

### 10.3 `attributes/types/attribute-definition.types.ts`
- `ATTRIBUTE_SCOPES` เพิ่ม `'SLOT'`: ค่าที่เปลี่ยนตามรอบ (เช่นวันเวลา) ต้องมี scope ของตัวเอง ไม่ควรเป็น VARIANT
- `BusinessPrompt.answerTail?`: กฎเพิ่มเติมของ answer ที่แต่ละธุรกิจใส่ได้ (ตัวเลือก ไม่บังคับ)
- `AvailabilityState`: ชุดสถานะที่ลูกค้าเห็น (ว่าง/ใกล้เต็ม/เต็ม/ปิด/ไม่ทราบ/ไม่ได้ติดตาม)
- `BusinessCapabilities`: บอกว่าธุรกิจขายโดยใช้ inventory แบบไหน (stock ต่อ variant, capacity ต่อรอบ, หรือไม่มี), จะแสดงจำนวนหรือแค่สถานะ, เกณฑ์ LOW, จำนวนสูงสุดต่อครั้ง และ `slot` (horizon, cutoff, ความสด, `nextWithinHours`)
  - `nextWithinHours` คอมเมนต์ระบุว่า default 24 เพราะรอบรถถัดไปใน 24 ชม. แต่การรับสมัครการศึกษาห่างเป็นเดือน
- `BusinessLexicon`: คำศัพท์ทั้งหมดของธุรกิจ แยกเป็นกลุ่ม: ชื่อสินค้า, หน่วย, ข้อความสถานะ, ข้อความถามกลับ (`clarify`), ตารางเวลา (`schedule`), ราคา (`price`), สัญญาณคำถาม, นโยบาย, การอ้างอิง, คำที่ห้ามกล่าวอ้างสถานะนอก token, `matchMode` (SUBSTRING หรือ WORD)
  - **เหตุผลของ `matchMode`:** คอมเมนต์อธิบายว่า SUBSTRING แบบเดิมทำให้ "สี" จับ "เสีย" ได้ WORD แก้ปัญหานี้ (`audit-product.md` FB6, S1)
- `BusinessPreset.capabilities?` / `lexicon?`: optional เพื่อให้ preset เดิมที่ไม่มีค่าเหล่านี้ยังใช้ได้ (default เป็น ECOMMERCE)

### 10.4 `business/business-match.ts`
- `candidate.scope !== 'SLOT'` ใน `validateBusinessFilters` และ `matchesBusinessFields`: field ของรอบ (SLOT) ไม่ใช่ field ของ variant จึงไม่ควรถูกค้นหาเหมือน variant field (เพิ่มตาม scope ใหม่)
- `tagMatches` แทน `optionMatcher(field).matches(item, requested)` สำหรับค่า array (TAGS / MULTI_SELECT):
  - ก่อนหน้า: ใช้ equality ทั้งค่า ทำให้ "กันน้ำ" ไม่ match tag "กันน้ำ IPX4"
  - ตอนนี้: ตรงกันหรือมี `asked` อยู่ใน `stored` (หลัง normalize) แต่ไม่กลับกัน
  - `asked.length > 0` ป้องกันค่าว่างที่จะ match ทุก tag
  - **เหตุผล:** `audit-product.md` FB4 และ `product-action-report.md` ระบุ "TAGS CONTAINS ต้องเป็นสัมพันธ์แบบมี"
  - **ข้อควรระวัง (ตีความ):** `audit` F-12 ระบุว่าค่าไทยสั้นอาจ match หลาย tag เกินไป โค้ดนี้ยังไม่มีขั้นต่ำความยาว

### 10.5 `dto/product.dto.ts`
- `variantFields.maxPrice` และ `variantPatchFields.maxPrice`: เพิ่มขอบบนของราคา ค่า `null` = ราคาสุดท้ายแล้ว
- **ทำไม:** รถที่ราคายังไม่สุดท้าย (เช่น 316–416) ต้องเก็บเป็นช่วง (`docs/multiPriceTransport.md`)
- `.default(null)` ใน create: ไม่ส่งมาก็เป็นราคาเดียวเหมือนเดิม (เข้ากันได้ย้อนหลัง)

### 10.6 `product-pricing.ts`
- `VariantPrice.maxPrice?`: ฟิลด์ใหม่ใน type
- `assertProductPricing`: เรียก `assertPriceRange` ก่อน และห้ามรวม `compareAtPrice` (ราคาขีดฆ่า) กับ `maxPrice` เพราะราคาประมาณไม่มีส่วนลดให้เทียบ (คอมเมนต์เขียนไว้)
- `assertPriceRange`: ช่วงต้องมีราคาล่างและราคาบนต้องมากกว่าล่าง
- `PriceNote` / `PriceFacts` / `effectivePrice` / `envelopePrice`:
  - `effectivePrice`: ราคาของรอบใช้คู่ของรอบเองถ้ามี ไม่ผสมกับคู่ของ variant ("รอบ 350 ภายใต้ variant 316–416 = 350 เป๊ะ")
  - `envelopePrice`: ช่วงของราคาทั้งเส้นทางเมื่อไม่ถามรอบ
- `fitsBudget`: ช่วงราคาจะผ่านเมื่อ "ทับซ้อน" กับงบ ไม่ใช่ต้องอยู่ในงบทั้งช่วง เพื่อให้คำตอบเขียนว่าเป็นราคาประมาณ ไม่ยืนยันว่าอยู่ในงบ
- `formatPrice`: จุดเดียวที่แปลงราคาเป็นข้อความให้ลูกค้า ทุก token และ safe answer ผ่านที่นี่ เพื่อให้ช่วงมีหมายเหตุเสมอ
- `comparePrices`: เรียงตามราคาล่าง แล้วราคาเดี่ยวก่อนช่วง
- `DEFAULT_PRICE_WORDING`: ใช้เมื่อ lexicon ไม่มีคำของราคาเอง (ค่า default ตรงกับคำในคอมเมนต์ที่ใช้ตรวจ `certainWords`)

### 10.7 `product.service.ts`
- `maxPrice: variant.maxPrice?.toFixed(2) ?? null` ใน `catalogView`: ส่ง `maxPrice` ออกไปเป็นสตริง 2 ตำแหน่ง เหมือน `price` เพื่อให้ API ตอบรูปแบบเดียวกัน

### 10.8 `products.module.ts`
- ลงทะเบียน `ProductSlotController` และ `ProductSlotService` และ export service
- **ทำไม:** API จัดการรอบ (slot) ของ admin ต้องมี controller และ service ใน module นี้ และ export ให้ module อื่น (RAG) ใช้

### 10.9 `search/catalog-fields.ts`
- `loadCatalogContext` คืน `lexicon` และ `capabilities` เพิ่ม: เป็นทางเดียวที่ core อ่านค่าของธุรกิจ (ตาม `CLAUDE.md` §6 และ `audit-product.md` SC1)
- `catalogLexicon(type)` / `catalogCapabilities(type)`: ถ้าธุรกิจไม่รู้จัก ใช้ ECOMMERCE (ตรงกับพฤติกรรมเดิมที่ทุกร้านใช้มาก่อน)
- `businessAnswerTail(type)`: ดึงกฎเพิ่มเติมของ answer ตามธุรกิจ ถ้าไม่รู้จักใช้ ECOMMERCE
- `catalogFields`: field ที่ประกาศ `scope: 'SLOT'` คงสถานะ SLOT ส่วนที่เหลือเป็น VARIANT เหมือนเดิม
  - คอมเมนต์เดิม "scope: 'VARIANT' เขียนทับทุกตัว" (`audit-product.md` SC3) ทำให้ field ของรอบถูกเปลี่ยนเป็น VARIANT ไม่ได้

### 10.10 `search/product-index.controller.ts`
- `POST index/reindex` (`reindexAll`): ใหม่ ให้ owner และ dev reindex ทุกสินค้า
  - `requestId` (uuid) ใช้ idempotency
  - `force` default false: ไม่ re-embed สินค้าที่ index ล่าสุดแล้ว เพราะ embedding คิดเงิน
  - `@SetMetadata(ADMIN_ROLES_KEY, ['owner', 'dev'])`: จำกัดบทบาทให้แคบกว่า `@AdminGuard('owner','admin','dev')` ของ controller ทั้งหมด เพราะการ reindex ทั้งหมดคิดเงินทุกสินค้า
  - คอมเมนต์ระบุเหตุผลนี้ไว้
- `reindexAll` ยังไม่ได้ดูในไฟล์ service (ดูส่วนถัดไป)

### 10.11 `search/product-search.module.ts`
- เพิ่ม `ProductClock` เป็น provider และ export: ให้ RAG และ search ใช้เวลาเดียวกัน (`timeZone`) ตรงกับ `audit` F-09 ที่ระบุว่า timezone ของ admin กับ search ต้องตรงกัน

### 10.12 `search/product-plan-policy.ts`
- `groundAskFields(plan, askable)`: กรอง `askFields` ของแผนให้เหลือเฉพาะ field ที่ร้านอนุญาตให้ model เห็น
  - key ที่ไม่รู้จักถูกทิ้งเอง แผนทั้งอันไม่ถูกทิ้ง (ตาม `audit` AN3 และ `product-action-report` เรื่อง "askFields")
  - `[...new Set(...)]` ตัดค่าซ้ำ
  - ถ้าไม่มี `askFields` คืนแผนเดิม

### 10.13 `shared/text/thai-datetime.ts` ใหม่ / `products/time/*` ใหม่ / `products/slots/*` ใหม่
- ไฟล์ใหม่ทั้งหมดอยู่ในส่วนถัดไปของรีวิว (ดูหัวข้อ 12)

---

## 11. Product RAG — `products/rag/product-retrieval.service.ts`

### 11.1 Imports
- `DEFAULT_AI_MAX_OUTPUT_TOKENS` จาก `ai-provider.constants`: ใช้แทนค่า 900 ที่ฮาร์ดโค้ด (ดูหัวข้อ 11.7)
- `isStandalonePolicyQuestion` (ไฟล์ใหม่ `utils/policy-question.ts`): แทน regex นโยบายที่เคยฝังอยู่ในไฟล์นี้
- `groundAskFields`, `groundStockFilter`: จาก `product-plan-policy`
- `plannerSchemaFor`, `productPlanSchema`: schema ของแผนแบบมี/ไม่มีช่องรอบ (ดู `product-search.types.ts`)
- `CatalogContext`, `catalogLexicon`, `BusinessLexicon`, `matchesSignals`, `matchesWholeMessage`: ให้ไฟล์นี้อ่านคำศัพท์ของธุรกิจแทนค่าฮาร์ดโค้ด
- `ProductClock`, `plannerTimeContext`, `todayIn`: เวลาปัจจุบันของร้าน (เขตเวลา)
- `commerceOwner`: หาเจ้าของ turn จาก context (LINE / ช่อง / preview)
- `parseQuantity`, `parseThaiDateTime`: อ่านวันเวลาและจำนวนคนจากข้อความ

### 11.2 `DateSource` type
- บอกว่าวันเวลาในแผนมาจากไหน: `PARSER` (อ่านจากข้อความด้วยโค้ด), `MODEL` (model อ่าน), `PARSER_OVERRIDE` (โค้ดทับ model), `NONE`
- **ทำไม:** เก็บใน decision trace และ replay เพื่อให้ตรวจได้ว่าค่ามาจากไหน

### 11.3 `policySignal` / `productSignal` / `referenceSignal` ถูกลบ
- regex เหล่านี้ฮาร์ดโค้ดภาษาของ ECOMMERCE ("เสื้อ", "รองเท้า", "สีดำ") ตอนนี้ย้ายไปอยู่ใน lexicon ของ preset
- `audit-product.md` SC1 ระบุว่า regex เหล่านี้เป็นตัวอย่างการฝังธุรกิจใน core

### 11.4 `isBroadProductInquiry(message, lexicon)`
- เดิม regex ฮาร์ดโค้ด ตอนนี้ใช้ `lexicon.broadInquiry` ผ่าน `matchesWholeMessage`
- default เป็น ECOMMERCE เพื่อให้เรียกแบบเดิมได้

### 11.5 `SETTLED_KNOWLEDGE` ไม่เปลี่ยน
- แค่ย้ายตำแหน่งในไฟล์ ไม่มีการเปลี่ยนค่า

### 11.6 Constructor: `clock` (optional)
- `clock ?? new ProductClock()`: ใช้ค่า default ถ้าไม่ได้ inject (ทำให้ test ที่สร้างเองยังทำงาน)

### 11.7 `retrieveProduct` — ทางเข้า
- **ลบ regex นโยบายฮาร์ดโค้ด** (`/^(?:ส่งฟรีไหม|...)/`): ตอนนี้เรียก `isStandalonePolicyQuestion(message, lexicon)` หลังโหลด catalog
  - ถ้าไม่มี catalog ก็ไม่รู้ lexicon จึงโหลดก่อน
- **เงื่อนไข gate เปลี่ยน:** เดิมต้องมี `lineMemberId` และ `conversationId`; ตอนนี้ใช้ `commerceOwner(context)` ซึ่งรองรับ LINE, ช่อง, preview ("ทุก channel ที่มี durable conversation") ตาม `CLAUDE.md` §1
- `connectionKey = this.features.connectionKeyFor(owner)`: แทน `lineConnectionKey` ตายตัว (ดู `commerce-feature.service.ts`)
- `catalog = await this.products.catalogContext(scope)` ก่อน `isStandalonePolicyQuestion`: คอมเมนต์ระบุว่า "อ่านครั้งเดียวต่อข้อความ หลัง scope"
- `turns.find` / `turns.open` ส่ง `owner` และ `turnId` แยก: เลิกส่ง `context` ทั้งก้อน เพื่อให้ `CommerceTurnService` ไม่ต้องรู้จัก `lineMemberId` โดยตรง

### 11.8 `routeWithoutPlanner(..., catalog)`
- รับ `catalog` เพิ่ม เพื่อไม่ต้องโหลดซ้ำ (`audit-product.md` LT3 เรื่องงาน DB ซ้ำ)
- ใช้ `matchesSignals(lexicon.signals, ...)` แทน `productSignal.test`
- `mentionsCatalog(scope, msg, 'th', catalog)`: ส่ง catalog ไปด้วย

### 11.9 Plan: `storeFields = plannerCatalog(scope, 'th', catalog)`
- ส่ง catalog และภาษา เพื่อไม่อ่าน DB ซ้ำ

### 11.10 Plan: การจับคำถาม (asks / policy)
- `said(list)` = `matchesSignals(lexicon, list, msg)`: ใช้คำศัพท์ของ preset
- `policyWorded` คำนวณครั้งเดียว แล้วใช้ 3 ที่ (asks, `BOTH`/`PRODUCT`, `KNOWLEDGE` gate)
  - ก่อนหน้า regex ถูกเรียกซ้ำ 3 ครั้ง
- เงื่อนไข `KNOWLEDGE` เปลี่ยนจาก `!productSignal.test` เป็น `!said(lexicon.signals)` และ `!referenceSignal.test` เป็น `!said(referenceSignals)` — ตรรกะเดิมเหมือนกัน แค่เปลี่ยนแหล่งคำ

### 11.11 Planner call
- `storeAskFields: storeFields.askable`: ส่ง field ที่ model มองเห็นเข้าไปใน prompt (เพื่อให้ `askFields` มีรายการให้เลือก)
- `timeContext` เฉพาะธุรกิจที่มีรอบ (`slots`): ให้ model รู้วันนี้ตามเขตเวลาร้าน (`product-action-report` รอบ G03/G05: model เคยคำนวณวันที่ผิดเพราะไม่มีปฏิทิน)
- `responseJsonSchema: plannerSchemaFor(slots)`: schema ต่างกันตามธุรกิจ (มี/ไม่มี ช่องรอบ) แทน schema เดียว
- **`maxOutputTokens: DEFAULT_AI_MAX_OUTPUT_TOKENS`:** แทน 900 เดิม ค่านี้ยังมีปัญหาเรื่องลำดับการโหลด `.env` (ดูหัวข้อ 14)

### 11.12 Parse ผลของ planner
- `plannerSchemaFor(slots).parse(...)` ก่อน `productPlanSchema.parse(...)` — ตรวจ schema สองชั้น
- **`shownSlots` check:** `plan.slotIds` ต้องเป็นรอบที่ลูกค้าเคยเห็นแล้ว (จาก refs) ไม่งั้นโยน error "Unverified planner slot ID" — ป้องกัน model ใส่รหัสรอบที่ไม่เคยแสดง (เหมือนกติกา productIds)
- `groundAskFields(plan, storeFields.askable)`: กรอง askFields ที่ไม่รู้จัก
- `plan.mode = policyWorded ? 'BOTH' : 'PRODUCT'` แทน regex เดิม

### 11.13 `resolveWhen` (เมธอดใหม่)
- ตัดสินวันเวลาจากข้อความของลูกค้าด้วยโค้ดก่อน model
  - **ทำไม (ตีความ):** คำบอกวันเวลาของลูกค้าเป็นข้อมูลที่แน่นอนกว่าการอ่านของ model (ดู `product-action-report` §4.3 กรณี G03/G05)
- `differs` บันทึกว่า parser ทับ model หรือไม่ (`PARSER_OVERRIDE`) เพื่อ trace
- ช่วงเวลากลับด้าน (`after >= before`) ถูกเปิดเป็นทั้งวัน แทนที่จะค้นไม่เจอ
- `when` ที่ว่างหมดจะกลายเป็น `null`
- `quantity` มาจาก parser ก่อน model
- ถ้ามีวันเวลาและยังไม่มี `SCHEDULE` ใน asks จะเพิ่มให้ (มีเพดาน 5)
- **ตีความ:** เพดาน 5 มาจาก schema ของ asks ที่จำกัดจำนวน (ไม่พบเอกสารยืนยัน)

### 11.14 Stored plan และ `dateSource`
- เก็บ `dateSource` ไว้ใน `turns.save('plan')` เพื่อ replay ได้ผลเดิม (`audit` ระบุ replay ต้องไม่อ่านข้อความใหม่)

### 11.15 Semantic fallback guard
- `plan.query.trim().length > 0`: แผนที่มีแต่ filter ไม่มีข้อความให้ embed; embedding ของข้อความว่างจะ throw "Cannot embed empty text" (`audit` FB4)

### 11.16 Decision trace
- ถ้าเป็นธุรกิจที่มีรอบ (`slots`) เพิ่มใน trace: `dateSource`, `when`, `quantity`, `slotOutcome` เพื่อวินิจฉัยได้ (`CLAUDE.md` §10: ทุก branch ต้อง report)

### 11.17 `routeWithoutPlanner` — เฉพาะการเปลี่ยนแหล่งคำ
- `productSignal.test` → `matchesSignals(lexicon.signals)` ฯลฯ ตรรกะเดิม


---

## 12. Product RAG — คำตอบและ guard

### 12.1 `rag/product-answer.service.ts`
- `import { isScheduleLookup, scheduleAnswer }`: เพิ่มเส้นทางตอบตารางเวลาโดยไม่เรียก LLM
- **เส้นทางใหม่ `else if (isScheduleLookup(product))`:** ถ้าเป็นคำถามตารางเวลา (เวลา/ที่นั่ง/ราคาจาก row) ตอบด้วย `scheduleAnswer` เลย
  - **ทำไม:** เวลา ที่นั่ง และราคาเป็นข้อมูลใน DB ไม่ต้องให้ model เขียน (ดู `CLAUDE.md` §13 ข้อ 4)
  - `mode = 'PRODUCT_SCHEDULE_TEMPLATE'` เพื่อให้ decision trace แยกเส้นทางนี้ออก (ดู `CLAUDE.md` §10)
  - `catalogRefs` ใส่ `slotId` ด้วย เพื่อให้ turn ถัดไปอ้างถึงรอบที่แสดงไปแล้ว
  - ถ้า policy ไม่พบ เพิ่ม `POLICY_UNVERIFIED_NOTE` ต่อท้าย
- `...(e.slot ? { slotId } : {})` ใน catalogRefs ที่สอง: ส่งรอบที่ใช้ตอบไปด้วยเหมือนกัน

### 12.2 `rag/product-answer.grounding.ts`
- `productPriceRange` รับ `wording?` และแสดงช่วงราคาผ่าน `formatPrice`
  - ต่ำสุดของราคาล่าง สูงสุดของราคาบน (ใช้ `maxPrice ?? price`)
  - ถ้ามีราคาประมาณหรือรอบที่ราคาต่างกัน เพิ่มหมายเหตุ (`BY_SLOT` / `ESTIMATE`)
  - **ทำไม:** ก่อนหน้า ช่วงราคาบอกเป็น `690–720 บาท` ไม่มีหมายเหตุ ซึ่งอาจถูกอ่านเป็นราคาสุดท้าย (`multiPriceTransport.md`)
- `priceKey(e) = price|maxPrice`: แยกราคา 316 กับ 316–416 ออกจากกัน (ถ้าใช้แค่ `price` สองแถวจะถูกนับเป็นราคาเดียวกัน)
- `coversAskedFacts`:
  - `shownPrices` ใช้ `priceKey` แทน `price` เพื่อให้ตรวจการแสดงราคาครบถูกต้องกับช่วงราคา
  - เพิ่มการตรวจ `askFields`: ถ้าคำถามระบุ field และสินค้ามีค่าของ field นั้น คำตอบต้องแสดง `attr.<key>` ของ field นั้น ไม่ใช่ field อื่น (ตามที่ `product-action-report` ระบุว่า "askFields" ต้องคุม coverage)

### 12.3 `rag/product-answer.policy.ts` (ไฟล์ใหญ่ที่สุดในกลุ่มนี้ ~720 บรรทัด diff)

**Imports:** ดึง catalog (lexicon, capabilities), slot (`scheduleAnswer`, `slotAsks`), slot-format, lexicon-match (`matchesSignals`, `proseMakesClaim`), pricing (`formatPrice`), และ type `BusinessLexicon` เพื่อให้ไฟล์นี้อ่านคำจากธุรกิจ ไม่ใช้คำฮาร์ดโค้ด

**`stockLabels` → `stockStates` + `stockLabel(lexicon, stock)`:**
- ข้อความสต็อกเดิมฮาร์ดโค้ด (`มีสินค้าคงเหลือ...`) ย้ายไป `lexicon.availability`
- map `IN_STOCK → AVAILABLE` ฯลฯ ใช้สถานะกลางเดียวกับ slot (ทำให้ธุรกิจทั้งสองแบบใช้ lexicon เดียว)

**`lexiconOf`, `priceWording`, `hasPriceNote`:**
- `lexiconOf` ใช้ `catalogLexicon(workflow.result.businessType)`; ถ้า turn เก่าไม่มี businessType ได้ ECOMMERCE (คอมเมนต์ระบุ)
- `hasPriceNote(e)` เป็นจริงเมื่อราคามี `maxPrice` หรือ `priceNote` (ใช้ตรวจว่าห้ามบอกว่าราคาสุดท้าย)

**`productFieldPolicy`:**
- `price`: เพิ่ม `asks.has('SCHEDULE')` ให้แสดงราคาเมื่อถามตารางเวลา และ `LIST`/`CHEAPEST` ที่มีช่วงราคา
- `stock`: เพิ่ม `quantity !== null` (ถามจำนวนคนต้องการข้อมูลที่นั่ง)
- `attributes`: เพิ่ม `askedFields(plan).length > 0` ให้แสดง attribute เมื่อถาม field เฉพาะ

**`askedFields` (export) และ `shownDetails` (ใหม่):**
- `shownDetails` คืนเฉพาะ detail ที่ถามถ้ามี `askFields` ไม่งั้นคืนทั้งหมดถ้าถาม attributes
- **ทำไม:** หลักการ "สิ่งที่ model เห็น = สิ่งที่ model อ้างได้" (`audit-product.md` AN1) และ `askFields` ของ `product-action-report`

**`productFactTokens`:**
- `details` ผ่าน `shownDetails` ก่อน ทำให้ token `attr.*` ที่ไม่ได้ถามไม่ถูกสร้าง
- `price: formatPrice(e, ...)` และ `priceRange: productPriceRange(..., wording)` แทนการต่อ `บาท` ตรงๆ
- `stockStatus` ใช้ `stockLabel`
- ถ้าเป็นธุรกิจ `SLOT_CAPACITY`: ลบ token ของ stock ของ variant ออก (ที่นั่งอยู่ที่รอบ ไม่ใช่ variant) — ไม่งั้นข้อความ "ไม่ทราบจำนวน" จะถูกเขียนกับรอบที่เต็มแล้ว
- ถ้ามี `slot` และ `bySlot`: สร้าง token `eN.date`, `eN.time`, `eN.arrive`, `eN.availability`, `eN.seatsLeft`
  - `seatsLeft` เฉพาะตอน `showQuantity` และสถานะไม่ใช่ `UNKNOWN`/`CLOSED` — รอบที่ไม่รู้จำนวนที่นั่งจะไม่มีตัวเลข
- token ของคำถามลูกค้า `query.date`, `query.time`, `query.quantity` และสรุป `slots.count/first/last` ถูกสร้างเฉพาะธุรกิจรอบ (ให้คำตอบพูดซ้ำเวลาที่ลูกค้าถามได้โดยไม่ต้องให้ model คิดใหม่)

**`productPromptEvidence` (สิ่งที่ส่งให้ model):**
- `moreInfo`: รายชื่อ label ของ detail ที่มีแต่ไม่ได้ส่ง ให้ model "เสนอสอบถามเพิ่มได้" โดยไม่ต้องรู้ค่า (`audit` AN1 ข้อ 4)
- `details` ของ variant ถูกส่งเมื่อ `fullSnapshot` และมีรายการ
- ราคาใช้ `formatPrice(e, ...)`
- โหมดรอบ: ส่ง `slot: { role, date, time, arrive, availability, seatsLeft }` แทน `onHand`/`reserved`/`fetchedAt`
  - **ทำไมลบ `onHand`/`reserved`/`fetchedAt`:** คอมเมนต์ระบุว่าตัวนับภายในไม่ควรถึง model (`audit` AN1 ข้อ 3)
- stock ของ variant ส่งเฉพาะธุรกิจที่ไม่ใช่รอบ
- `fields` (รายการ token ที่อนุญาต) เพิ่ม `date`, `time`, `arrive`, `availability`, `seatsLeft` สำหรับรอบ และ `attributes` จะไม่ถูกเพิ่มเมื่อถาม field เฉพาะ
- `slotOutcome`, `customerAsked`, `slotSummary` ใส่ใน evidence เมื่อเป็นธุรกิจรอบ เพื่อให้ model รู้ว่าคำถามได้ผลอย่างไร (ตรง/ไม่มีรอบที่ตรง/ไม่ใช่ช่วง)

**`unmatchedProductAnswer`:** ข้อความ "ไม่พบ/ใกล้เคียง" ดึงจาก `lexicon.clarify.unmatched` / `unmatchedNear` ไม่ฮาร์ดโค้ด (ตาม SC1)

**`slotRulesHold` (ใหม่):** กติกาคำตอบตารางเวลาของ LLM
- ทุกรอบที่กล่าวถึงต้องแสดงเวลา (`time`) และถ้าถามสถานะ ต้องแสดง availability/seatsLeft ของทุกรอบ
- ถ้า `NONE_FITS` (ไม่มีรอบที่ลูกค้าต้องการ) ต้องพูดถึงรอบที่ถามและเสนอรอบทางเลือกอย่างน้อยหนึ่ง
- **ทำไม (ตีความ จาก `product-action-report` §4.2 และ §5 เรื่องคำตอบรอบ/ที่นั่ง):** ไม่ให้ model ตอบรอบที่ไม่ตรงและบอกที่นั่งผิด

**`renderProductAnswer`:**
- `QUERY:WHEN` เป็น ref ที่อนุญาตเมื่อมี query หรือ slotSummary
- ตรวจ prose ด้วย `proseMakesClaim(lexicon, plain)` แทน regex ฮาร์ดโค้ดเดิมที่แยกจาก `/(?:ราคา\s*...|บาท|มีของ|...)/` — ตอนนี้คำศัพท์มาจาก lexicon ของธุรกิจ (SC1, S2)
- **ราคามีหมายเหตุ + ข้อความ prose ระบุว่าแน่นอน** → ปฏิเสธ (`showsNotedPrice` + `certainWords`)
  - **ทำไม:** `multiPriceTransport.md` และ `product-action-report` กติกาไม่ให้ model พูดราคาประมาณเป็นราคาสุดท้าย
  - `certainWords` ไม่ได้ปฏิเสธคำที่ใช้ปฏิเสธ เช่น "ไม่ตายตัว" — **ข้อสังเกต (ตีความ):** โค้ดยังไม่รู้ว่าเป็นการปฏิเสธ จึงปฏิเสธคำตอบที่ถูกต้องได้ (ตรงกับกรณี P04 ใน `test-case-report.md`)
- stock token ของรอบใช้ `availability`/`seatsLeft` แทน `stockStatus`
- `slotRulesHold` ถูกเรียกเมื่อมี evidence ของรอบ
- `STOCK` ของธุรกิจรอบต้องมี token ที่นั่ง (ไม่ใช่สต็อก variant)

**`presentedProductRefs`:** เพิ่ม `slotId` ใน refs ที่แสดง (เหมือน 12.1)

**`mutableFacts(..., lexicon, bySlot)`:**
- ราคาใช้ `formatPrice` (มีหมายเหตุ)
- สต็อกแสดงเฉพาะธุรกิจที่ไม่ใช่รอบ หน่วยมาจาก `lexicon.unit` แทน "ชิ้น" ตายตัว

**`detailedProductLines`:** ใช้ `detailsOf(v)` (ผ่าน `shownDetails`) แทน `v.details` ทั้งหมด และส่ง `lexicon`, `bySlot` ต่อไป

**`safeProductAnswer`:** ข้อความทุกข้อ (`MISSING_INPUT`, `UNAVAILABLE`, `notFound`, ฯลฯ) ดึงจาก `lexicon.clarify` และ `lexicon.itemNoun` แทนข้อความฮาร์ดโค้ดของร้านเสื้อผ้า
- ถ้า `slotOutcome` มีค่า เรียก `scheduleAnswer(workflow)` (ตารางเวลาแบบ 0-LLM)
- 
### 12.4 `search/product-index.service.ts`
- `MAX_BULK_REINDEX = 500`: เพดานกันการ reindex ทั้งหมดขนาดใหญ่เกินไปในคำขอเดียว
- `derivedRequestId(requestId, productId)`: สร้าง UUID v4 รูปแบบแน่นอนจาก SHA-256 ของ batch id + product id
  - **ทำไม:** `reindex` ใช้ `requestId` เป็น idempotency key ของคำสั่ง ถ้า batch ถูกลองใหม่ ต้องได้ key เดิมทุกสินค้า
- `reindexAll(...)`:
  - ตรวจ `assertCatalogEnabled` และ `productSemanticEnabled` ก่อน (ถ้าปิดจะไม่ queue งานที่ไม่มีใครทำ)
  - โหลดสินค้า ACTIVE ทั้งหมด (ไม่เกินเพดาน) เรียง id เพื่อผลที่ deterministic
  - เรียก `reindex` ทีละสินค้าโดยใช้ `derivedRequestId` และเก็บ `failed` ต่อรายการ (ไม่ fail ทั้ง batch)
  - `force`: รีเซ็ต job ที่ `DONE` เป็น `PENDING` เฉพาะ `searchRevision` และ `embeddingModel` ปัจจุบัน (เพื่อไม่ re-embed ฟรีเกินจำเป็น ถ้า searchRevision เปลี่ยน job ใหม่จะถูกสร้างอยู่แล้ว)
  - `void this.tick()`: เริ่ม poller ทันที (การทำงานจริงยังทำโดย poller เดิม)
- `reindex` (ทำงานเดิม) เพิ่ม `deleteMany` ของ job สถานะ `SUPERSEDED` ก่อน enqueue
  - **ทำไม:** คอมเมนต์ระบุว่า enqueue เดิมเก็บ row เดิมที่ `SUPERSEDED` ไว้ ทำให้ reindex แล้วไม่สร้างเอกสารใหม่ (ดูคอมเมนต์ในโค้ด)

### 12.5 `search/product-search.service.ts` (~216 บรรทัด diff)
- ลบ `loadCatalogFields` ออกจาก import และใช้ `loadCatalogContext` เป็นทางเดียว (ตาม `CLAUDE.md` §6: `loadCatalogContext` คือ gateway เดียว)
- `clock` เป็น `ProductClock` (inject หรือ `new ProductClock(config)`)
- `catalogContext(scope)`: ทางเข้าสาธารณะให้ RAG อ่าน catalog หนึ่งครั้งต่อ turn
- `probe`, `mentionsCatalog`, `plannerCatalog` รับ `catalogInput?` เพื่อไม่อ่าน DB ซ้ำ (LT3)
- `plannerCatalog` เพิ่ม `askable`: รายการ field ที่ `aiVisible` และ `scope === 'VARIANT'` ส่งให้ model เลือกเป็น `askFields`
- `searchableProductKeys` ตัด field `SLOT` ออกจาก field ระดับสินค้า (ไม่ควรค้นด้วยค่าของรอบ)
- `read()` (ใหม่) เป็นทางเข้าหลัก:
  - ถ้าธุรกิจ inventory ไม่ใช่ `VARIANT_STOCK` ปิด `inStockOnly` (เพราะสต็อกไม่ได้อยู่ที่ variant)
  - เรียก `readVariants` (ค้นสินค้าเดิม) แล้วค่อยหา slot ถ้า `wantsSlots` และพบสินค้า (หรือมี slotIds ที่ลูกค้าเคยเห็น)
  - `relaxed` plan: ลบเงื่อนไขทั้งหมดแล้วให้ `DETAIL` เพื่อหา variant ของสินค้าที่พบ (**ตีความ:** เพื่อไม่ให้ตัวกรองตัดรอบที่ควรเสนอเป็นทางเลือก)
  - `searchSlots` รับ `variantEvidence` และ `siblingVariantIds` เป็น callback เพื่อไม่ผูกกับ query ใน slot-search
- `readVariants` (ค้นเดิมที่แยกออกมา): ค่า `pageEnvelopes` / `envelopes` คำนวณเมื่อธุรกิจเป็น `SLOT_CAPACITY` เพื่อให้ราคาต่อ variant เป็นช่วงของรอบ ไม่ใช่ราคา variant
  - **ทำไม (ตีความ):** ราคาของรอบรถขึ้นกับรอบ (ดู `product-action-report` §4.1 และ §9 ข้อ 4)
- `evidence(product, plan, definitions, envelopes?)`:
  - `envelopes?` ให้ราคาช่วงของ variant เมื่อคำถามไม่ระบุรอบ (variant ที่ไม่มีรอบเปิดยังใช้ราคาของตัวเอง)
  - ตรวจงบ (`fitsBudget`) แทนเงื่อนไข `price.lt(min)` เดิม: ช่วงที่ทับซ้อนงบผ่าน (`product-pricing.ts`)
  - `CHEAPEST` ตัดเฉพาะที่ไม่มีราคาเลย
  - `price`/`maxPrice`/`priceNote` จาก `priced` (`effectivePrice` หรือ `envelopePrice`)
  - ส่วนลด (`productDiscount`) ไม่ใช้กับ envelope (ราคาช่วงไม่มีราคาเต็มเพื่อเทียบ)
  - `purchasable` ตรวจจาก `priced.price`
  - เรียงราคาด้วย `comparePrices`
- ระหว่างการค้นทั้งหมด `new Date().toISOString()` ของ `fetchedAt` ยังเป็นค่าเดิม (ไม่มีการเปลี่ยน)

### 12.6 `search/product-search.types.ts`
- `timeOfDay` และ `productWhenSchema` (date/after/before): วันเวลาที่ลูกค้าถาม รูปแบบ `HH:mm` และ `YYYY-MM-DD`
- `fieldKey` (`^[a-z][a-z0-9_]{0,49}$`): ชื่อ key ของ field ต้องเป็นรูปแบบเดียวกับ key ที่ระบบเก็บ
- `productPlanSchema` เพิ่ม operation `NEXT` (รอบถัดไป), asks `SCHEDULE`
  - `when`, `quantity`, `slotIds`, `askFields` ใช้ `.optional()` ไม่ใช่ `.default()`
  - **ทำไม:** คอมเมนต์ระบุว่า plan ที่เก็บก่อนหน้านี้และธุรกิจที่ไม่มีรอบต้องได้ shape เดิม (hash ของ planner schema ต้องไม่เปลี่ยน)
- `productPlannerSchema`: ตัด `stockQuantitySource`, `when`, `quantity`, `slotIds`, `askFields` ออก แล้ว extend ด้วยค่า default — ตาม strict JSON schema ที่ต้องการทุก property เป็น required
- `legacyProductPlannerSchema` (ใหม่): schema เดิมของธุรกิจที่ไม่มีรอบ (operation/asks ไม่มี SCHEDULE) — ให้ provider request ไม่เปลี่ยน
- `plannerSchemaFor(slots)`: เลือก schema ตามธุรกิจ
- `CatalogRef.slotId?`: ref ของรอบที่ถูกแสดง
- `SlotEvidence` (ใหม่): หนึ่งคู่ (variant, รอบ) พร้อม `state`, `seatsLeft`, `role` (REQUESTED / ALTERNATIVE)
- `ProductEvidence`:
  - `maxPrice?` และ `priceNote?` สำหรับช่วงราคา
  - `slot?` สำหรับแถวของรอบ
  - คอมเมนต์ `maxPrice` ระบุว่า evidence เก่าที่ไม่มีค่านี้ราคาถือเป็นราคาเดี่ยว
- `ProductSearchResult`: `slotOutcome` (MATCHED / NONE_FITS / NO_SLOT_IN_WINDOW / OUT_OF_WINDOW), `query` (วันเวลาที่ resolve แล้ว), `timeZone`, `slotSummary` (ตารางที่ถูกตัด)

### 12.7 `search/product-terms.ts`
- `productContentTerms(query, exclude, questionWords)`: คำถามของ business lexicon (`questionWords`) ถูกตัดเหมือนคำถามทั่วไป
- **ทำไม:** คำเช่น "ลูก" "ใบ" "ไป" ที่เป็นชื่อสินค้าในธุรกิจอื่น ถูกตัดได้เฉพาะเมื่อ preset ของธุรกิจนั้นประกาศ (`audit-product.md` SC1)

### 12.8 `search/catalog-fields.ts` (เพิ่มเติมจากหัวข้อ 10.9)
- `catalogFields`: field `SLOT` คงสถานะ SLOT ได้ — ดูหัวข้อ 10.9

### 12.9 `search/product-search.module.ts` — ดูหัวข้อ 10.11

---

## 13. ไฟล์ใหม่ (ไม่ได้รีวิวทีละบรรทัด — สรุปหน้าที่และเหตุผลจากคอมเมนต์ในไฟล์)

ไฟล์เหล่านี้เป็นโค้ดใหม่ทั้งไฟล์ (ประมาณ 1,900 บรรทัด) รีวิวโดยอ่านโครงสร้างและเมธอดหลัก ไม่ได้อ่านทุกบรรทัด ถ้าต้องการลงลึกทีละบรรทัดสามารถทำเป็นชุดถัดไป

| ไฟล์ | หน้าที่ | เหตุผล (จากคอมเมนต์และโครงสร้าง) |
|---|---|---|
| `products/rag/commerce-owner.ts` | `commerceOwner(context)`: หาเจ้าของ turn (LINE / room / preview), `ownerColumns`, `turnBelongsTo` | ให้ product RAG ทำงานได้ทุกช่อง ตาม `CLAUDE.md` §1; ความเป็นเจ้าของตรวจในฐานข้อมูลจริง (`commerce-turn.service.ts`) ไม่ใช่เชื่อ userId |
| `products/rag/utils/policy-question.ts` | `isStandalonePolicyQuestion`: คำถามนโยบายที่ถามทั้งข้อความ (เช่น "ส่งฟรีไหม") | แยกออกจาก retrieval ที่เคยฝัง regex; ใช้ lexicon ของธุรกิจ |
| `knowledge/utils/follow-up-patterns.ts` | ย้ายรายการคำจาก `retrieval-query-planner` มาเป็น array แล้วประกอบ regex | ค่าเทียบเท่าของเดิม (ตรวจแล้ว: รายการคำเดียวกัน, flag เดิม) |
| `products/business/lexicon-match.ts` | `signalMatcher` (SUBSTRING หรือ WORD), `matchesSignals`, `matchesWholeMessage`, `proseMakesClaim` | ใช้ `Intl.Segmenter` สำหรับ WORD เพื่อไม่ให้ "สี" จับ "เสีย" (`audit` FB6); memoize ตัว matcher |
| `products/slots/slot-availability.ts` | `slotAvailability`: CLOSED / UNKNOWN / FULL / LOW / AVAILABLE | ตัดสินสถานะด้วยโค้ด ไม่ใช่ model; `seatsLeft = max(0, capacity - reserved)` |
| `products/slots/slot-search.ts` | `wantsSlots`, `searchSlots`, `slotPriceEnvelopes` | ค้นรอบตามวัน/เวลา/จำนวน; ราคาช่วงของ variant จากรอบที่ยังไปได้ (aggregate เดียว) |
| `products/slots/slot-answer.ts` | `slotAsks`, `scheduleAnswer`, `departureTimetable`, `isScheduleLookup` | ตอบตารางจาก row ล้วน ไม่ใช้ LLM; ข้อความและสถานะมาจาก lexicon |
| `products/slots/slot-format.ts` | วันที่/เวลาแสดงผลเป็นภาษาไทย (เช่น "ศุกร์ 6 พ.ย.", "20:00 น.") | เวลาที่แสดงต้องเป็นเขตเวลาของร้าน |
| `products/slots/slot-time.ts` | แปลงเวลาไทย (+07:00 คงที่) และวันที่ | ประเทศไทยไม่มี DST ตั้งแต่ปี 1920 (คอมเมนต์ระบุ) |
| `products/slots/product-slot.service.ts` | CRUD รอบ, generate/bulk/patch ผ่าน `ProductCommandService` | ทุกการเขียนเป็นคำสั่งที่ idempotent ด้วย requestId และล็อกตาม `CLAUDE.md` §13 ข้อ 7 |
| `products/slots/product-slot.dto.ts` | schema ของการสร้าง/แก้รอบ, ราคาต่อรอบเป็นคู่ (price / price+maxPrice / null) | คู่ราคาตรงกับ `product-pricing.ts`; จำกัด `MAX_SLOTS_PER_COMMAND = 1000` |
| `products/slots/product-slot.controller.ts` | `api/admin/products/:id/variants/:variantId/slots` | guard และ scope เดียวกับ catalog controller อื่น (ตามคอมเมนต์) |
| `products/time/product-clock.ts` | `ProductClock` (now + เขตเวลา `PRODUCT_TIMEZONE`, default Asia/Bangkok), `zonedParts`, `zonedToUtc` | ให้ทั้ง admin และ search ใช้เขตเวลาเดียวกัน (`audit` F-09) |
| `products/time/product-calendar.ts` | `todayIn`, `plannerTimeContext` (ปฏิทิน 14 วันให้ model เลือก) | model ไม่ต้องนับวันเอง (`product-action-report` G03/G05) |
| `shared/text/thai-datetime.ts` | `parseThaiDateTime`, `parseQuantity` (ไม่มี I/O และไม่มีนาฬิกา) | อ่านวัน/เวลาไทยด้วยกฎ (เช่น "n ทุ่ม = 18+n", "ตี n = n"); ค่าที่อ่านไม่ได้เป็น null ให้ model ตัดสิน |

**ข้อสังเกตจากการอ่านไฟล์เหล่านี้ (ไม่ได้ทดสอบเพิ่ม):**
- `thai-datetime.ts` เป็นโค้ดที่ตรวจยากที่สุด (กฎภาษาไทยหลายรูปแบบ) ควรมี Thai retrieval test ตาม `.claude/rules/rag-ai.md` ทุกครั้งที่แก้
- `product-clock.ts` มี `FixedProductClock` สำหรับ test อยู่แล้ว

---

## 14. ข้อสังเกตที่ควรแก้ก่อน merge (สรุปจากการรีวิว)

| # | ไฟล์ | ปัญหา | ความร้ายแรง |
|---|---|---|---|
| 1 | `src/ai-provider/utils/ai-provider.constants.ts` + `products/rag/product-retrieval.service.ts` | `DEFAULT_AI_MAX_OUTPUT_TOKENS` อ่าน `process.env` ตอน import ซึ่งเกิดก่อน `ConfigModule` โหลด `.env` จึงอาจได้ 1000 แทน 1500 | สูง (ค่าไม่ตรงที่ตั้งใจ) |
| 2 | `knowledge/utils/follow-up-patterns.ts` | มีคอมเมนต์ `// 'รอบรถ', 'ตาราง', 'เวลารถ'` ค้างอยู่ใน `FOLLOW_UP_THAI` | ต่ำ (โค้ดคอมเมนต์ค้าง) |
| 3 | `products/rag/product-answer.policy.ts` `certainWords` | ปฏิเสธคำตอบที่ปฏิเสธคำว่า "ตายตัว" ด้วย (ไม่รู้ว่าเป็นการปฏิเสธ) | กลาง (ดู P04 ใน `test-case-report.md`) |
| 4 | `products/business/business-match.ts` `tagMatches` | ไม่มีความยาวขั้นต่ำของคำค้น ทำให้คำไทยสั้นอาจ match tag หลายตัว (`audit` F-12) | กลาง |
| 5 | `products/slots/slot-answer.ts` `departureTimetable` | ไม่ตรวจสถานะ FULL ในตารางย่อ (`test-case-report.md` P05, P10, FC1, FD1, FD2) — ข้อนี้มาจากรายงาน verifier ยังไม่ได้ตรวจโค้ดบรรทัดนี้เอง | กลาง |
| 6 | `products/slots/slot-search.ts` ("later" fallback) | เลือกรอบแรกสุดในช่วงแทนรอบที่ใกล้วันที่ถามที่สุด (P16, P45) | ต่ำ |
| 7 | `products/rag/product-retrieval.service.ts` (ราว 379) | เมื่อ planner ตอบ GENERAL แต่ probe เจอชื่อ alias เดี่ยว (เช่น "พัทยา") โค้ดบังคับ mode เป็น PRODUCT (D11–D13) | สูง (คำถามนอกเรื่องเข้า product) |
| 8 | `slots/slot-answer.ts` `isScheduleLookup` + `askFields` | คำถาม "แล้วรอบถัดไปล่ะ" (FC3) มี `askFields` จึงไม่ถูกนับเป็นตารางเวลาแบบ 0-LLM ไปทาง LLM แล้ว LLM ตอบ `directlyAnswered=false` จนถูก "ไม่พบ" ทั้งที่ค้นเจอรอบ (จากรายงาน verifier; ยังไม่ได้ทดสอบซ้ำ) | กลาง |

## 15. การตรวจที่ทำ

- `tsc --noEmit`: 13 error เท่า baseline ที่รายงานไว้ ไม่มี error ในไฟล์ที่แก้ใน `products/rag/product-retrieval.service.ts`
- `jest src/modules/products/rag`: ผ่าน 10/11 ข้อที่ล้มคือ `product-answer.policy.spec.ts:196` (ล้มอยู่ก่อนแล้วตาม `audit-product.md` T1)
- ไม่ได้รัน live และไม่ได้รัน jest ทั้ง repo
