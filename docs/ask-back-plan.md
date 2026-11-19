# แผนออกแบบ "การถามกลับ" (Ask-back / Clarification)

> 18 พ.ย. 2026 · branch `decisionLog` · สถานะ: **แผน ยังไม่ได้ลงมือ** · อ่านคู่กับ `docs/audit-full-fable.md` (U1, U5, S1) และ `docs/audit-product.md` (SC1 preset lexicon)
> เป้าหมาย: เมื่อคำถามไม่ชัด ให้บอทถามกลับแบบเจาะจง 1 คำถาม แทนการ fallback ไปหาแอดมิน โดย **ส่วนใหญ่ไม่เรียก LLM เพิ่ม**, ไม่ถามพร่ำเพรื่อ, และใช้ซ้ำได้หลายธุรกิจ / หลายร้าน (SaaS)

---

## 0. สรุปสั้น

- **ถามเมื่อจำเป็นเท่านั้น:** ถามก็ต่อเมื่อ (1) มีความกำกวมจริง (2) ความหมายที่เป็นไปได้ให้ **คำตอบต่างกัน** (3) แก้เองจากบริบท/slot ไม่ได้ (4) ยังไม่เคยถามเกิน 2 ครั้งในเรื่องเดียวกัน ถ้าแก้เองได้ให้ rewrite แล้วค้นต่อ ไม่ถาม
- **ตัวเลือกต้องมาจากข้อมูลของร้าน** (title/entity/slot ใน KB หรือ catalog) ไม่ให้ LLM แต่งตัวเลือก — ตรงกับหลัก "grounded clarification" ในงานวิจัย
- **ต้องจำคำถามที่ค้างไว้** (pending clarify) เพื่อให้ข้อความถัดไปของลูกค้าถูกตีความเป็นคำตอบของคำถามนั้น ไม่งั้นการถามกลับไม่ลู่เข้า — นี่คือชิ้นที่ repo ยังไม่มีและสำคัญที่สุด
- **Core ไม่มีคำของธุรกิจ:** กรณีที่ต้องถาม slot (เช่น รอบรถต้องมี ต้นทาง/ปลายทาง/วัน) อยู่ใน preset ของธุรกิจ; lexicon สร้างจาก KB ของแต่ละ company
- **LLM เพิ่ม = 0** สำหรับ 8 จาก 9 กรณี; กรณีเดียวที่ใช้ LLM (C9) ใช้ field เพิ่มใน grounded call เดิม ไม่ใช่คอลใหม่

---

## 1. สิ่งที่มีอยู่แล้วใน repo

| ชิ้น | ที่ | สถานะ |
|---|---|---|
| action `CLARIFY` | `chatbot/intent/utils/route-stages.ts` (เลือกเมื่อ `fallbackReason=MISSING_USER_INFORMATION`) | ✅ มี แต่ใช้กรณีเดียว |
| ข้อความถามกลับ | `CLARIFY_MESSAGE = 'ช่วยอธิบายเพิ่มเติมหน่อยได้มั้ยคะ'` (`shared/knowledge/knowledge-routing.constants.ts`) | ⚠️ ข้อความกลาง ไม่บอกว่าขาดอะไร |
| อ้างอิงหายไป ("แล้วอันนั้นล่ะ") | `retrieval-query-planner.service.ts` → `missingReference` | ✅ ตรวจได้แบบ deterministic |
| แยกคำถามย่อย + เขียนคำถามใหม่ | classifier: `standaloneQuery`, `questions[]` (`low-confidence-classifier.prompt.ts`) | ✅ แต่ทำงานเฉพาะ LOW_CONFIDENCE |
| คำตอบบางส่วน | grounded: `unanswered[]` + `PARTIAL_ANSWER_NOTE` | ✅ ใช้แทนการถามได้ในกรณีหลายคำถาม |
| สินค้าขาดข้อมูล | product search status `MISSING_INPUT` + `safeProductAnswer` ("ระบุสีและขนาด") | ✅ เป็นต้นแบบ slot-filling ได้ |
| สถานะ flow ต่อผู้ใช้ | `UserSessionService` (`chat:session:{userId}`, flow `REGISTER` ฯลฯ) | ✅ มี แต่ **ไม่ควรเอา clarify ไปปนกับ REGISTER** (ดู §5) |
| ตัวเลือกแบบปุ่ม (quick reply) | — | ❌ ไม่มี (grep ไม่พบ Flex/QuickReply ใน `src`) |
| สถานะคำถามที่ค้าง | — | ❌ ไม่มี |

---

## 2. แนวปฏิบัติจากภายนอก (สรุปที่นำมาใช้)

| แหล่ง | สิ่งที่ได้ | นำมาใช้อย่างไร |
|---|---|---|
| Rasa `FallbackClassifier` / Two-Stage Fallback | ใช้ **2 เกณฑ์**: confidence ต่ำ และ **ระยะห่างระหว่างอันดับ 1–2 ต่ำกว่า `ambiguity_threshold`**; ถาม "คุณหมายถึง … ใช่ไหม" ก่อน แล้วค่อยให้พิมพ์ใหม่ แล้วค่อย fallback; ไม่มี threshold สากล ต้องปรับตามข้อมูล | C5, C8 ใช้ `scoreGap` + ตัวเลือกจากอันดับต้น; จำกัด 2 รอบแล้ว handoff |
| Dialogflow CX / Amazon Lex | **slot/parameter ที่ required** มี prompt และ reprompt ของตัวเอง, no-match ต่อ parameter แยกจาก no-match ของทั้ง flow | C4: preset กำหนด slot ที่ต้องมี + คำถามของแต่ละ slot |
| Enterprise assistant (arXiv 2502.00537) | การถามกลับ **ทำให้ประสบการณ์แย่ลง** ควร **แก้กำกวมเองด้วย rewrite** ก่อน; ใช้ taxonomy ของความกำกวม + ตัวตรวจแบบ rule/feature ชนะ LLM baseline | ขั้น "แก้เองก่อนถาม" (§4 ขั้น B/C) + taxonomy C1–C9 |
| AT-CoT (alphaxiv 2504.12113) | **ระบุชนิดความกำกวมก่อน** แล้วค่อยสร้างคำถามที่ตรงชนิด | แต่ละกรณีมีแม่แบบคำถามของตัวเอง ไม่ใช้คำถามกลาง |
| RAC (alphaxiv 2601.11722), PAQA (arXiv 2402.16608) | คำถามกลับต้อง **อิงหลักฐานจาก corpus**; คุณภาพ retrieval กำหนดคุณภาพคำถาม; ถามแคบ ๆ ทีละเรื่องดีกว่าลิสต์ทุกความหมาย | ตัวเลือก ≤ 3 จาก KB ของร้าน, ถามทีละ slot |
| ClariQ / ConvAI3 (arXiv 2009.11352, 2109.05794) | แยก 2 งาน: **(1) ต้องถามไหม** (ให้คะแนนความจำเป็น 1–4) **(2) ถามอะไร**; ต้องชั่งระหว่างถามมากเกินกับตอบไม่ตรง | แยก "ตัวตัดสินว่าต้องถาม" ออกจาก "ตัวสร้างคำถาม" และวัดผลแยกกัน (§9) |

แหล่งอ้างอิงอยู่ท้ายเอกสาร หลายแหล่งเป็นงานวิจัย/เอกสารผู้ขาย ใช้เป็นทิศทาง ไม่ใช่ค่าตัวเลขที่ลอกมาใช้ได้ตรง ๆ

---

## 3. กรณีที่ต้องถามกลับ (taxonomy)

| # | กรณี | ตัวอย่าง | สัญญาณตรวจ (deterministic) | ถามว่าอะไร | LLM |
|---|---|---|---|---|---|
| **C1** | คำถูกตัดกลางคำ | "สงขลา กรุงเท" | คำท้ายเป็น prefix แท้ของคำใน lexicon และไม่ใช่คำเต็ม | "หมายถึง **กรุงเทพมหานคร** ใช่ไหมคะ" (ยืนยันคำ) | 0 |
| **C2** | พิมพ์ผิดในชื่อสำคัญ | "สงขวา", "กรุงเทฟ" | คำใกล้ชื่อใน lexicon ด้วย edit distance ≤ 1–2 (ระดับตัวอักษร) **และ** retrieval ไม่มั่นใจ หรือมี ≥ 2 ชื่อที่ใกล้พอกัน | "หมายถึง **สงขลา** ใช่ไหมคะ" | 0 |
| **C3** | มีแต่ entity ไม่บอกว่าต้องการอะไร | "สงขลา", "เสื้อลินิน" | entity ≤ 1, ไม่มีคำเจตนา, ข้อความสั้น | เสนอหัวข้อที่ KB มีสำหรับ entity นี้: "ต้องการดู **รอบรถ** หรือ **ราคาตั๋ว** สงขลาคะ" | 0 |
| **C4** | ขาด slot ที่ธุรกิจบังคับ | "รอบรถไปเชียงใหม่" (ไม่บอกต้นทาง/วัน), "เสื้อลินินมีไหม" (ไม่บอกไซส์ เมื่อจำเป็น) | preset ระบุ slot ที่ต้องมีต่อหัวข้อ; slot ใดยังว่างหลังเติมจากบริบท | ถามทีละ slot: "เดินทางจากจังหวัดไหนคะ" | 0 |
| **C5** | อันดับต้นคะแนนใกล้กันแต่คนละความหมาย | "รอบรถ สงขลา กรุงเทพ" → "สงขลา→กรุงเทพ" กับ "กรุงเทพ→สงขลา" | `scoreGap` < เกณฑ์ **และ** top-k ต่าง `entityKey`/ทิศทาง/topic | "ต้องการ **สงขลา → กรุงเทพฯ** หรือ **กรุงเทพฯ → สงขลา** คะ" | 0 |
| **C6** | อ้างอิงลอย | "แล้วอันนั้นล่ะ" (ไม่มีประวัติ) | `missingReference` (มีอยู่แล้ว) | ถ้ามี entity ล่าสุดใน slot memory → "หมายถึง **X** ใช่ไหมคะ" ไม่มี → ถามว่าหมายถึงอะไร | 0 |
| **C7** | หลายคำถามในข้อความเดียว | "เปิดกี่โมง จอดรถได้ไหม" | `questions[]` ≥ 2 | **ไม่ถาม** — ตอบส่วนที่ตอบได้ + `unanswered` (มีแล้ว) | 0 |
| **C8** | ไม่มั่นใจ แต่มีแคนดิเดตใกล้เกณฑ์ | LOW_CONFIDENCE + classifier BUSINESS + ไม่มี evidence ผ่านเกณฑ์ | candidate 1–3 อยู่ใต้เกณฑ์ไม่ไกล (เช่น cosine 0.65–0.75) | "คุณหมายถึงเรื่องไหนคะ" + ปุ่มชื่อ FAQ 2–3 อัน ก่อน handoff (two-stage fallback) | 0 |
| **C9** | มี evidence แต่โมเดลตอบ INSUFFICIENT เพราะคำถามกำกวม | log 2:05 "สงขลา กรุงเท" → `askedAbout` เดา | grounded `decision=INSUFFICIENT_CONTEXT` + field `clarify` ที่โมเดลเลือกจาก evidence id | คำถามสั้นที่โมเดลเขียน **อ้าง evidence id** + validator | 0 คอลเพิ่ม (field ใน call เดิม) |

### เมื่อไหร่ **ไม่ถาม**

- retrieval มั่นใจและ top-1 ชนะชัด (DIRECT, หรือ RAG ที่ `scoreGap` สูง) — log 2:29 "สงขวา" เจอแถวถูกด้วย vector 0.81 ⇒ ไม่ต้องถามเรื่องสะกดผิด
- ทุกความหมายให้คำตอบเดียวกัน หรือตอบรวมทั้งสองได้สั้น ๆ (เช่น ค่าส่งเท่ากันทุกจังหวัด)
- เติมจากบริบทได้ (slot memory, ประวัติ 3 turn, `standaloneQuery`)
- greeting / menu / cancel / sticker / ระหว่าง REGISTER (flow สมัครมีคำถามของตัวเอง)
- ห้องถูก admin mute อยู่ (`chat:control`)
- ถามเรื่องเดียวกันครบ 2 ครั้งแล้ว → handoff แทน (loop guard)

---

## 4. Pipeline

```
ข้อความเข้า
 │
 ├─ [A] Pending-clarify resolver  (ทำก่อนทุกอย่าง ยกเว้น mute/ban)
 │       มีคำถามค้าง? → ลองจับคู่คำตอบ (ปุ่ม / ลำดับ / ข้อความตรงตัวเลือก / entity ที่ขาด)
 │         ├─ จับคู่ได้  → สร้าง resolvedQuery จาก option → ข้าม C1–C5 → ไป retrieval
 │         ├─ เป็นคำถามใหม่ชัดเจน → ล้าง pending → ไปตามปกติ
 │         └─ ไม่ชัด    → attempts+1 ; ครบ 2 → handoff ; ไม่ครบ → ถามซ้ำแบบสั้น
 │
 ├─ gates เดิม: rich menu → rule (greet/cancel/register) → trusted rule
 │
 ├─ [B] Pre-retrieval (0 I/O, ใช้ lexicon จาก snapshot ใน memory)
 │       normalize → C1 (ตัดกลางคำ) → C6 (missingReference เดิม)
 │       → "แก้เองก่อน": เติม slot จาก slot memory / ประวัติ
 │       → C3 (entity เดียวไม่มีเจตนา)
 │
 ├─ retrieval เดิม (exact → BM25+vector → RRF → conflicts)
 │
 ├─ [C] Post-retrieval (0 LLM)
 │       C2 (ชื่อสะกดผิด + ไม่มั่นใจ) → C5 (tie คนละความหมาย)
 │       → C4 (slot ที่ preset บังคับยังขาด) → C8 (LOW แต่มีแคนดิเดตใกล้)
 │
 ├─ decide → DIRECT / RAG → grounded call (1)
 │
 └─ [D] Post-answer (0 คอลเพิ่ม)
         C9: decision=INSUFFICIENT_CONTEXT + clarify ผ่าน validator → ถามกลับ
             ไม่ผ่าน → fallback เดิม (+ handoff)
```

**กติกาการตัดสินสุดท้าย (ทุกกรณีต้องผ่าน):**

```
ask = isAmbiguous(kind)
   && answersDiffer(options)        // ตัวเลือกชี้คนละแถว/คนละค่า
   && !resolvableFromContext()      // slot memory / history เติมไม่ได้
   && askCount(topic) < MAX_ASKS    // ค่าเริ่ม 2
   && !muted && !inRegistration
```

**ลำดับความสำคัญเมื่อหลายกรณีพร้อมกัน:** C6 > C1 > C2 > C4 > C5 > C3 > C8 > C9 (ถามเรื่องที่ทำให้ค้นไม่ได้ก่อน แล้วค่อยเรื่องที่ทำให้เลือกไม่ได้) และถาม **ครั้งละหนึ่งเรื่อง**

---

## 5. สถานะคำถามที่ค้าง (pending clarify)

**ทำไมแยกจาก `chat:session`:** กฎ `.claude/rules/handoff.md` ให้ state ของ REGISTER อยู่รอดเมื่อออกนอกเรื่องได้ ถ้า clarify เขียนทับ session เดียวกันจะทำ flow สมัครพัง จึงใช้ key แยก

```ts
// Redis: chat:clarify:{conversationId}   TTL 10 นาที (ปรับได้ต่อ company)
type PendingClarify = {
  id: string;                 // สุ่มต่อการถาม ใช้ตรวจ postback
  turnId: string;             // turn ที่ถาม (idempotency: replay ไม่สร้างใหม่)
  kind: 'TRUNCATED' | 'TYPO' | 'NO_INTENT' | 'MISSING_SLOT' | 'TIE' | 'MISSING_REFERENCE' | 'NEAR_MISS' | 'MODEL';
  originalQuery: string;      // ผ่าน redactPii แล้ว
  slot?: string;              // C4: slot ที่กำลังถาม
  filledSlots?: Record<string, string>;
  options: Array<{
    id: string;               // 'o1' ...
    label: string;            // ข้อความบนปุ่ม (ตัดตามข้อจำกัดช่องทาง)
    query: string;            // query ที่จะใช้ค้นเมื่อเลือก (สร้างจากข้อมูลร้าน)
    ref?: string;             // 'MK:<id>' | 'AP:<id>' | 'P:<productId>' ถ้ามี
  }>;
  attempts: number;
  askedAt: number;
};
```

**การจับคู่คำตอบ (resolver) — deterministic ทั้งหมด**

1. postback `clarify=<id>:<optionId>` → ต้องตรงกับ `id` ใน pending **และ** option มีอยู่จริง (postback มาจากฝั่งผู้ใช้ ห้ามเอา payload ไปเป็น query ตรง ๆ)
2. ตัวเลข/ลำดับ: "1", "อันแรก", "ข้อ 2"
3. ข้อความตรง/มี label หรือ entity ของ option (หลัง normalize) — ถ้าตรงมากกว่าหนึ่ง option ถือว่าไม่ชัด
4. C4: ค่าที่ตรง slot (ชื่อจังหวัดจาก lexicon, วันที่จาก date parser ของ preset)
5. ไม่ตรงเลย + retrieval ของข้อความใหม่มั่นใจ → เป็นคำถามใหม่ ล้าง pending

**Context policy:** ข้อความถามกลับ `EXCLUDE` (ไม่ใส่ประวัติ 3 turn ให้เปลืองที่) และเมื่อ resolve แล้ว turn คำตอบบันทึก context ด้วย `userText = resolvedQuery` เพื่อให้ follow-up ถัดไปเห็นคำถามเต็ม

---

## 6. การแสดงผลต่อช่องทาง

| ช่องทาง | วิธี | หมายเหตุ |
|---|---|---|
| LINE | Quick Reply (action `postback` พร้อม `displayText`) ≤ 3 ตัวเลือก + ข้อความนำ | ตรวจข้อจำกัดความยาว label และจำนวนปุ่มกับเอกสาร LINE Messaging API ก่อนใช้ (ไม่ได้ตรวจรอบนี้) |
| App | ส่ง `options[]` ใน `meta` ของ response ให้ client วาดปุ่ม; ส่งกลับด้วย `clientMessageId` เดิม | ระบบ dedupe มีอยู่แล้ว |
| Facebook | quick replies ของ Messenger | ทีหลัง |
| ทุกช่องทาง (fallback) | ข้อความเลขลำดับ "1) … 2) …" ให้ตอบเป็นตัวเลขได้ | resolver ข้อ 2 รองรับ |

ต้องเพิ่มใน `ChatResponse`: `quickReplies?: { label: string; postback: string }[]` แล้วให้ `LineChannelAdapter.saveReply` / `ChannelStoreAdapter` ส่งต่อ (delivery เก็บใน `lineDelivery` เพื่อ retry ได้ครบ)

---

## 7. ใช้ซ้ำหลายธุรกิจ / SaaS

**หลัก:** core รู้แค่ "ชนิดของความกำกวม" และ "วิธีจับคู่คำตอบ" — คำศัพท์ slot และแม่แบบคำถามเป็น **ข้อมูลของธุรกิจ** อยู่ใน preset (ต่อยอดจาก `BUSINESS_PRESETS` และข้อเสนอ `lexicon/capabilities` ใน audit-product SC1)

```ts
// products/attributes/presets/*.preset.ts หรือ preset ระดับ knowledge
type ClarifyPolicy = {
  enabled: Partial<Record<ClarifyKind, boolean>>;  // เปิด/ปิดทีละกรณี
  maxAsks: number;                                 // ค่าเริ่ม 2
  tieGap: number;                                  // เกณฑ์ C5 (ปรับจากข้อมูลจริง)
  nearMissFloor: number;                           // เกณฑ์ C8
  topics: Array<{
    key: string;                 // 'schedule' | 'fare' | 'size' ...
    triggers: string[];          // คำเจตนาที่ชี้หัวข้อนี้ ('รอบ','เวลาออก')
    label: Record<string, string>; // ต่อภาษา: { th: 'รอบรถ', en: 'Schedule' }
    requiredSlots: Array<{
      key: string;               // 'origin' | 'destination' | 'date' | 'size'
      source: 'PLACE' | 'DATE' | 'OPTION' | 'TEXT';
      ask: Record<string, string>; // { th: 'เดินทางจากจังหวัดไหนคะ' }
    }>;
  }>;
};
```

| ธุรกิจ | ตัวอย่าง policy |
|---|---|
| รอบรถ (TRANSPORT) | topic `schedule` ต้องมี `origin`, `destination` (PLACE) และ `date` (DATE); C5 เปิด (ทิศทางสำคัญ) |
| เสื้อผ้า (ECOMMERCE) | topic `stock` ต้องมี `size` เมื่อสินค้ามีหลายไซส์ (ใช้ `MISSING_INPUT` ของ product search ที่มีอยู่แล้ว) |
| คลินิก | topic `appointment` ต้องมี `branch`, `date`; G7 strict mode → C9 ปิด (ไม่ให้โมเดลเขียนคำถามเอง) |
| ร้าน IT | topic `compat` ต้องมี `model` (OPTION/TEXT) |

**SaaS**
- lexicon (คำ, สถานที่, entity) **สร้างต่อ `companyId`** จาก snapshot KB/catalog ของร้านนั้น cache แยกต่อ company และ invalidate พร้อม `knowledge:changed`
- policy: ค่า default จาก preset ของ `company.productBusinessType`; override ต่อร้านเก็บ DB ภายหลัง (ทางเข้าเดียวเหมือน `loadCatalogContext`)
- Redis key ทั้งหมดผูก `conversationId` (unique ต่อร้านอยู่แล้ว) — เมื่อทำ SaaS เต็มให้ prefix `companyId` ตามแผนรวม
- แม่แบบข้อความต่อภาษา (สอดคล้องกับ U4 auto-language)

---

## 8. Guard

1. ตัวเลือก **ต้องมาจากข้อมูลร้าน** (แถว KB/สินค้า/ค่า slot ที่มีจริง); โมเดลไม่สร้างตัวเลือก
2. C9 (คำถามจากโมเดล): ต้องอ้าง evidence id ที่ส่งไป, ≤ 120 ตัวอักษร, ห้ามมีตัวเลข/ราคา/เวลา/เบอร์, ห้ามยืนยันว่า "มี/ไม่มี"; ไม่ผ่าน → fallback เดิม
3. postback ตรวจกับ pending เสมอ ไม่ใช้ payload เป็น query
4. `MAX_ASKS` ต่อหัวข้อ + TTL ของ pending; ครบแล้ว handoff (ใช้ `requestAdmin` เดิม)
5. ไม่ทับ REGISTER session; ไม่ทำงานเมื่อ mute
6. `originalQuery` ผ่าน `redactPii` ก่อนเก็บใน Redis
7. ทุกการถามรายงาน `decisionTrace.answer({ mode: 'CLARIFY', fallbackReason: 'CLARIFY_<KIND>' })` (กฎ repo: answer branch ใหม่ต้องรายงาน)

---

## 9. วัดผล (แยก "ต้องถามไหม" กับ "ถามดีไหม" ตาม ClariQ)

| เมตริก | นิยาม | ใช้ทำอะไร |
|---|---|---|
| Clarify rate | turn ที่ถามกลับ / turn ทั้งหมด | ถ้าสูงเกิน (เช่น > 10%) แปลว่าถามพร่ำเพรื่อ |
| Resolution rate | turn ถัดไปที่ resolver จับคู่ได้ / การถามทั้งหมด | วัดว่าตัวเลือกตรงใจลูกค้า |
| Clarify → answered | หลัง resolve ได้ ANSWER (ไม่ fallback) | วัดว่าการถามช่วยจริง |
| Wasted clarify | ลูกค้าตอบซ้ำ/บ่น ("ก็บอกแล้ว") หรือเลือกตัวเลือกที่ตรงกับ top-1 เดิมเสมอ | ชี้ว่ากรณีนั้นไม่ควรถาม → ปรับเกณฑ์ |
| Abandon | ไม่ตอบภายใน TTL | ตัวเลือกไม่ตรง/ข้อความยาวไป |
| Handoff ลดลง | fallback+handoff ก่อน/หลังเปิด | ผลทางธุรกิจ |

**Eval set (เพิ่มใน `retrieval-eval.cases.ts` + spec ที่ยังต้องเขียน):** "สงขลา กรุงเท" (C1), "รอบรถ สงขวา กรุงเทพ" (ไม่ต้องถาม), "สงขลา" (C3), "รอบรถไปเชียงใหม่" (C4), "รอบรถ สงขลา กรุงเทพ" (C5 ถ้า gap ต่ำ), "แล้วอันนั้นล่ะ" ไม่มีประวัติ (C6), "เปิดกี่โมง จอดรถได้ไหม" (C7 ไม่ถาม), "ค่าส่งเท่าไหร่" (ไม่ถาม), คำธรรมดาที่เป็น prefix ("ไป") เพื่อวัด false positive — และดึงข้อความจริงจาก `decisionLogs` ที่ fallback เพื่อวัดว่าแต่ละกรณีจับได้กี่ %

---

## 10. ลำดับการทำ (แต่ละขั้นเปิดแบบ shadow ก่อน: log ว่า "จะถาม" โดยยังตอบแบบเดิม)

| ขั้น | งาน | ไฟล์หลัก | เกณฑ์ผ่าน |
|---|---|---|---|
| 0 | ดึงข้อความ fallback จริงจาก `decisionLogs` มาจัดกลุ่มตาม C1–C9 | — | รู้ว่ากรณีไหนเกิดบ่อยจริง ก่อนลงแรง |
| 1 | Pending state + resolver + quick reply ใน `ChatResponse` | ใหม่: `chatbot/clarify/clarify-state.service.ts`, `clarify-resolver.ts`; แก้ `chatbot.service.ts` (case CLARIFY), `intent-router.service.ts` (เรียก resolver ก่อน gates), `line-channel.adapter.ts`, `channel-store.adapter.ts` | ถามแล้วตอบ "1" ได้คำตอบถูก; replay ไม่ถามซ้ำ |
| 2 | C6 ให้เจาะจงขึ้น + C5 + C8 (ใช้ผล retrieval เดิม) | `route-stages.ts` (fallbackReason ใหม่ `AMBIGUOUS_CANDIDATES`, `NEAR_MISS`), `knowledge-retrieval.service.ts` (ส่ง top-k + `scoreGap` ออกมา) | handoff ลดลง, wasted clarify ต่ำ |
| 3 | C1 + C2 + C3 (lexicon) | ใหม่: `shared/knowledge/query-lexicon.ts` (สร้างจาก `AnswerPatternCacheService` snapshot) | false positive ต่ำบน eval |
| 4 | C4 slot-filling ตาม preset (เริ่ม TRANSPORT + ใช้ `MISSING_INPUT` ของ product) | preset `ClarifyPolicy`, date/place resolver (ดู `future/product-bks.md`) | ถาม slot ทีละตัวจนครบแล้วตอบได้ |
| 5 | C9 field `clarify` ใน grounded schema + validator | `grounded-response.schema.ts`, `knowledge-instruction.ts`, `answer.service.ts` | ต้องผ่าน Thai retrieval/prompt test ตามกฎ repo |

ข้อควรจำ: การเปลี่ยน prompt/threshold/scoring ต้องมี Thai test (`.claude/rules/rag-ai.md`); action ใหม่ต้องแก้ router + `ChatbotService` switch + decision trace + `contextPolicy` (CLAUDE.md §13 ข้อ 6)

---

## 11. ความเสี่ยง

- **ถามมากเกินไป** — ข้อสรุปที่ชัดที่สุดจากงานวิจัยคือการถามทำให้ประสบการณ์แย่ลงถ้าไม่จำเป็น จึงต้องผ่านกติกา §4 ทุกข้อ + วัด wasted clarify
- **ตัดคำภาษาไทย** — prefix/edit distance ทำบน lexicon ของร้าน ไม่พึ่ง segmenter อย่างเดียว (ผลทดสอบเดิม: "ไหมอ่ะ" แตกเป็น "ไห|มอ่ะ")
- **เกณฑ์ tieGap / nearMissFloor** — ไม่มีค่าสากล (Rasa ระบุเช่นกัน) ต้องปรับจาก log ต่อธุรกิจ
- **ตัวเลือกล้าสมัย** — pending เก็บ ref; ตอน resolve ต้องตรวจว่าแถวยัง active
- **ข้อจำกัด Quick Reply ของ LINE** — ต้องตรวจเอกสารก่อนกำหนดความยาว label/จำนวนปุ่ม

---

## แหล่งอ้างอิง

- Rasa: [Fallback and human handoff (3.x)](https://legacy-docs-oss.rasa.com/docs/rasa/fallback-handoff/) · [TwoStageFallbackPolicy](https://legacy-docs-oss.rasa.com/docs/rasa/reference/rasa/core/policies/two_stage_fallback) · [Failing gracefully (blog)](https://blog.rasa.com/failing-gracefully-with-rasa-core/) · [ambiguity threshold (forum)](https://forum.rasa.com/t/the-difference-in-nlu-confidences-for-the-top-two-intents-is-lower-than-the-ambiguity-threshold-0-10/17887)
- Dialogflow CX: [Generative fallback](https://cloud.google.com/dialogflow/cx/docs/concept/generative-fallback) · [Codelab: handle errors gracefully](https://codelabs.developers.google.com/codelabs/dialogflow-generative-fallback)
- Amazon Lex (คำตอบในชุมชน ไม่ใช่เอกสารทางการ): [AWS re:Post](https://repost.aws/questions/QU7nbCD2CwQgSoSwU2jfu53A/using-specific-intents-for-recognition)
- งานวิจัย: [Detecting Ambiguities to Guide Query Rewrite (arXiv 2502.00537)](https://arxiv.org/html/2502.00537v1) · [PAQA (arXiv 2402.16608)](https://arxiv.org/html/2402.16608v1) · [AT-CoT (alphaxiv 2504.12113)](https://alphaxiv.org/overview/2504.12113v2) · [RAC (alphaxiv 2601.11722)](https://www.alphaxiv.org/abs/2601.11722) · [Disambiguation in Conversational QA: A Survey (arXiv 2505.12543)](https://arxiv.org/html/2505.12543v2) · [ClariQ / ConvAI3 (arXiv 2009.11352)](https://arxiv.org/abs/2009.11352v1) · [Open-domain corpora with clarifying questions (arXiv 2109.05794)](https://arxiv.org/pdf/2109.05794)
