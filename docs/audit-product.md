# Audit: Product flow (RAG สินค้า: route → plan → search → answer → render)

วันที่ 17 พ.ย. 2026 · branch `decisionLog` (HEAD `7bd2dfb`) · ผู้ตรวจ: Claude Fable 5.2
แทนที่ฉบับ 29 ต.ค. 2026 (ดูฉบับเดิมได้จาก git history) · อ่านคู่กับ [future/product-bks.md](future/product-bks.md) (design รอบรถ/slot)

**เป้าหมายที่ใช้ตัดสิน** (จากเจ้าของ product)

1. RAG ต้องส่งข้อมูลให้ LLM ถูกก่อน แล้ว LLM ตอบ**เฉพาะสิ่งที่ลูกค้าถาม** (ถามราคา = ชื่อ + รายละเอียดย่อ + ราคา ไม่ใช่ทุก field ใน DB)
2. LLM ไม่เกิน 1–3 call ต่อข้อความ และต้องเร็วขึ้นโดยคุณภาพไม่ลด
3. มีสินค้าอยู่และลูกค้าถามตรง ต้องไม่ fallback
4. reuse กับธุรกิจอื่นและ scale เป็น SaaS ได้ โดยเขียนโค้ดเพิ่มน้อยที่สุด (เสื้อผ้า, IT, รอบรถ บขส. มี field ไม่เหมือนกัน)
5. payment / หัก stock ยังไม่ทำ แค่ปูทาง

**วิธีตรวจรอบนี้**

- อ่านโค้ดทั้งไฟล์: `products/rag/*`, `products/search/*`, `products/business/*`, `products/attributes/{presets,prompts,types,utils}`, `commerce-turn.service.ts`, จุดเรียกใน `knowledge-retrieval.service.ts`, `users-ai-provider.service.ts`, `commerce-scope.service.ts`, `load-context.service.ts`, schema `prisma/models/products/product.prisma`
- รัน `bunx jest src/modules/products`: **ผ่าน 10/11** (ข้อที่ไม่ผ่านอยู่ใน T1)
- **ไม่ได้รัน pipeline จริงและไม่ได้วัด latency ใหม่** ตัวเลข latency / rejection rate ในเอกสารนี้เป็น baseline จากรอบ 29 ต.ค. (37 เคส 42 turn, โมเดล `openai/gpt-6-luna`) และติดป้าย 📊 ไว้ทุกจุด
- ค้นแนวปฏิบัติภายนอกมาเทียบ (หัวข้อ 4, แหล่งอ้างอิงท้ายเอกสาร)

ป้าย: ✅ = ยืนยันจากโค้ดปัจจุบัน · 📊 = ตัวเลขจากรอบ 29 ต.ค. ยังไม่วัดซ้ำ · 🔍 = อนุมานจากการอ่านโค้ด ยังไม่มีเคสรันยืนยัน
ระดับ: **H** = กระทบลูกค้าจริง แก้ก่อน · **M** = รอบถัดไป · **L** = เมื่อสะดวก

---

## 1. สรุป

| คำถาม | คำตอบ |
|---|---|
| โครง pipeline ถูกทางไหม | **ถูก ไม่ต้องรื้อ** LLM แปลงคำถามเป็น plan → โค้ดค้นและกรอง → LLM เขียน template → ตัวเลขแทนจาก DB ตรงกับแนว self-query + grounded generation |
| ราคา/สต็อกแต่งเองได้ไหม | 📊 รอบ 29 ต.ค. ไม่พบเลย (0 จาก 42 turn) โค้ดส่วนนี้ไม่เปลี่ยน แต่มีช่องของ guard 2 จุด (S1, S2) |
| ทำไม fallback ทั้งที่มีสินค้า | 9 จุด (FB1–FB9) สองจุดใหม่ที่หนักที่สุด: planner ผิดจุดเดียว = ส่งแอดมิน (FB1) และชน rate limit = ส่งแอดมิน (FB2) |
| ทำไมตอบไม่ตรงที่ถาม / เป็นหุ่นยนต์ | LLM เห็นทุก field แต่ถูกอนุญาตให้ใช้แค่บางส่วน (AN1) และ validator ตีกลับ template ที่ถูกราว 30% 📊 (AN2) |
| ทำไมช้า | LLM 2–3 call ต่อเนื่องกัน + DB ราว 40–55 round trip ต่อ turn 🔍 (LT1–LT6) baseline 📊 p50 5.9s / p90 9.2s / max 12.1s |
| reuse กับธุรกิจอื่นได้เลยไหม | **ยังไม่ได้** preset มีแค่ fields + prompt แต่คำศัพท์ ecommerce ฝังอยู่ใน core อย่างน้อย 6 ที่ (SC1) |
| meta ใช้เป็นท่าหลักได้ไหม | ได้สำหรับคุณสมบัติที่ค่อนข้างคงที่ **ไม่ได้**สำหรับราคา, จำนวนที่ถูกหัก (สต็อก/ที่นั่ง) และวันเวลาของรอบ (หัวข้อ 6) |

**สิ่งที่ทำได้ดีแล้ว ไม่ควรแตะ**

- ราคา/สต็อกมาจาก DB ผ่าน token เท่านั้น อ่านสดใน transaction RepeatableRead
- ID ที่ planner คืนต้องอยู่ใน probe หรือ refs ที่เคยแสดง, field/operator ต้องอยู่ใน preset
- `CommerceTurn` ต่อ event + slot ต่อ LLM call: replay ไม่เรียก LLM ซ้ำ ไม่คิดเงินซ้ำ
- LLM ถูกเรียกนอก DB transaction, จำกัด 3 call ต่อ turn
- ไม่ FOUND = ตอบด้วย template (0 LLM)
- aggregate (LIST/COUNT/CHEAPEST) scan catalog จริง ไม่ใช้ vector top-k
- `loadCatalogContext` เป็นทางเข้าเดียวของ preset (จุดต่อที่ถูกต้องสำหรับ SaaS)

---

## 2. Pipeline ปัจจุบัน

```
KnowledgeRetrievalService.retrieve
 └─ ProductRetrievalService.retrieveProduct
     1. gate: flag + userId/turnId/lineMemberId/conversationId + regex นโยบายทั้งข้อความ
     2. scope = forLineDeployment (บริษัทเดียว)
     3. turns.find  → มีแล้ว = replay
     4. routeWithoutPlanner: productSignal regex | refs + referenceSignal | probe | mentionsCatalog → PLAN
                             ไม่เข้า → รัน legacy ก่อน (1 embedding) → มั่นใจ = legacy / คำนโยบาย = KNOWLEDGE / อื่น = PLAN
     5. turns.open → withLease
     6. plan:  broad opener → rule (0 LLM)
               exact SKU    → rule (0 LLM)
               นโยบายล้วน   → KNOWLEDGE (0 LLM)
               อื่นๆ         → probe + plannerCatalog → LLM `PLAN` → validate (ผิดจุดเดียว = failed)
     7. search (tx) → ถ้า NO_MATCH และเปิด semantic: embed → search อีกรอบ
     8. BOTH → knowledge(policyQuery) ต่อท้าย (embedding อีกครั้ง)
     9. save retrieval → คืน lease
 └─ ProductAnswerService.answer → withLease อีกรอบ
     - failed → fallbackMessage + handoff
     - ไม่ FOUND → safeProductAnswer (0 LLM)
     - FOUND → LLM `ANSWER` (JSON template) → renderProductAnswer
               ตีกลับ + คำถามสำคัญ → LLM `CRITICAL_REPAIR`
               ตีกลับอีก → safeProductAnswer (list `ชื่อ · สี · ราคา`)
```

| เส้นทาง | LLM call | embedding |
|---|---|---|
| exact SKU / broad opener / ไม่ FOUND หลัง rule plan | 0–1 | 0 |
| คำถามสินค้าทั่วไป (FOUND) | 2 | 0–1 |
| BOTH / COMPARE / PRICE+STOCK ที่ template ถูกตีกลับ | 3 | 1–2 |

📊 เฉลี่ย 1.8 call ต่อ turn (2 call: 30 turn, 3 call: 3 turn)

---

## 3. Findings

### 3.1 Fallback ผิด: มีสินค้าแต่ตอบไม่ได้

#### FB1 (H) ✅ [ใหม่] planner ผิดจุดเดียว ทิ้งทั้ง turn แล้วส่งแอดมิน
- **ที่:** [product-retrieval.service.ts:276-357](../src/modules/products/rag/product-retrieval.service.ts#L276-L357)
- **ปัญหา:** validation เป็นแบบทั้งหมดหรือไม่มีเลย ID ที่ไม่ผ่าน, option/filter key ที่ไม่รู้จัก, operator ไม่ตรงชนิด, ช่วงราคากลับด้าน, JSON พัง หรือ provider ล่ม ทุกกรณีเข้า `catch` เดียวกัน → `failed = true` → ข้าม search → `fallbackMessage` + `requestAdmin` (`PRODUCT_PLAN_FAILED`)
- **ผล:** `probe` อาจเจอสินค้าตรงชื่อแล้ว แต่ไม่ถูกใช้ ลูกค้าถาม "เสื้อลินินราคาเท่าไหร่" แล้ว planner ใส่ filter แปลกมา 1 ตัว = ไปแอดมิน
- **แก้:** ตรวจทีละส่วนและ**ตัดเฉพาะส่วนที่ผิด** (ID ที่ไม่ผ่าน, filter/option ที่ไม่รู้จัก, ช่วงราคา) แล้วค้นต่อด้วยส่วนที่เหลือ ถ้า planner ใช้ไม่ได้เลยให้ใช้ rule plan (LT1) `failed` เหลือเฉพาะเมื่อไม่มีทั้ง probe, refs และ query และบันทึกส่วนที่ถูกตัดลง decision trace

#### FB2 (H) ✅ [ใหม่] ชน AI budget = slot ถูก mark `failed` ถาวร แล้วส่งแอดมิน
- **ที่:** [commerce-turn.service.ts:253-276](../src/modules/products/rag/commerce-turn.service.ts#L253-L276) (`beforeCall` throw ภายใน `generate`, `catch` เขียน `failed: true`)
- **ปัญหา:** `AiBudgetService.tryConsume` นับต่อ call (60/ชม. ต่อ user, F10 ใน CLAUDE.md) flow สินค้าใช้ 2–3 call ต่อข้อความ ลูกค้าที่ถามราว 20–30 ข้อความใน 1 ชม. จะชนเพดาน แล้ว `PLAN` คืน `undefined` → เข้า FB1 → ส่งแอดมิน และ slot ที่ `failed` ไม่ถูกลองใหม่แม้ replay
- **ผล:** ลูกค้าที่สนใจซื้อมากที่สุด (ถามเยอะ) คือคนที่โดน fallback และสร้าง `AdminNotification` โดยไม่จำเป็น
- **แก้:** (1) budget เกินไม่ใช่ provider failure: อย่า mark `failed` ให้ใช้ rule plan สำหรับ `PLAN` และ `safeProductAnswer` สำหรับ `ANSWER` โดยไม่ handoff (2) นับ budget ต่อข้อความ ไม่ใช่ต่อ call (3) LT1 ลดจำนวน call ลงเองอยู่แล้ว

#### FB3 (H) ✅ [ค้าง H3] คำถามสเปกสินค้าถูกตัดเป็น KNOWLEDGE ด้วย regex
- **ที่:** [product-retrieval.service.ts:239-249](../src/modules/products/rag/product-retrieval.service.ts#L239-L249), `policySignal` ที่ [:49-50](../src/modules/products/rag/product-retrieval.service.ts#L49-L50)
- **ปัญหา:** `policySignal` มีคำว่า "รับประกัน" ซึ่งเป็น field ของ preset (`warranty`) ด้วย เงื่อนไขตรวจแค่ `!productSignal && !probe.length` โดย `probe` ต้องเจอ**ชื่อเต็ม** และไม่ได้ใช้ผล `mentionsCatalog` ที่เพิ่งคำนวณใน `routeWithoutPlanner`
- **ผล:** 📊 "หูฟัง TWS Pro รับประกันกี่ปี" → 0 LLM → KNOWLEDGE → ส่งแอดมิน ทั้งที่ `warranty = "รับประกัน 1 ปี"` อยู่ใน meta
- **แก้:** ข้อความที่มี term ตรงกับ identity ของสินค้า (`mentionsCatalog`) หรือ label ของ field ใน preset ห้ามตัดเป็น KNOWLEDGE ให้เป็น `BOTH` (ค้นทั้งสองฝั่ง) และส่งผล `probe`/`mentionsCatalog` จากขั้น route ต่อเข้ามา ไม่คำนวณซ้ำ

#### FB4 (H) ✅ [ค้าง H2] TAGS `CONTAINS` เทียบแบบเท่ากันทั้งค่า แล้วตกไป `embedQuery('')`
- **ที่:** [business-match.ts:94-106](../src/modules/products/business/business-match.ts#L94-L106) (ค่า array ใช้ `optionMatcher().matches` = equality), [product-retrieval.service.ts:395](../src/modules/products/rag/product-retrieval.service.ts#L395), [embedding.service.ts:79](../src/modules/ai/embedding/embedding.service.ts#L79)
- **ปัญหา:** `features CONTAINS "กันน้ำ"` ไม่ match tag `"กันน้ำ IPX4"` → `NO_MATCH` → semantic fallback เรียก `embedQuery(plan.query)` ซึ่ง query ว่างได้เมื่อ plan มีแต่ filter → throw `Cannot embed empty text` → `UNAVAILABLE`
- **ผล:** 📊 "หูฟังรุ่นไหนกันน้ำบ้าง" ได้ "ขณะนี้ยังตรวจสอบข้อมูลสินค้าไม่ได้ กรุณาสอบถามเจ้าหน้าที่" + handoff
- **แก้:** TAGS/MULTI_SELECT `CONTAINS` = tag ใด tag หนึ่ง**มี**คำที่ถาม (หลัง normalize) และข้าม semantic fallback เมื่อ `plan.query.trim()` ว่าง

#### FB5 (H) ✅ [ค้าง H4] description ไทยหายทั้งบรรทัดถ้ามีคำว่า ราคา/บาท/สต็อก
- **ที่:** [product-document.ts:20-27](../src/modules/products/search/product-document.ts#L20-L27)
- **ปัญหา:** regex ตัด "ประโยค" ตาม `.!?\n` ซึ่งภาษาไทยไม่ใช้ `"ร่มพับ 3 ตอน กันแดดกันฝน คุ้มราคา พกพาง่าย"` เหลือ `""`
- **ผล:** description หายทั้งจาก evidence ที่ส่ง LLM และจาก document ที่ใช้ embed → ถามรายละเอียดแล้วได้ `INSUFFICIENT_CONTEXT`, semantic recall ตก
- **แก้:** ตัดเฉพาะช่วงที่เป็นจำนวนเงิน (`\d[\d,.]*\s*(บาท|฿|THB)`) หรือจำนวนสต็อก ไม่ตัดทั้งบรรทัด + unit test ไทย 3 เคส หลังแก้ต้อง bump `searchRevision` เพื่อ re-embed

#### FB6 (H) ✅ [ค้าง H1] เศษคำ 2 ตัวอักษรไป match สินค้าผิดแบบ substring
- **ที่:** [thai-bm25.ts:17-23](../src/shared/text/thai-bm25.ts#L17-L23) (เก็บ term ที่ยาว > 1), [product-terms.ts:145-161](../src/modules/products/search/product-terms.ts#L145-L161), `position()` ใน [product-search.service.ts:335-353](../src/modules/products/search/product-search.service.ts#L335-L353)
- **ผล:** 📊 "หมวกกันน็อก" ถูกตัดเป็น `["หมวก","น็","อก"]` แล้ว "อก" ไป match "ดอก" (เดรสลายดอก) ลูกค้าได้ตัวเลือกที่ไม่เกี่ยว ทั้งที่ควรตอบว่าไม่มี (เคสเดียวที่ WRONG ในรอบ 29 ต.ค.)
- **แก้:** ทิ้ง term ที่สั้นกว่า 3 ตัวอักษรในการค้นสินค้า, ลองทั้งวลีก่อนแล้วค่อยแยก term, และนับ hit เฉพาะ name/alias/category (description ใช้ให้คะแนนเท่านั้น)

#### FB7 (H) ✅ [ค้าง H5] DETAIL ตัด candidate ที่ 60 ก่อนกรอง option/filter
- **ที่:** [product-search.service.ts:349-354](../src/modules/products/search/product-search.service.ts#L349-L354)
- **ผล:** 📊 สินค้า 70 ตัวชื่อคล้ายกัน มีตัวเดียวที่เป็นสีแดง/XL ถามแบบ DETAIL ได้ `MISSING_INPUT` (ถามกลับ 5 ตัวที่ไม่ตรง) ถามแบบ LIST ได้คำตอบถูก
- **แก้:** กรองก่อนแล้วค่อยจัดอันดับ: เมื่อ plan มี options/filters ให้ใช้เส้นทาง keyset scan เดียวกับ aggregate ระยะยาวกรองใน SQL (SC4)

#### FB8 (M) ✅ [ใหม่] error ใดก็ตามใน search = `UNAVAILABLE` + handoff
- **ที่:** [product-retrieval.service.ts:407-412](../src/modules/products/rag/product-retrieval.service.ts#L407-L412)
- **ปัญหา:** `catch` เดียวรับทุกอย่าง: `BadRequestException` จาก `validateBusinessFilters`, `ConflictException` (business type เปลี่ยนระหว่าง plan), tx timeout 15s, embedding ล่ม ทั้งที่รอบ lexical แรกอาจมีผลใช้ได้แล้ว
- **แก้:** แยกชนิด error: filter ไม่ถูกต้อง = ตัด filter แล้วค้นใหม่ (ทางเดียวกับ FB1), semantic ล่ม = ใช้ผล lexical, เหลือ `UNAVAILABLE` เฉพาะ DB ล่มจริง

#### FB9 (M) ✅ [ค้าง M8 ใน product-bks] filter EQ บน option key หายเงียบ
- **ที่:** [product-retrieval.service.ts:317-334](../src/modules/products/rag/product-retrieval.service.ts#L317-L334)
- **ปัญหา:** filter ที่เลือกถูกลบออกจาก `plan.filters` ทั้งหมด แต่ย้ายเข้า `options` ได้ตัวเดียวต่อ key "สีดำหรือสีขาวก็ได้" เหลือสีเดียว
- **แก้:** ลบออกจาก filters เฉพาะตัวที่ย้ายสำเร็จ และให้ option รับหลายค่าต่อ key (OR)

### 3.2 ตอบไม่ตรงที่ถาม / ไม่เป็นธรรมชาติ

#### AN1 (H) ✅ [ใหม่] LLM เห็นทุกอย่าง แต่อนุญาตให้ใช้แค่บางส่วน
- **ที่:** [product-answer.policy.ts:214](../src/modules/products/rag/product-answer.policy.ts#L214) (`fullSnapshot = businessType !== undefined` ซึ่ง `search()` ใส่ค่าให้เสมอ จึงเป็นจริงทุก turn ใหม่), token allowlist ที่ [:47-70](../src/modules/products/rag/product-answer.policy.ts#L47-L70) และ [:96-115](../src/modules/products/rag/product-answer.policy.ts#L96-L115)
- **ปัญหา:** evidence ที่ส่งให้ model มี description (ถึง 2,000 ตัวอักษรต่อสินค้า), details ทุกตัว, ราคา, `onHand`/`reserved`/`fetchedAt` เสมอ แต่ `variantTokenFields` ถูกจำกัดตาม `asks` ลูกค้าถามสีแล้ว model เห็นราคา พอเขียนราคาก็ถูกตีกลับ
- **ผล:** ขัดเป้าหมายข้อ 1 โดยตรง: RAG ไม่ได้คัดข้อมูลให้ตรงคำถาม ปล่อยให้ prompt ("ตอบเฉพาะประเด็นที่ถาม") ทำงานแทน, prompt ยาวขึ้น (ช้าและแพงขึ้น), เพิ่ม rejection ของ AN2 และส่งตัวเลขภายใน (`onHand`, `reserved`) ให้ provider โดยไม่จำเป็น
- **แก้:** หลักเดียว: **สิ่งที่ model เห็น = สิ่งที่ model อ้างได้**
  1. ส่งเสมอ: ชื่อ, category, option ของ variant (identity)
  2. ส่งตาม plan: ราคา / สต็อก / description / field ที่ถาม (AN3)
  3. ไม่ส่ง: `onHand`, `reserved`, `fetchedAt` (ส่งแค่ `stockQuantity` ที่เลือกแล้ว)
  4. แนบรายชื่อ label ของ field ที่มีข้อมูลแต่ไม่ได้ส่ง (ไม่มีค่า) เพื่อให้ model เสนอ "สอบถามเพิ่มได้" โดยไม่แต่งค่า

#### AN2 (H) 📊 [ค้าง M1] validator ตีกลับ template ที่เนื้อหาถูกราว 30%
- **ที่:** [product-answer.policy.ts:361-496](../src/modules/products/rag/product-answer.policy.ts#L361-L496) โค้ดส่วนนี้ไม่เปลี่ยนจากรอบที่วัด
- **ตัวเลข 📊:** answer call 37 ครั้ง ผ่าน 23, ถูกตีกลับ 11, model ตอบ INSUFFICIENT เอง 3 สาเหตุหลัก: เขียนชื่อสินค้าตรงๆ แทน `{{e1.name}}`, เขียนค่า attribute/สีเป็นข้อความ, ประโยคปฏิเสธที่มีคำว่า "มีของ", "ยังไม่ได้ระบุราคา" โดยไม่มี token
- **ผล:** ลูกค้าได้ list `ชื่อ · สี · ไซส์ · ราคา` จาก `safeProductAnswer` (📊 8 turn) หรือเสีย call ที่ 3
- **แก้ (ตัวเลขยังมาจาก DB ทุกตัว):**
  1. **auto-tokenize ก่อน validate:** ข้อความใน template ที่ตรงกับค่าใน evidence ของ variant ที่อ้าง**เป๊ะ** (ชื่อ, `attr.*`, `opt.*`, ราคา) ให้แทนกลับเป็น token แล้วค่อยตรวจ
  2. token สำหรับสถานะว่าง: ราคา null นับว่าตอบ PRICE แล้ว
  3. คำ stock-claim: ตรวจเฉพาะประโยคบอกเล่า หรือบังคับใช้ `stockStatus` token แทนการ ban คำ
  4. เก็บ rejection rate ลง decision log เป็น metric ต่อ release (เป้า < 10%)

#### AN3 (M) ✅ [ใหม่] `asks` หยาบเกินไป: ไม่รู้ว่าถาม field ไหน
- **ที่:** [product-search.types.ts:63-66](../src/modules/products/search/product-search.types.ts#L63-L66) (`PRICE | STOCK | ATTRIBUTES | DESCRIPTION | POLICY`)
- **ปัญหา:** "รับประกันกี่ปี" กับ "ทำจากผ้าอะไร" ได้ `ATTRIBUTES` เหมือนกัน จึงคัด evidence ระดับ field ไม่ได้ และ `coversAskedFacts` ตรวจได้แค่ว่ามี detail token อย่างน้อย 1 ตัว ไม่ใช่ตัวที่ถาม
- **แก้:** เพิ่ม `askFields: string[]` ใน plan (key ต้องอยู่ใน storeFields, validate แบบเดียวกับ filters) ใช้ทั้งคัด evidence (AN1) และตรวจ coverage (`attr.<key>` ต้องถูกใช้) ไม่ผูกกับธุรกิจ: บขส. ใช้ `askFields: ['platform']` ได้ทันที

#### AN4 (M) ✅ [ค้าง M4] LIST ตัด evidence ระดับ variant สินค้าตัวเดียวกินโควตาทั้งหมด
- **ที่:** [product-search.service.ts:386-395](../src/modules/products/search/product-search.service.ts#L386-L395) (เก็บ 12 แถวระดับ variant), [product-answer.policy.ts:622](../src/modules/products/rag/product-answer.policy.ts#L622) (`slice(0, 5)`)
- **ผล:** 📊 "มีเสื้ออะไรบ้าง" ได้เสื้อยืดตัวเดียว 5 สี ทั้งที่มีเสื้อ 4 แบบ
- **แก้:** LIST จัดกลุ่มตามสินค้าก่อน (1 แถวต่อสินค้า ใช้ `priceRange` + `opts.*`) แล้วค่อยจำกัดจำนวน เรียงตามราคาเมื่อมี min/maxPrice

#### AN5 (M) 📊 [ค้าง M3, M5] เจตนาซื้อและการสรุปเงื่อนไข
- "สั่ง…ตัดบัตรเลย" ได้แค่ข้อมูลสินค้า ไม่บอกว่าจะส่งต่อแอดมิน → ตรวจเจตนาซื้อ/จ่ายแบบ deterministic แล้วต่อท้ายข้อความ handoff ที่กำหนดไว้ (จุดเดียวกับที่ flow order ในอนาคตจะมาต่อ, หัวข้อ 7)
- model สรุป "ซื้อ 1,290 ได้ส่งฟรี" ไม่ได้เพราะห้ามเขียน "ส่งฟรี" นอก token → เพิ่ม derived token ที่ server คำนวณ (เทียบราคากับเกณฑ์ใน policy ที่มีโครงสร้าง)
- `safeProductAnswer` ไม่แสดง `originalPrice`/`discountAmount` → ใส่เมื่อ `asks` มี PRICE

### 3.3 Latency

Baseline 📊: p50 5.9s · p90 9.2s · max 12.1s · เฉลี่ย 1.8 LLM call · ต่อ turn input cache hit ~2.3k token, output ~330 token

#### LT1 (H) ✅ [ใหม่] เรียก planner ทั้งที่คำถามแยกได้ด้วยกฎ
- **ที่:** [product-retrieval.service.ts:214-238](../src/modules/products/rag/product-retrieval.service.ts#L214-L238) (ข้าม planner ได้เฉพาะ exact SKU)
- **ปัญหา:** "เสื้อลินินสีดำราคาเท่าไหร่" มีครบทุกอย่างที่กฎหาได้: `probe` เจอสินค้า 1 ตัว, "สีดำ" อยู่ในค่า option ของร้าน, "ราคาเท่าไหร่" ตรง regex `asks` แต่ยังเสีย LLM 1 call (ราวครึ่งหนึ่งของเวลา turn นั้น 🔍)
- **แก้: rule plan แบบ "อธิบายได้ครบทุกคำ"**
  1. จับ identity: ชื่อ/alias/SKU (probe) หรือ refs จาก turn ก่อน + คำอ้างอิง
  2. จับค่า option ด้วยพจนานุกรมของร้าน: ค่าจริงใน catalog + `valueAliases` ผ่าน `optionMatcher` ที่มีอยู่
  3. จับ `asks` / `askFields` / `listOptions` จาก regex เดิม + label ของ field
  4. ตัดคำที่เหลือ: ถ้า**ไม่เหลือ content term ที่อธิบายไม่ได้** และ identity ชี้สินค้าเดียว → ใช้ rule plan (0 LLM) ถ้าเหลือ → เรียก `PLAN` ตามเดิม
  - เงื่อนไข "อธิบายได้ครบ" คือตัวกันพลาด: คำถามที่มี filter ซับซ้อน, เปรียบเทียบ, แนะนำ หรือคำที่กฎไม่รู้จัก จะยังไป LLM
  - rule plan ตัวเดียวกันเป็นทางสำรองของ FB1/FB2

#### LT2 (M) ✅ [ใหม่] โมเดลเดียวถูก pin ทั้ง turn
- **ที่:** [commerce-turn.service.ts:117-128](../src/modules/products/rag/commerce-turn.service.ts#L117-L128) (`providers.selection()` → ใช้กับทุก slot)
- **ปัญหา:** `PLAN` เป็นงานสกัด slot (JSON สั้น) ใช้โมเดลเดียวกับ `ANSWER` และเปิด `reasoningEffort: 'low'`
- **แก้:** เลือกโมเดลต่อ slot: `PLAN` ใช้โมเดลเล็ก/เร็วและปิด reasoning, `ANSWER` ใช้โมเดลหลัก ยัง pin ต่อ turn ได้เหมือนเดิม (เก็บ 2 คู่) ต้องมีแถวใน `aiModelPricing` ของโมเดลใหม่ และต้องผ่าน Thai test ของ planner ก่อนเปลี่ยน

#### LT3 (M) ✅ [ค้าง M6] งาน DB ซ้ำต่อ turn
- `probe` ถูกเรียก 2–3 ครั้ง: [:516](../src/modules/products/rag/product-retrieval.service.ts#L516) (route), [:198](../src/modules/products/rag/product-retrieval.service.ts#L198) (plan), [product-search.service.ts:280](../src/modules/products/search/product-search.service.ts#L280) (DETAIL)
- `plannerCatalog` ([product-search.service.ts:176-227](../src/modules/products/search/product-search.service.ts#L176-L227)) ทำ `jsonb_each_text` บน meta ของทุก variant + `distinct category` **ทุก turn**
- `loadCatalogContext` (อ่าน company) ถูกเรียกใน `mentionsCatalog`, `plannerCatalog`, `search` และ `forLineDeployment` อ่าน company อีกครั้ง
- lease ถูกขอ/คืน 2 รอบ (retrieval แล้ว answer) แต่ละ LLM call มี tx ของ slot (FOR UPDATE + find + count + create) + billing reserve/settle
- รวม 🔍 ราว 40–55 round trip ต่อ turn ที่ FOUND ไม่เป็นปัญหาบน DB ในเครื่อง แต่บน managed DB ข้ามเครือข่ายจะเป็นหลักร้อย ms ถึงวินาที และโตตามขนาด catalog
- **แก้:** catalog snapshot ใน memory ต่อ company แบบเดียวกับ `AnswerPatternCacheService` (identity ของสินค้า, ค่า option จริง, categories, fields) invalidate จาก `ProductCommandService` ผ่าน pub/sub ใช้กับ probe / mentionsCatalog / plannerCatalog / rule plan (LT1) **ราคาและสต็อกยังอ่านสดจาก DB ใน `evidence()` เหมือนเดิม** และถือ lease เดียวตลอด turn

#### LT4 (M) ✅ [ใหม่] งานที่ขนานได้ถูกทำต่อเนื่องกัน
- BOTH: `knowledge(policyQuery)` รันหลัง product search เสร็จ ([product-retrieval.service.ts:448-455](../src/modules/products/rag/product-retrieval.service.ts#L448-L455)) → รันพร้อมกัน
- semantic fallback: search → embed → search อีกรอบ ([:385-406](../src/modules/products/rag/product-retrieval.service.ts#L385-L406)) → เมื่อเปิด `PRODUCT_SEMANTIC_ENABLED` ให้ embed พร้อมกับรอบ lexical แล้วรวมผลในการค้นครั้งเดียว
- `routeWithoutPlanner` รัน legacy (1 embedding) ให้เสร็จก่อนค่อยตัดสินว่า PLAN ([:520-529](../src/modules/products/rag/product-retrieval.service.ts#L520-L529)) → ผลนี้ถูก memoize อยู่แล้ว เริ่มพร้อมกับ probe ได้

#### LT5 (M) 📊 `CRITICAL_REPAIR` เป็นอาการของ AN2
- 📊 3 จาก 33 turn ใช้ call ที่ 3 หลังแก้ AN1 + AN2 ให้วัด rejection rate ใหม่ ถ้าต่ำกว่า 10% ให้ถอด slot นี้ออก (เพดานเหลือ 2 call)

#### LT6 (L) ✅ [ค้าง L4] prompt ของ planner มี indentation 14 ช่องทุกบรรทัด
- [product-prompt.ts:22-38](../src/modules/products/rag/utils/prompt/product-prompt.ts#L22-L38) เปลือง token โดยไม่จำเป็น

### 3.4 Scale / reuse

#### SC1 (H) ✅ คำศัพท์ ecommerce ฝังอยู่ใน core: ธุรกิจใหม่ยังไม่ใช่แค่ไฟล์ preset
preset ปัจจุบันมีแค่ `fields` + `prompt` ([attribute-definition.types.ts:33-41](../src/modules/products/attributes/types/attribute-definition.types.ts#L33-L41)) สิ่งที่ยังอยู่นอก preset:

| ที่ | สิ่งที่ฝัง |
|---|---|
| [product-retrieval.service.ts:49-61](../src/modules/products/rag/product-retrieval.service.ts#L49-L61), [:102-107](../src/modules/products/rag/product-retrieval.service.ts#L102-L107) | `policySignal`, `productSignal` (เสื้อ, รองเท้า, ไซส์), `referenceSignal` (สีดำ, สีขาว), `isBroadProductInquiry`, regex นโยบายทั้งข้อความ |
| [product-retrieval.service.ts:222-229](../src/modules/products/rag/product-retrieval.service.ts#L222-L229) | regex `asks` (ราคา, สต็อก, พร้อมส่ง) |
| [product-terms.ts:7-138](../src/modules/products/search/product-terms.ts#L7-L138) | `QUESTION_TERMS` มีคำที่เป็นชื่อสินค้าได้ในธุรกิจอื่น (`ลูก`, `ใบ`, `ส่ง`, `ไป`) |
| [product-answer.policy.ts:26-32](../src/modules/products/rag/product-answer.policy.ts#L26-L32), [:540](../src/modules/products/rag/product-answer.policy.ts#L540), [:611-618](../src/modules/products/rag/product-answer.policy.ts#L611-L618) | `stockLabels`, หน่วย "ชิ้น", ข้อความถามกลับ ("ระบุสีและขนาด", "ชื่อรุ่นหรือ SKU") |
| [product-answer.policy.ts:404-410](../src/modules/products/rag/product-answer.policy.ts#L404-L410) | คำต้องห้ามนอก token (มีของ, พร้อมส่ง, ส่งฟรี) ไม่มี "ว่าง/เต็ม" |
| [option-matcher.constants.ts](../src/modules/products/attributes/utils/option-matcher.constants.ts) | `GENERIC_OPTION_PREFIXES` (สี, ไซส์, รส) |

- `productSignal` เทียบแบบ substring: `สี` match "เ**สี**ย", "**สี**หน้า" → เสีย planner call เปล่า
- **แก้:** เพิ่ม `lexicon` และ `capabilities` ใน `BusinessPreset` (type ที่เสนอไว้ใน [product-bks.md §5.5](future/product-bks.md)) อ่านผ่าน `loadCatalogContext` เท่านั้น เทียบสัญญาณเป็นคำด้วย `Intl.Segmenter` ค่า default ของ ECOMMERCE = ค่าที่ฝังอยู่ตอนนี้ทุกคำ และต้องมีเทสต์พิสูจน์ว่าคำตอบ ecommerce ไม่เปลี่ยน

#### SC2 (H) ✅ ผูกกับบริษัทเดียวและช่อง LINE
- [commerce-scope.service.ts:51-65](../src/modules/commerce/commerce-scope.service.ts#L51-L65): `forLineDeployment` ใช้ได้เมื่อมี company แถวเดียว (และ query ทุก turn)
- [product-retrieval.service.ts:93-100](../src/modules/products/rag/product-retrieval.service.ts#L93-L100): ต้องมี `lineMemberId` ช่อง App จึงไม่มี Product RAG
- `connectionKey = 'standalone-line'` ตายตัว, `language = 'th'` ตายตัว
- **แก้ (เมื่อเริ่ม SaaS):** หา `companyId` จาก channel ที่รับข้อความ (`lineChannels` / app client) แล้วส่งมาใน `AiRequestContext`, ให้ `CommerceTurn` อ้าง `channelConversations` ได้ (`lineMemberId` nullable)

#### SC3 (M) ✅ preset: ชนิดที่ไม่ลงทะเบียน, สำเนาที่ไม่ได้ใช้, category ถูกเขียนทับ
- ชนิดที่ไม่อยู่ใน `BUSINESS_PRESETS` → `catalogFields` คืน 0 field ([catalog-fields.ts:43-55](../src/modules/products/search/catalog-fields.ts#L43-L55)) `applyPreset` ปฏิเสธชนิดที่ไม่รู้จักแล้ว ([product-attribute.service.ts:93](../src/modules/products/attributes/product-attribute.service.ts#L93)) แต่ค่าเก่าใน DB (📊 dev DB เคยเป็น `ELECTRONICS`) ไม่มี health check → เพิ่มการตรวจตอนบูตและใน go-live checklist
- `presets/custom/prasya.preset.ts` และ `prompts/custom/prasya.prompt.ts` เป็นสำเนาของ ECOMMERCE ที่ไม่มีไฟล์ไหน import → ลบ หรือลงทะเบียนให้ถูก
- [catalog-fields.ts:51](../src/modules/products/search/catalog-fields.ts#L51): `categories` ของ field ถูกเขียนทับด้วยหมวดของร้านทั้งหมด จึงกำหนดไม่ได้ว่า field ไหนใช้กับหมวดไหน (ร้านที่ขายทั้งเสื้อผ้าและ IT ต้องใช้) → ใช้ `field.categories` ของ preset เมื่อมี

#### SC4 (M) ✅ การค้นไม่ใช้ index: ช้าลงตามขนาด catalog
- lexical ใช้ `position(lower(term) in lower(concat_ws(...)))` + subquery `jsonb_each_text` ต่อสินค้า ([product-search.service.ts:51-72](../src/modules/products/search/product-search.service.ts#L51-L72)) = scan ทุกสินค้าของ company ต่อ term
- aggregate โหลดสินค้า + variant + inventory ทีละ 100 เข้ามากรองในโค้ด ภายใน tx RepeatableRead
- ไม่มี GIN บน `productVariants.meta`
- **ไม่ใช่ปัญหาที่ catalog หลักสิบถึงหลักร้อย** (snapshot ใน LT3 รองรับได้) เกินหลักพันให้เพิ่มตาราง search doc ต่อสินค้า (ข้อความ identity, facets jsonb + GIN, min/max ราคา) ดูแลด้วย outbox ของ `ProductIndexService` ที่มีอยู่ แล้วกรองใน SQL สำหรับภาษาไทย: `pg_trgm` (มีเกือบทุกที่ ต้องการ term ≥ 3 ตัวอักษร) หรือ PGroonga (ดีกว่าแต่ต้องเช็กว่า host รองรับ) ต้อง benchmark กับข้อมูลไทยจริงก่อนเลือก

#### SC5 (L) ✅ document ที่ใช้ embed เป็น JSON รวม SKU ของทุก variant
- [product-document.ts:53-77](../src/modules/products/search/product-document.ts#L53-L77) → เปลี่ยนเป็นข้อความธรรมดา (`ชื่อ. หมวด. คำอธิบาย. label: ค่า`) และไม่ใส่ SKU 🔍 น่าจะช่วย semantic recall แต่ต้องวัด cosine ใหม่ (กฎข้อ 5 ใน CLAUDE.md)

### 3.5 ช่องของ guard

#### S1 (M) ✅ ค่า option ที่ร้านไม่ได้ประกาศเขียนเป็น prose ได้
- **ที่:** [product-answer.grounding.ts:112-152](../src/modules/products/rag/product-answer.grounding.ts#L112-L152)
- **ปัญหา:** `proseStatesOptionValue` เป็น blocklist ของค่าที่**รู้จัก** (option ใน evidence + ค่า/alias ที่ preset ประกาศ) field `color` เป็น TEXT ที่มี alias 12 สี สีที่อยู่นอกรายการ (เช่น ฟ้า, กรมท่า) และไม่อยู่ใน evidence ของ turn นั้นจะผ่าน เทสต์ C02 (T1) แสดงอาการเดียวกันเมื่อ business type ไม่มี preset
- **แก้:** ใช้ค่า option จริงทั้งหมดของ catalog (จาก snapshot LT3) เป็นชุดตรวจ ไม่ใช่เฉพาะที่ preset ประกาศ และข้อความรูป `<label ของ option><คำ>` นอก token ให้ตีกลับเสมอ

#### S2 (M) 🔍 [ค้าง M2] ราคาเป็นคำไทยและ claim นโยบายที่ไม่มีตัวเลข
- [product-answer.policy.ts:398-410](../src/modules/products/rag/product-answer.policy.ts#L398-L410) กันเลขอารบิก/ไทย, "บาท", "ส่งฟรี" แต่ "ราคาห้าร้อยห้าสิบ", "รับประกันตลอดชีพ", "ของแท้" ผ่านได้ (📊 ไม่พบเคสหลุดจริง) → เพิ่ม pattern จำนวนเงินเป็นคำ และให้ claim นโยบายต้องมาจาก `attr.*` / `p*.answer` รายการคำย้ายไป `lexicon.claimWords` (SC1)

#### S3 (M) ✅ [ค้าง C1 ใน product-bks] `catalogRefs: []` กลายเป็น `{}` ใน Redis
- **ที่:** [load-context.service.ts:124-137](../src/modules/chatbot/context/load-context.service.ts#L124-L137) (Lua decode/encode ด้วย cjson ทุก turn), [:177-191](../src/modules/chatbot/context/load-context.service.ts#L177-L191) (`{}` parse ไม่ผ่าน → `undefined`)
- **ผล:** turn ที่ตั้งใจล้าง refs (GENERAL, COUNT) กลายเป็น "ไม่มีข้อมูล refs" ตัวค้นจึงข้ามไปใช้ refs ของ turn ก่อนหน้า "ตัวนั้นราคาเท่าไหร่" อาจชี้สินค้าที่แสดงไว้สอง turn ก่อน
- **แก้:** เก็บ refs เป็น JSON string ที่ Lua ไม่ decode หรือให้ `catalogRefs()` ตีความ `{}` เป็น `[]`

#### S4 (L) ✅ [ค้าง L1, L2]
- `categoryFilter` ใช้ `findFirst` โดยไม่กรอง `status`/`language` ([product-search.service.ts:561-581](../src/modules/products/search/product-search.service.ts#L561-L581)) ไม่ leak แต่หมวดที่มีแต่ DRAFT ถูกเลือกเป็น exact match
- `redactPii` ถูกใช้กับชื่อสินค้า/alias ([product-search.service.ts:637-639](../src/modules/products/search/product-search.service.ts#L637-L639)) ชื่อที่มีบาร์โค้ด 13 หลักกลายเป็น `[REDACTED_*]`

### 3.6 เทสต์

#### T1 (M) ✅ spec ล้ม 1/11 และ script ชี้ไฟล์ที่ไม่มี
- `product-answer.policy.spec.ts` › `rejects a colour the customer did not choose` ล้ม: fixture ใช้ `businessType: 'FASHION'` ([spec:103](../src/modules/products/rag/product-answer.policy.spec.ts#L103)) ซึ่งไม่มี preset → แก้ fixture เป็น ECOMMERCE และเพิ่มเคสสีนอก alias (S1)
- [package.json:21-22](../package.json#L21-L22): `test:commerce`, `test:product-audit` ชี้ไป `test/scripts/` ซึ่งไม่มีอยู่
- ไม่มี regression suite ของ flow สินค้าใน repo (harness 37 เคสของรอบ 29 ต.ค. อยู่นอก repo) กฎ `rag-ai.md` บังคับให้มี Thai retrieval test เมื่อแก้ scoring/prompt ซึ่งแทบทุกข้อในเอกสารนี้เข้าข่าย → **ต้องคืน suite ก่อนเริ่มแก้**

---

## 4. เทียบกับแนวปฏิบัติภายนอก

| แนวปฏิบัติ | แหล่ง | ตอนนี้ | หลังแก้ |
|---|---|---|---|
| LLM แปลงคำถามเป็น filter แบบมีโครงสร้าง แล้วระบบค้นเป็นผู้กรอง ความแม่นขึ้นกับการนิยาม metadata | Elastic self-query | ✓ planner + preset fields | ✓ + `askFields` |
| ใช้ filter **ก่อน** retrieval เพื่อให้เหลือเฉพาะรายการที่ผ่านเงื่อนไข | arXiv 2601.16492 (preprint) | ✗ ตัด 60 ก่อนกรอง (FB7) | ✓ กรองก่อนจัดอันดับ |
| query understanding ด้วยโมเดลเล็ก/เร็ว + guardrail ตรวจผลหลัง LLM | Instacart (รายงาน latency ต่ำกว่า 300ms ด้วยโมเดลที่ fine-tune เอง) | ครึ่งหนึ่ง: guardrail มี แต่ใช้โมเดลหลักและทิ้งทั้ง plan เมื่อผิด | ✓ LT1, LT2, FB1 |
| sub-query ขนานกัน เวลารวมใกล้ call ที่ช้าที่สุด | Algolia (แหล่งผู้ขาย) | ✗ ต่อเนื่องกัน | ✓ LT4 |
| hybrid keyword + vector | Algolia, Elastic | ✓ RRF k=60 (vector เป็น fallback) | ✓ |
| agent แบบ tool-calling (search catalog / policies) | Shopify shop-chat-agent (ตัวอย่างนี้ถูกเลิกใช้แล้ว ย้ายไป UCP) | ไม่ใช้ | **ไม่เปลี่ยน:** ใช้ 2 call เท่าเดิมแต่เสีย guard ราคา/สต็อก |
| attribute แบบ definition + ค่า, ระบุ searchable ต่อ field และเปิดเท่าที่จำเป็น | Shopify metafield definitions, commercetools product types | ✓ preset fields + `meta` | ✓ + lexicon/capabilities |
| ตัวเลขที่เปลี่ยนเร็วมาจากแหล่งจริง ไม่ใช่ vector | กฎ `rag-ai.md` | ✓ | ✓ |

ข้อจำกัดของแหล่ง: ไม่พบ benchmark อิสระที่เทียบสถาปัตยกรรมเหล่านี้โดยตรง ตัวเลขของ Instacart และ Algolia เป็นของผู้เผยแพร่เอง ใช้เป็นทิศทาง ไม่ใช่เป้า

---

## 5. Target design: pipeline ที่ lean ขึ้น

```
message
 ├─ [0 LLM] catalog snapshot (memory ต่อ company)
 │     identity (ชื่อ/alias/SKU/refs) + ค่า option + label ของ field + asks
 │     ├─ อธิบายได้ครบ + สินค้าเดียว        → rule plan
 │     └─ เหลือคำที่อธิบายไม่ได้             → LLM PLAN (โมเดลเล็ก, ปิด reasoning)
 │                                             plan ผิดบางส่วน → ตัดส่วนนั้น ไม่ทิ้งทั้ง turn
 │     (ขนาน: knowledge retrieval เมื่อมีสัญญาณนโยบาย, embedding เมื่อเปิด semantic)
 ├─ search: กรองก่อนจัดอันดับ, ราคา/สต็อกอ่านสดจาก DB
 ├─ FOUND     → LLM ANSWER: evidence = identity + สิ่งที่ถาม (asks/askFields)
 │              validate: token หรือข้อความที่ตรง evidence เป๊ะ
 └─ ไม่ FOUND → template จาก preset.lexicon (0 LLM)
```

| เส้นทาง | LLM call ตอนนี้ | เป้า |
|---|---|---|
| ชื่อสินค้า + ราคา/สต็อก/option ("เสื้อลินินสีดำราคาเท่าไหร่") | 2 | **1** |
| filter / เปรียบเทียบ / แนะนำ / คำกำกวม | 2 | 2 |
| BOTH, COMPARE, PRICE+STOCK ที่ template ถูกตีกลับ | 3 | 2 |
| ไม่ FOUND, exact SKU ที่ไม่พบ | 0–1 | 0–1 |
| budget เกิน / planner ล่ม | fallback + แอดมิน | 0–1 (rule plan / template) |

**Invariant ที่ต้องคงไว้** (จาก CLAUDE.md §13)
- ราคา/สต็อก/สถานะมาจาก DB ผ่าน token: auto-tokenize แทนข้อความด้วย token ก่อนตรวจ ไม่ได้ปล่อยตัวเลขของ model ผ่าน
- snapshot ใช้กับ identity และคำศัพท์เท่านั้น ไม่ cache ราคา/สต็อก
- ทุก LLM/embedding call ผ่าน billing wrapper ด้วย `turnId` เดิม, rethrow `InsufficientCreditException` / `PendingAiUsageError`
- rule plan ถูกเก็บลง `commerceTurns.plan` เหมือน plan จาก LLM (replay ได้ผลเดิม)
- เส้นทางใหม่ทุกเส้นรายงาน `decisionTrace.answer({ mode })` (เช่น `planSource: RULE | LLM | RULE_FALLBACK`)

---

## 6. Scale เป็น SaaS: ใช้ meta ท่าไหน

### 6.1 meta เก็บอะไรได้ และอะไรไม่ได้

`meta` (jsonb) + field definition จาก preset เป็นท่าเดียวกับ Shopify metafield definitions และ commercetools product types ใช้ต่อได้ แต่ข้อมูล 3 ประเภทต้องเป็นคอลัมน์/ตารางที่มีชนิด:

| ข้อมูล | ทำไมไม่อยู่ใน meta | ที่เก็บ |
|---|---|---|
| ราคา | ต้องเป็น Decimal, ตรวจได้, เป็น token | `productVariants.price` (มีแล้ว) |
| จำนวนที่ถูกหักพร้อมกัน: สต็อก, ที่นั่งว่าง/จอง | ต้อง update แบบ atomic ต่อแถว + CHECK + ledger การแก้ jsonb คือเขียนทับทั้งก้อน เสี่ยง lost update | `inventoryBalances` (มีแล้ว) / capacity ของ slot |
| วันเวลาของรอบ | ต้องค้นเป็นช่วง, มี index, หมดอายุตามเวลา | ตาราง `productSlots` (ยังไม่มี) |

`isSafeAttributeKey` ปฏิเสธ key จำพวก price/stock/qty อยู่แล้ว ซึ่งสอดคล้องกับตารางนี้

### 6.2 ตัวอย่างต่อธุรกิจ

| ธุรกิจ | Product | Variant (ราคา) | meta (คงที่) | ของที่ถูกหัก |
|---|---|---|---|---|
| เสื้อผ้า | เสื้อเชิ้ตลินิน | สีดำ / L | สี, ไซส์, วัสดุ | `inventoryBalances` |
| IT | โน้ตบุ๊ก X14 | 16GB / 512GB | ram_gb, storage_gb, cpu, ประกัน | `inventoryBalances` |
| บขส. | กรุงเทพฯ → เชียงใหม่ | VIP / ชั้น 1 | ต้นทาง, ปลายทาง, ชั้นรถ, จุดจอด | `productSlots` (เวลาออก, capacity, reserved) |

- เสื้อผ้ากับ IT เป็น ecommerce ทั้งคู่ ต่างกันแค่ fields → preset แยกที่ประกอบจาก [shared-fields.ts](../src/modules/products/attributes/presets/shared-fields.ts) filter ชนิด NUMBER (`GTE`/`LTE`) รองรับ "RAM 16GB ขึ้นไป" อยู่แล้ว ไม่ต้องแก้ search
- บขส.: เวลา/รอบ/ที่นั่งว่าง/ที่นั่งจอง **ไม่ใส่ meta** ใช้ design `productSlots` + date resolver ใน [product-bks.md §5](future/product-bks.md) ซึ่งรอบนี้ตรวจแล้วเห็นด้วย ไม่มีข้อแก้

### 6.3 สามชั้นที่ทำให้ "เพิ่มธุรกิจ = เพิ่มข้อมูล"

1. **Core (ไม่มี `if businessType`):** Product / Variant / ราคา / availability / Slot, plan schema, search, renderer
2. **Preset = ข้อมูลทั้งหมดที่ต่างกัน:** `fields` + `prompt` (มีแล้ว) + `lexicon` + `capabilities` (SC1) หลังทำ SC1 ธุรกิจใหม่ = ไฟล์ preset 1 ไฟล์ + 1 บรรทัดใน registry
3. **Tenant:** `company.productBusinessType` เลือก preset เก็บ preset ในโค้ดไปก่อน เมื่อ tenant ต้องการ field ของตัวเอง ให้เปลี่ยน `loadCatalogContext` ไปอ่าน definition จาก DB (seed จาก preset) จุดเดียว โค้ดอื่นไม่ต้องแก้เพราะอ่านผ่านทางนี้อยู่แล้ว

ไม่ควรทำตอนนี้: field definition ใน DB, rule engine, search engine แยก ทั้งหมดรอได้จนมี tenant ที่ต้องการจริง

---

## 7. ปูทาง payment / หัก stock (ยังไม่ทำ)

- **Hold:** ตาราง hold (variant หรือ slot, จำนวน, วันหมดอายุ, สถานะ) หักด้วย `UPDATE … SET reserved = reserved + n WHERE "onHand" - reserved >= n` ใน tx เดียวกับการสร้าง hold คืนเมื่อหมดอายุหรือยกเลิก
- **ฝั่งแชตไม่ต้องแก้:** `evidence()` อ่าน `onHand − reserved` อยู่แล้ว คำตอบจะสะท้อน hold เอง
- **Order ไม่มาจาก LLM:** LLM ระบุได้แค่เจตนาซื้อ (AN5) แล้วเข้า flow แบบ deterministic ที่เก็บ state ใน session เหมือน registration การเขียนผ่าน command แบบ `ProductCommandService` (idempotent ด้วย `requestId`, append-only movement)
- **ต้องตัดสินใจก่อนเริ่ม:** F1 ใน CLAUDE.md (ข้อมูลลับถูกเก็บใน delivery/history) ต้องปิดก่อนมีข้อมูลการชำระเงินผ่านแชต
- รายละเอียด flow อยู่ใน [feature/order-payment-claude.md](feature/order-payment-claude.md) (เอกสารนั้นไม่ได้ตรวจในรอบนี้)

---

## 8. แผนพัฒนา (ลำดับทำ)

| Phase | งาน | ข้อ | เกณฑ์ผ่าน |
|---|---|---|---|
| **0. คืนเทสต์** | นำ harness 37 เคสเข้า `test/audit/` + runner, แก้ fixture C02, แก้/ลบ script ที่ชี้ไฟล์ไม่มี | T1 | spec ผ่าน 11/11, suite รันได้ด้วยคำสั่งเดียว, ได้ baseline ใหม่ของ latency + rejection rate |
| **1. หยุด fallback ผิด** | FB1, FB2, FB3, FB4, FB5, FB6, FB8, FB9, S3 | | เคส C01, C03, D04 ของรอบ 29 ต.ค. ผ่าน, ไม่มี `PRODUCT_PLAN_FAILED` เมื่อ probe เจอสินค้า, budget เกินไม่สร้าง `AdminNotification` |
| **2. ตอบตรงที่ถาม** | AN1, AN2, AN3, AN4, S1 | | rejection rate < 10%, คำตอบแบบ list ลดลง, ไม่มีตัวเลขแต่งเอง (ยังต้องเป็น 0) |
| **3. Lean** | LT3 (snapshot) → LT1 (rule plan) → LT2 (โมเดลต่อ slot) → LT4 (ขนาน) → LT5 (ถอด repair) | | สัดส่วน turn ที่ใช้ 1 call และ p50/p90 ดีขึ้นจาก baseline ของ Phase 0 (ตั้งเป้าตัวเลขหลังวัด baseline), CORRECT ไม่ลดลง |
| **4. Reuse** | SC1 (lexicon/capabilities), SC3, preset ที่สอง (เช่น IT) เป็นตัวพิสูจน์ | | คำตอบ ECOMMERCE ไม่เปลี่ยน, preset ใหม่ไม่ต้องแก้ไฟล์นอก `attributes/presets` และ `prompts` |
| **5. Slot + TRANSPORT** | ตาม [product-bks.md](future/product-bks.md) | | ตามเอกสารนั้น |
| **6. SaaS / ขนาด** | SC2, SC4, definition ใน DB | | ทำเมื่อมี tenant ที่สอง หรือ catalog เกินหลักพัน |

เหตุผลของลำดับ: Phase 0 มาก่อนเพราะทุกข้อหลังจากนั้นแก้ scoring/prompt ซึ่งกฎบังคับให้มี Thai test · Phase 1 ก่อน 3 เพราะการทำให้เร็วขึ้นบน flow ที่ยัง fallback ผิดไม่ช่วยลูกค้า · LT3 ก่อน LT1 เพราะ rule plan ต้องใช้ snapshot · SC1 ก่อน slot เพราะ TRANSPORT ต้องมี lexicon ของตัวเอง

**Metric ที่ควรเก็บใน decision log ทุก release:** `planSource` (RULE/LLM), จำนวน LLM call ต่อ turn, template rejection rate, สัดส่วน `PRODUCT_SAFE_TEMPLATE`, สัดส่วน fallback แยกตาม reason, latency ต่อ stage (route / plan / search / answer)

---

## 9. ข้อจำกัดของการตรวจรอบนี้

- **ไม่ได้รัน pipeline จริง** ทุกข้อที่ติดป้าย ✅ คือ "เส้นทางโค้ดยังอยู่" ไม่ใช่ "ทำซ้ำอาการได้ในรอบนี้" ตัวเลข 📊 มาจากรอบ 29 ต.ค. บนโมเดลเดียวและ catalog 18 สินค้า
- จำนวน DB round trip (40–55) นับจากการอ่านโค้ด ไม่ได้ trace จริง และยังไม่ได้ `EXPLAIN ANALYZE` SQL ใด
- ประมาณการว่า planner กินเวลาราวครึ่งหนึ่งของ turn เป็นการอนุมานจากการมี LLM 2 call ที่ขนาดใกล้กัน ยังไม่มี latency แยกต่อ stage (เป็นเหตุผลหนึ่งของ Phase 0)
- ไม่ได้ตรวจ: admin catalog write (`ProductCommandService`), `ProductIndexService`, inventory, เอกสาร order/payment, multi-company, load test
- ข้อ P1 ของ product-bks.md (policy หลักฐานอ่อนถูกแนบท้ายคำตอบสินค้า) ไม่ได้ตรวจซ้ำในรอบนี้ สถานะยังไม่ทราบ

---

## แหล่งอ้างอิง

- [LLM-based Semantic Search for Conversational Queries in E-commerce (arXiv 2601.16492)](https://arxiv.org/abs/2601.16492)
- [Instacart: revamping query understanding with LLMs (ZenML LLMOps database)](https://www.zenml.io/llmops-database/revamping-query-understanding-with-llms-in-e-commerce-search)
- [Elastic: self-querying retrievers](https://www.elastic.co/search-labs/blog/self-querying-retrievers)
- [Algolia: agentic search for ecommerce](https://www.algolia.com/fr/blog/ecommerce/agentic-search-for-ecommerce)
- [Shopify shop-chat-agent](https://github.com/Shopify/shop-chat-agent)
- [Shopify: about metafields](https://shopify.dev/apps/custom-data/metafields)
- [commercetools: product types and attributes](https://docs.commercetools.com/merchant-center/product-types)
- [PGroonga versus textsearch and pg_trgm](https://pgroonga.github.io/reference/pgroonga-versus-textsearch-and-pg-trgm.html)
