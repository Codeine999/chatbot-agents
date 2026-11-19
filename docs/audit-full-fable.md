# Audit ทั้งระบบ (Fable) — chatbot-agents

> สแนปช็อต: 17 พ.ย. 2026 · branch `decisionLog` @ `7bd2dfb` · ตรวจแบบอ่าน code + รันโพรบสั้น ๆ (ไม่แก้ code ใน repo)
> เป้าหมาย: ทำให้ chatbot "ฉลาดและใช้งานจริง" ระดับสู้ Zaapi ได้ โดยยังเรียก LLM ≤ 3 ครั้งต่อข้อความ และ deploy ได้หลายธุรกิจ
> ขอบเขต: ทุกส่วนของ chat pipeline ยกเว้นโมดูล **register / payment / admin** (ตามที่ขอ)
> ไฟล์ที่ 2 (`saas-fable.md`) ยังไม่ทำ — ตามที่บอกให้ทำงานแรกก่อน

สัญลักษณ์: ✅ ยืนยันจาก code/รันจริง (มี `ไฟล์:บรรทัด`) · 🔎 อนุมานจาก code/grep ต้องมี test ยืนยัน · 📚 อ้างแหล่งภายนอก
ระดับ: 🔴 สูง (ผิดพลาดต่อลูกค้า/ความปลอดภัย/เงิน) · 🟠 กลาง · 🟡 ต่ำ

---

## 0. สรุปสั้น (อ่านส่วนนี้ส่วนเดียวก็พอ)

**ภาพรวม:** แกนของระบบ "ถูกทิศ" และดีกว่าบอทส่วนใหญ่ — retrieval-first, ตอบแบบ grounded มี evidence id, ราคา/สต็อกมาจาก DB ผ่าน token, billing idempotent, มี decision log ต่อ turn
สิ่งที่ยังขาดไม่ใช่ "โมเดลที่ใหญ่ขึ้น" แต่เป็น 4 เรื่อง:

1. **ความเข้าใจภาษาคนก่อนค้นหา** — ไม่มี normalizer ภาษาไทย (เลขไทย, ตัวสะกดซ้ำ, "เท่าไหร่/เท่าไร", "อ่ะ"), ไม่รวมข้อความที่ลูกค้าพิมพ์ติดกันหลายบรรทัด, และการ rewrite คำถามต่อเนื่องเกิดเฉพาะตอน LOW_CONFIDENCE (§5 U1–U3)
2. **ตรวจคำตอบก่อนส่ง** — ตัวเลข/เวลา/ราคา/เบอร์ในคำตอบ FAQ ยังไม่ถูกเทียบกับ evidence (A1) ฝั่ง product มี renderer แล้ว ฝั่ง FAQ ยังไม่มี
3. **Guard ตอน Redis/ระบบล่ม และตอนโดนโจมตี** — abuse/budget/pipeline-switch เป็น fail-open ทั้งหมด (G1), PII redaction ไม่ครอบเลขบัตร 16 หลักและเลขไทย (G3 — รันจริงแล้ว)
4. **ขนาดและการนำไปใช้ซ้ำ** — cache KB จำกัด 500 แถว/ตาราง เกินแล้ว DIRECT ปิดเงียบ ๆ (K1), threshold cosine ตายตัวไม่พกพาข้ามธุรกิจ (K3), ภาษาตอบ hardcode ไทย (U4)

### ตอบคำถามที่ถามมา

| คำถาม | คำตอบ |
|---|---|
| ต้องเพิ่ม **reranker** ไหม | **ยังไม่ต้อง** — ดู §4.1 ปัญหาที่เจอไม่ใช่ "เรียงลำดับผิด" แต่เป็น "ไม่เข้าใจคำถาม" และ "ไม่ตรวจคำตอบ" ให้ทำ deterministic rerank features (มีบางส่วนแล้ว) + วัดด้วย eval ก่อน ค่อยเปิด reranker เมื่อเข้าเงื่อนไขใน §4.1 |
| ต้องเพิ่ม **classifier** ไหม | **ไม่เพิ่มตัวที่สอง** — มีอยู่แล้ว (`AiIntentClassifierService`) ให้ "ขยายและรวม" เป็น *understand-once* (classify + rewrite + แยกคำถามย่อย + ภาษา ในคอลเดียว) และให้ทำงานกับ follow-up สั้น ๆ ด้วย ไม่ใช่เฉพาะ LOW_CONFIDENCE (§4.2–4.3) |
| ทำให้ RAG เข้าใจภาษาคนมากขึ้น โดย LLM ยัง 1–3 คอล | ส่วนใหญ่ย้ายงาน "ฉลาด" ไปไว้ **ก่อนและหลัง** LLM แบบ 0 คอล: normalize, debounce, slot memory, **index-time enrichment** (สร้างคำถามหลายสำนวนต่อ 1 FAQ ตอนบันทึก), claim verifier, quick-reply (§4.3–4.6) |
| ช่องโหว่ | §5 และ §6 — จุดที่ต้องรีบ: A1, G1, G3, U7 |
| ต้องเพิ่ม guard/pipeline อะไร | §6 (guard 10 ข้อ) และ §7 (stage ใหม่ 9 ข้อ พร้อมต้นทุน LLM ของแต่ละข้อ) |
| feature เพื่อสู้ Zaapi | §8 — อย่าแข่งทุกฟีเจอร์ ให้ชนะที่ **ความถูกต้อง (ราคา/สต็อกจาก DB)**, **ความโปร่งใสต้นทุน (credit ledger)**, **preset ต่อธุรกิจ** |

### Top 12 สิ่งที่ควรทำก่อน (เรียงตามผลตอบแทน/ความเสี่ยง)

| # | งาน | ID | ขนาด | LLM เพิ่ม |
|---|---|---|---|---|
| 1 | Claim verifier: ตัวเลข/เวลา/ราคา/เบอร์/URL ในคำตอบต้องอยู่ใน evidence | A1 | M | 0 |
| 2 | ตอบกลับเมื่อลูกค้าส่งเสียง/ตำแหน่ง/ไฟล์/วิดีโอ/รูป (ตอนนี้เงียบ) | U7 | S | 0 |
| 3 | Thai query normalizer (เลขไทย, ตัวซ้ำ, คำสะกดคู่, particle) | U2 | S | 0 |
| 4 | Burst debounce รวมข้อความที่พิมพ์ติดกัน (ข้าม instance) | U3 | M | 0 (ลดคอล) |
| 5 | Fail-closed สำหรับ AI budget / degrade เป็น template เมื่อ Redis ล่ม | G1 | S | 0 |
| 6 | แก้ PII: เลขบัตร 16 หลัก, เลขไทย, "บัญชี" โดด ๆ + retention ของ rawEvent | G3 | S–M | 0 |
| 7 | Cache `aiSetting` ใน process + invalidate ผ่าน pub/sub (ตอนนี้อ่าน DB ทุกคอล) | P1 | S | 0 |
| 8 | Index-time enrichment: สร้างคำถามสำนวนอื่น/คำพ้อง ตอนบันทึก KB | K6 | M | offline |
| 9 | Understand-once: ให้ classifier/rewrite ทำงานกับ follow-up สั้นแม้ retrieval "มั่นใจ" | U1 | M | 0 (ลดจาก 2→1 ใน LOW path) |
| 10 | Hard cap 3 LLM calls/turn (ใช้ counter ที่ trace มีอยู่แล้ว) | G5 | S | 0 |
| 11 | Quick-reply "คุณหมายถึง…ไหม" แทนการ handoff ทันที | S1 | M | 0 |
| 12 | แก้ cap 500 แถว (DB-side lexical หรือ shard) + metric/alert | K1 | L | 0 |

---

## 1. วิธีตรวจ

- อ่านเส้นทางเต็ม: webhook/ingress → `LineEventsProcessor` → `MessageProcessorService` → `ChatbotService` → `IntentRouterService`/`route-stages` → `KnowledgeRetrievalService` → `AiChatService` → delivery, รวม session/context, abuse/ban/rate-limit/budget, embedding, decision trace, App/Facebook channel, credential services
- รันโพรบจริง 1 ชุด (ไม่แก้ repo) กับ `redactPii`, `normalizeText`, `Intl.Segmenter('th')` — ผลอยู่ใน G3, U2
- **ไม่ได้รัน** test suite ทั้ง repo, load test, หรือเรียก LLM/embedding จริง → ตัวเลข latency/คุณภาพทั้งหมดใน doc นี้เป็น "สิ่งที่ต้องวัด" ไม่ใช่ผลวัด
- ค้นข้อมูลภายนอกด้วย web search (รายการใน §13) — ระบุไว้ทุกที่ที่ใช้
- ไม่ครอบ: register, payment, admin, และ product pipeline (อยู่ใน `docs/audit-product.md`)

---

## 2. สิ่งที่ดีอยู่แล้ว (อย่าทำพัง ระหว่างแก้)

1. **Retrieval-first แล้วค่อยตัดสินใจ** — router ไม่ตอบเอง; rule gate ที่ไม่มี I/O มาก่อน; exact FAQ ไป DIRECT ได้ 0 LLM / 0 embedding
2. **Grounded output มีโครงสร้าง** — `{askedAbout, directlyAnswered, decision, evidenceIds, unanswered}`; evidence id ที่ไม่รู้จักถูกทิ้งแทนที่จะทิ้งทั้งคำตอบ; รองรับ partial answer + handoff
3. **ราคา/สต็อกไม่มาจาก prose** — product token renderer (`{{e1.price}}`) ดี และเป็นจุดขายที่ชัดกับ Zaapi (§8)
4. **Idempotency ทั้งเส้น** — `turnId` ใช้ซ้ำใน claim, billing, commerce turn; replay ไม่เรียก LLM ซ้ำ
5. **Billing เข้มงวด** — ทุกคอล LLM/embedding ผ่าน `runBilled`; `InsufficientCreditException`/`PendingAiUsageError` ถูก rethrow
6. **Cache KB หลาย instance** — pub/sub `knowledge:changed` + TTL สำรอง
7. **App channel fail-closed** ดีกว่า LINE ตั้งใจ (`app-abuse.service.ts` ประกาศไว้ใน doc comment ว่า Redis ล่มแล้วปฏิเสธ + บอกเหตุผลด้วย 429)
8. **Decision log** มี `llm.calls`, tokens, route, fallbackReason ต่อ turn — เป็นฐานของ eval/โมนิเตอร์ที่ควรต่อยอด ไม่ใช่สร้างใหม่
9. **ชุด eval + audit spec มีอยู่แล้ว** (`knowledge/test/retrieval-eval.cases.ts` 448 บรรทัด, `chatbot/audit/*`, `test/live/*`) — ขาดแค่ vector จริงและเคสจาก log จริง (K4)

---

## 3. สถานะรายการจาก audit เก่า

| รายการ | สถานะ | หลักฐาน/หมายเหตุ |
|---|---|---|
| classifier ให้ `standaloneQuery` + `questions[]` + re-retrieve 1 ครั้ง | ✅ ทำแล้ว | `intent-router` / `route-stages` / classifier prompt (แต่ใช้เฉพาะ LOW_CONFIDENCE → U1) |
| ทางออก `NOT_BUSINESS` จาก grounded | ✅ ทำแล้ว | `answer.service.ts:395` |
| partial answer + handoff (`unanswered`) | ✅ ทำแล้ว | grounded prompt + `answer.service.ts` |
| ทิ้ง evidence id ที่ไม่รู้จัก | ✅ ทำแล้ว | CLAUDE.md §5 |
| ตรวจ `finishReason=length` | ◐ ตรวจแต่ไม่ retry | `answer.service.ts:441` → A2 |
| C13 log `user session …` ทุกข้อความ | ❌ ยังอยู่ | `chatbot.service.ts:79` → G4 |
| F2 ลำดับข้อความต่อ user ข้าม process | ❌ ยังอยู่ | `line-events.processor.ts:59` (Map ใน memory) |
| F3 retry job ไม่มี delay (รอ sweep 15s) | ❌ (ตาม CLAUDE.md; ไม่ได้ตรวจซ้ำรอบนี้) | |
| F4 ไม่ตรวจตัวเลขในคำตอบ FAQ | ❌ ยังอยู่ | → A1 |
| F5 GENERAL ไม่ดู confidence | ❌ ยังอยู่ | → A3 |
| F6 evidence อยู่ใน system instruction | ❌ ยังอยู่ | → A4 |
| F8 redactPii ไม่ครอบชื่อ/ที่อยู่ + snapshot ไม่มี retention | ❌ ยังอยู่ และกว้างกว่าเดิม | → G3 |
| F10 budget นับต่อคอล | ❌ ยังอยู่ | → P5 |
| F14 `isUsableKnowledge` ถูก comment ใน `eligible()` | ◐ ยังอยู่ แต่ผลจำกัดกว่าที่คิด | → K2 |
| F1 รหัสผ่านเก็บ plaintext ใน delivery/history | ⛔ นอกขอบเขต (อยู่ในโมดูล register) — ไม่ได้ตรวจซ้ำ | **ต้องแก้ก่อนใช้งานจริง** เพราะ `lineDelivery.text`/`lineChatHistory` อยู่ใน pipeline นี้ |
| "cjson empty array → `{}`" ใน Lua ของ context | ✅ ปิดได้: ไม่เป็นปัญหา | `load-context.service.ts:177` sanitizer คืน `undefined` ซึ่งเท่ากับไม่มี refs |

---

## 4. ทำให้ RAG "ฉลาด" โดยยัง LLM ≤ 3 คอล

### 4.1 Reranker — ยังไม่ใส่ เพราะอะไร และเมื่อไหร่ควรใส่

**เหตุผลที่ยังไม่ใส่**
- ที่ระบบเลือก context สุดท้ายมีแค่ ≤3 รายการ จากแคนดิเดตที่ผ่าน RRF (BM25 + vector 2 ตาราง) — ปัญหาที่เจอใน §5 ส่วนใหญ่เป็น "คำถามถูกตีความไม่ได้" (U1–U3), "ไม่มีรูปประโยคอื่นของคำตอบเดียวกัน" (K6), และ "ตรวจคำตอบไม่ได้" (A1) ไม่ใช่ "ของถูกอยู่อันดับ 5 แต่ถูกเลือกอันดับ 1 ผิด"
- Reranker (cross-encoder) เพิ่ม latency บนทุก turn ที่ไม่ใช่ DIRECT และเป็น dependency เพิ่ม ส่วนหลักฐานภาษาไทยบางมาก — ค้นแล้วไม่พบ benchmark reranker × ภาษาไทยที่เผยแพร่ ต้องวัดเองกับ golden set 📚
- ผลของ Anthropic Contextual Retrieval: การเติมบริบทให้ chunk ก่อน embed/BM25 ลด retrieval failure (top-20) ลง 49% (5.7%→2.9%) และเพิ่ม reranking ลงไปอีกเป็น 1.9% — ส่วนที่ใหญ่สุดมาจาก **การทำให้ document เข้าใจง่ายตอน index** ไม่ใช่ reranker และตัวเลขนี้วัดบน corpus ใหญ่ top-20 ไม่ใช่ FAQ ที่เลือก 3 รายการ 📚

**สิ่งที่ทำแทน (0 LLM คอล)**
1. *Deterministic rerank features* ที่มีอยู่แล้วบางส่วน (`entityKey/topicKey`, `filterByPlace`, lexical coverage) — เพิ่ม: title/questionExamples match boost, exact-number/unit match, และ margin ระหว่างอันดับ 1–2
2. *Index-time enrichment* (K6) — ลดความจำเป็นของ reranker ที่ต้นเหตุ
3. *Eval ที่วัดแยก*: Recall@10 (retrieval) vs Top-1/Top-3 accuracy (ranking)

**เงื่อนไขที่ควรเปิด reranker (เสนอ — ตัวเลขเป็นข้อเสนอของผม ต้องปรับตามข้อมูลจริง)**
- eval บน golden set จริงแสดง Recall@10 ≥ ~95% แต่ Top-3 accuracy ต่ำกว่า ~85% (= ปัญหาเรียงลำดับจริง), หรือ KB เกิน ~2–5k แถวหลังแก้ K1
- ตัวเลือก: hosted multilingual rerank API หรือ `bge-reranker-v2-m3` (cross-encoder ฐาน XLM-R; ภาษาไทยมาจากโมเดลฐาน) ต่อท้าย RRF เฉพาะเมื่อ margin top-1/top-2 ต่ำ (ไม่ใช่ทุก turn) + ผ่านระบบ billing wrapper ตามกฎ repo

### 4.2 Classifier — ขยายตัวเดิม ไม่เพิ่มตัวใหม่

ตัวเดิมถูกเรียกเมื่อ route = LOW_CONFIDENCE เท่านั้น แล้วให้ `BUSINESS|GENERAL` + `standaloneQuery` + `questions[]`
ช่องว่าง: (1) follow-up สั้น ๆ ที่ retrieval "มั่นใจ" แต่ผิดเรื่องไม่ผ่านจุดนี้เลย (U1) (2) GENERAL ไม่ดู confidence (A3) (3) ไม่มีสัญญาณภาษา/ความเร่งด่วน/อารมณ์ (4) LOW path = 2 คอลต่อกัน (classifier → grounded)

### 4.3 ออกแบบ "Understand-once" (ทำเป็นขั้นตอน ไม่ใช่รื้อ)

```
ข้อความ (หลัง debounce + normalize)
  ├─ rule gates เดิม (0 LLM)
  ├─ needs-context? = ข้อความสั้น/ขึ้นต้น "แล้ว/ส่วน/อันนี้/ล่ะ/ด้วย" / ไม่มี entity / retrieval top1 ไม่ตรง entity ที่คุยค้าง
  │     └─ true  → เติม slot จากบทสนทนา (deterministic) → ถ้ายังไม่ชัด ใช้ understand call
  └─ retrieval เดิม → decideFromRetrieval
        ├─ DIRECT / RAG ชัด        → grounded call (1)
        └─ LOW / needs-context     → UNDERSTAND+ANSWER call (1) ← รวม classifier + rewrite + grounded
                                         └─ ถ้า standaloneQuery เปลี่ยนผล retrieval → grounded อีก 1 (รวมสูงสุด 2)
```

สคีมาที่เสนอสำหรับ call รวม (ต่อยอด `GROUNDED_JSON_SCHEMA` เดิม):

```json
{
  "intent": "BUSINESS | SMALLTALK | GENERAL | HUMAN_REQUEST",
  "language": "th | en | zh | ...",
  "standaloneQuery": "คำถามที่เข้าใจได้ในตัวเอง",
  "subQuestions": ["..."],
  "decision": "ANSWER | INSUFFICIENT_CONTEXT | NOT_BUSINESS",
  "askedAbout": "...", "directlyAnswered": true,
  "answer": "...", "evidenceIds": ["AP:..."], "unanswered": [],
  "urgency": "NORMAL | URGENT"
}
```

ข้อควรระวัง: การรวมเพิ่ม output tokens และเสี่ยง "ตอบจาก evidence อ่อน" — จึงให้ rollout แบบ **shadow**: รัน prompt รวมแบบ offline บน turn ที่ LOW_CONFIDENCE จาก `decisionLogs` เทียบกับผลเดิม (fallback rate, wrong-answer rate, tokens, latency) ก่อนเปิดจริง ตามกฎ repo (เปลี่ยน prompt/threshold ต้องมี Thai retrieval test)

### 4.4 งบ LLM ต่อ turn (เป้าหมาย ≤ 3 และบังคับจริง)

| เส้นทาง | วันนี้ | เป้าหมาย |
|---|---|---|
| menu / cancel / canned / sticker template / DIRECT | 0 | 0 |
| greeting/opener | 1 | 0–1 (template ได้ถ้า rule มั่นใจ) |
| RAG มั่นใจ | 1 | 1 (reasoning ปรับตามความยาก P2) |
| LOW → classifier → grounded | 2 (+1 embedding ถ้า re-search) | **1** (+1 ถ้า re-search เปลี่ยนผล) |
| grounded → NOT_BUSINESS → general | 2 | 2 |
| LOW → classifier → NOT_BUSINESS → general | สูงสุด 3 | 2 |
| product (plan + answer [+ repair]) | 2–3 | 2–3 |
| รูป | 0 (handoff เงียบ) | 0–1 (vision คัดแยกชนิดรูป) |

**Hard cap:** `DecisionTraceService` นับ `llm.calls` อยู่แล้ว ([decision-trace.service.ts:117](../src/modules/decision-log/decision-trace.service.ts#L117)) แต่ไม่เคย "บังคับ" — เพิ่ม guard ที่ทางเข้า `UsersAiProviderService.generate`: เกิน 3 คอลใน turn เดียว → โยน `TurnBudgetExceeded` แล้วลงเป็น fallback (G5)

### 4.5 Index-time enrichment (K6) — ตัวเพิ่มความเข้าใจที่คุ้มสุด

ตอนบันทึก/แก้ AnswerPattern/MicroKnowledge ให้งาน async (แบบ outbox เหมือน `productIndexJobs`) สร้างต่อแถว:
- 5–10 รูปแบบคำถามที่ลูกค้าไทยพิมพ์จริง (สุภาพ/ห้วน/คำย่อ/สะกดคู่/ภาษาพูด) + คำพ้อง/คำที่เกี่ยวข้อง
- ใส่ลง `questionExamples` ฝั่งที่ระบบสร้างเอง (แยก flag `generated=true` ให้แอดมินดู/ลบได้) และให้ `answer-pattern-document.ts` / `micro-knowledge-document.ts` นำไปรวมในข้อความที่ embed และ BM25
- ต้นทุน: LLM 1 คอล/แถว/ครั้งที่แก้ — ผ่าน billing wrapper (ตามกฎ), **0 คอลตอนตอบลูกค้า**
- เสี่ยง: คำถามที่สร้างอาจชน FAQ อื่น → ตรวจ similarity ระหว่างแถว (ตรวจ `conflicts()` ตอน index) และห้ามให้ generated ไปเปิด DIRECT (DIRECT ใช้เฉพาะ `questionExamples` ที่แอดมินเขียน)

### 4.6 Claim verifier (A1) — guard 0 คอล ที่ควรมีก่อนอย่างอื่น

หลัง grounded call ผ่านด่านเดิมแล้ว ตรวจแบบ deterministic:
1. ดึง "ข้อเท็จจริงที่ตรวจได้" จาก `answer`: ตัวเลข (รวมเลขไทย, `1,000`, `1.5k`, `พัน/หมื่น`), เวลา (`09:00–18:00`, `9 โมง`), เปอร์เซ็นต์, เบอร์โทร, URL, อีเมล, วันที่
2. normalize ทั้ง answer และ evidence ที่อ้าง (เลขไทย→อารบิก, ตัดคอมมา)
3. ทุก fact ต้องปรากฏใน evidence ที่อ้างใน `evidenceIds` → ผ่าน; ไม่ผ่าน → ตัวเลือกตามลำดับ: (a) render คำตอบจาก evidence ตรง ๆ (โหมด DIRECT-like) (b) fallback + บันทึก `fallbackReason='UNVERIFIED_CLAIM'` ใน decision log
4. ธุรกิจเสี่ยง (คลินิก/กฎหมาย/การเงิน) ตั้ง `strictVerbatim` → ห้ามมี fact ใหม่ใด ๆ

ต้นทุน: CPU ล้วน, latency ไม่กี่ ms — ปิดช่อง F4 ได้ทั้งหมด

### 4.7 สิ่งที่ไม่แนะนำ (ตอนนี้)

- Agentic multi-step search / LLM-as-router ทุก turn — เกินงบ 1–3 คอลและช้า
- LLM judge ออนไลน์ทุก turn — ใช้ **offline sampling** (2–5% ของ turn กลางคืน) แทน
- HyDE / query expansion ด้วย LLM ตอนตอบ — ใช้ index-time enrichment แทน (ถูกกว่า เร็วกว่า)
- ย้ายไป framework RAG สำเร็จรูป — ระบบมี billing/idempotency/trace เฉพาะตัวที่ framework ทำให้ไม่ได้

---

## 5. Findings รายส่วน

### 5.1 U — การเข้าใจภาษา / บทสนทนา

**U1 🟠 การ rewrite คำถามต่อเนื่องเกิดเฉพาะ LOW_CONFIDENCE** ✅🔎
- `retrieval-query-planner.service.ts:6-8,45-54` เติมเฉพาะแบบ "model X" ด้วย regex `FOLLOW_UP` จากข้อความ 6 ข้อความ/160 ตัวอักษร; ส่วน `standaloneQuery` จาก classifier ใช้เมื่อ LOW_CONFIDENCE เท่านั้น
- Scenario: ลูกค้าคุยเรื่องบริการ A แล้วถาม "แล้วค่าส่งล่ะ" → ตรงกับ FAQ "ค่าจัดส่งสินค้า" ทั่วไป cosine ≥ 0.75 → route RAG ตอบค่าส่งทั่วไป ไม่ใช่ของ A (ไม่เข้า classifier เลย)
- แก้: `needsContext()` แบบ deterministic (สั้น ≤ ~6 token, ขึ้นต้น/ลงท้ายคำเชื่อม, ไม่มี entity, entity ของ top-1 ≠ entity ที่คุยค้าง) → ส่งเข้า understand-once แม้ retrieval มั่นใจ (§4.3) และใช้ slot memory (U6)

**U2 🟠 ไม่มี Thai query normalizer** ✅ (รันจริง)
```
normalizeText('ราคา ๕๐๐ บาทไหมคะ')   → 'ราคา ๕๐๐ บาทไหมคะ'     (เลขไทยค้าง ไม่เทียบกับ "500")
normalizeText('ได้ววววว ค้าบบบ')       → ไม่ยุบตัวอักษรซ้ำ
Segmenter('ราคาเท่าไหร่ครับ')          → ราคา|เท่า|ไหร่|ครับ   vs   'เท่าไรคับ' → ราคา|เท่าไร|คับ
Segmenter('ส่งต่างจังหวัดไหมอ่ะ')       → ส่ง|ต่าง|จังหวัด|ไห|มอ่ะ   ← "ไหม" แตกเป็น "ไห|มอ่ะ"
```
([text.utils.ts:1-8](../src/utils/text.utils.ts#L1), [thai-bm25.ts](../src/shared/text/thai-bm25.ts); grep ไม่พบ synonym/typo/fuzzy ใน `src`)
- ผล: "เท่าไหร่" กับ "เท่าไร" ได้ token ต่างกัน → BM25 พลาด; คำลงท้ายแบบ "อ่ะ" ทำให้ "ไหม" แตก; ราคาเลขไทยเทียบกับ KB ไม่ได้ (ยังกระทบ A1 verifier ด้วย)
- แก้ (0 LLM): ก่อน segment — แปลงเลขไทย→อารบิก, ยุบอักษรซ้ำ ≥3 → 1–2, ตารางสะกดคู่ (เท่าไหร่/เท่าไร/เท่าไหร, ค่ะ/คะ/คับ/ครับ/ค้าบ, อ่ะ/อะ/ป่ะ/มั้ย/ไหม), ตัด particle ท้ายประโยคก่อน segment, normalize สกุลเงิน/หน่วย; ต่อด้วย protected-terms จาก KB (ชื่อสินค้า/ยี่ห้อ) กัน segmenter ตัดผิด
- ทดสอบ: เพิ่มเคสใน `retrieval-eval.cases.ts` (§10)

**U3 🟠 ไม่รวมข้อความที่พิมพ์ติดกัน (no debounce)** 🔎
- grep `debounce|coalesce` ใน `channels/` และ `conversation/` ไม่พบ → ลูกค้าพิมพ์ "สนใจค่ะ" / "ราคาเท่าไหร่" / "ส่งไหม" 3 ข้อความ = 3 turn, 3 retrieval, อาจ 3 คอล LLM, ตอบ 3 ข้อความ (ซ้ำซ้อน/ไม่สอดคล้อง) และกิน burst limit (10/10s) + AI budget รายชั่วโมง
- แก้: หน่วงต่อ user 1.2–2.5 วินาที แล้วรวมข้อความ text ที่มาในช่วงนั้นเป็น 1 turn (ใช้ Redis list + BullMQ delayed job ที่ dedupe ด้วย key ต่อ user เพื่อให้ข้าม instance — ไม่ใช้ Map ใน memory ตามกฎ F2); `turnId` = id ข้อความล่าสุดของกลุ่ม; ข้อความที่ถูกรวมให้บันทึกเป็น "merged" ใน decision log

**U4 🟠 ภาษาตอบ hardcode เป็นไทย** ✅
- [ai-chat.constants.ts:3,23](../src/modules/ai/prompt/ai-chat.constants.ts#L3) "ตอบเป็นภาษาไทย", [knowledge-instruction.ts:27](../src/modules/chatbot/answer/grounded/knowledge-instruction.ts#L27); `eligible()` กรอง `language === scope.language` ([knowledge-retrieval.service.ts:352-357](../src/modules/knowledge/knowledge-retrieval.service.ts#L352))
- ลูกค้าอังกฤษ/จีน/พม่า/ลาว (ร้านท่องเที่ยว ชายแดน คลินิกคนต่างชาติ) ได้คำตอบไทยเสมอ
- แก้: `AiSetting.answerLanguage = 'auto' | 'th' | …`; ตรวจภาษาลูกค้าด้วย Unicode-range (0 LLM) หรือฟิลด์ `language` ใน understand-once; embedding รองรับข้ามภาษาอยู่แล้ว จึงอนุญาตให้ KB ภาษาไทยตอบคำถามภาษาอื่นได้ (ปรับ `eligible()` ให้กรอง KB language แยกจากภาษาที่ลูกค้าถาม)

**U5 🟡 หลายคำถามในข้อความเดียว ใช้ retrieval query เดียว** 🔎
- `questions[]` มีเฉพาะ LOW path; `selectContexts` เลือก ≤3 รายการ — คำถามที่ 2 ต่างหัวข้ออาจไม่มี evidence (prompt รองรับ partial answer ก็จริง แต่ผลคือตอบครึ่งเดียวทั้งที่ KB มี)
- แก้: ถ้า `subQuestions ≥ 2` ให้ retrieve ต่อคำถามย่อย (embedding เพิ่มได้ ไม่เพิ่ม LLM) แล้วรวม evidence ต่อ quota

**U6 🟡 ไม่มี entity/slot memory** ✅
- context = 3 turn / TTL 30 นาที / เฉพาะ `INCLUDE` ([load-context.service.ts](../src/modules/chatbot/context/load-context.service.ts)); จังหวัด/สาขา/รุ่น/จำนวนที่ลูกค้าบอกไว้หลุดหลัง 3 turn
- แก้: Redis hash ต่อ conversation `{entityKey, topicKey, place, product/variant refs, language}` อัปเดตจากผล retrieval/planner (0 LLM) TTL เท่ากัน; ใช้ใน U1 และ `filterByPlace`

**U7 🟠 ข้อความที่บอทไม่รองรับถูกเงียบ** ✅
- [line-webhook.adapter.ts:162-166](../src/modules/channels/line/webhook/line-webhook.adapter.ts#L162): message type นอกจาก `text|image|sticker` (audio, video, file, location) → `continue` ไม่สร้าง turn ไม่ตอบ ไม่ handoff
- [chatbot.service.ts:301-313](../src/modules/chatbot/chatbot.service.ts#L301): รูป → handoff **เงียบ** ลูกค้าไม่ได้รับข้อความใด ๆ (ตั้งใจให้คนดู แต่ลูกค้าไม่รู้ว่ารับแล้ว)
- ลูกค้าไทยส่งเสียง/ตำแหน่ง/สลิป/รูปสินค้าบ่อย → รู้สึกว่าบอทตาย
- แก้ระยะสั้น (0 LLM): template "รับ{รูป/ข้อความเสียง/ตำแหน่ง}แล้วค่ะ เจ้าหน้าที่จะตรวจสอบ" ครั้งเดียวต่อ `waiting_admin` (ใช้กลไก `ALREADY_WAITING` เดิม) + ส่งเข้า handoff; ระยะกลาง: เสียง → STT → pipeline ปกติ, ตำแหน่ง → `knowledge-places` (สาขา/พื้นที่จัดส่ง), รูป → vision คัดแยก (สลิป/สินค้า/ความเสียหาย) แล้วค้นสินค้าจากรูป

### 5.2 K — Retrieval

**K1 🟠 Cap 500 แถว/ตาราง ทำให้ DIRECT ปิดและ BM25 มองไม่เห็นส่วนท้าย** ✅
- [answer-pattern-cache.service.ts:33,160-165](../src/modules/knowledge/answer-pattern-cache.service.ts#L33): `take: 500` เรียงตาม `priority desc, updatedAt desc`; ถึง cap แล้วมีแค่ warn ครั้งเดียว: *"lower-priority knowledge is not searched lexically and DIRECT answers are off"* (`warnAtCap`)
- vector search ยังอ่าน DB สด จึงไม่หายทั้งหมด แต่ exact FAQ/BM25 ของส่วนท้ายหาย → คุณภาพตกแบบเงียบ ๆ เมื่อธุรกิจเติม KB เกิน 500 (ทั้งธุรกิจเดียวที่โต และเมื่อเอาหลายธุรกิจมารวมกัน)
- แก้: ย้าย lexical ไปฝั่ง DB (Postgres FTS + `pg_trgm`, หรือ extension BM25) ต่อ company; เก็บ exact-match index (hash ของ normalized `questionExamples`) ในตารางแยกเพื่อให้ DIRECT ไม่ขึ้นกับ cap; ระหว่างนี้ให้ **ส่ง metric + alert** เมื่อแถว ≥ 80% ของ cap (ตอนนี้มีแค่ log)

**K2 🟡 `isUsableKnowledge` ใน `eligible()` ถูก comment แต่ปลายทางยังกรองอยู่** ✅
- [knowledge-retrieval.service.ts:358](../src/modules/knowledge/knowledge-retrieval.service.ts#L358) (import ที่ :37 ค้าง) แต่ [answer.service.ts:95,119](../src/modules/chatbot/answer/answer.service.ts#L95) และ [answer-pattern.service.ts:74](../src/modules/knowledge/answer-pattern.service.ts#L74) ยังเรียก
- ผล: แถวที่นโยบายถือว่าใช้ไม่ได้ ยัง "กินที่" ใน `selectedItems ≤3`, ยก confidence/สร้าง conflict ได้ แล้วถูกตัดตอนตอบ → fallback ทั้งที่มีแถวดีอยู่ถัดไป
- นโยบายนี้เป็น **regex บนเนื้อหา** (`\bsnapshot\b|ข้อมูลทดสอบ|ห้ามใช้…`) — ร้าน IT ที่ขายบริการ "snapshot backup" จะถูกตัดคำตอบจริงทิ้ง (false positive ข้ามธุรกิจ)
- แก้: เปลี่ยนเป็นสถานะบนแถว (`status: ACTIVE|ARCHIVED|TEST` หรือใช้ `active=false`) แล้วกรองที่ query/`eligible()` ที่เดียว ลบ regex

**K3 🟠 threshold cosine 0.75 ตายตัว ปรับจากโมเดล/KB ชุดเดียว** ✅🔎
- CLAUDE.md §4 / `knowledge-routing.constants.ts`: calibrate บน gemini-embedding-2; ค่า absolute ไม่พกพาข้ามธุรกิจ/ความหนาแน่นของ KB/ภาษา
- แก้: ใช้สัญญาณสัมพัทธ์ร่วม — margin(top1−top2), z-score เทียบการกระจายของ similarity ใน corpus ของ company, lexical coverage; มี job calibrate ต่อ company จาก `decisionLogs` (ผล 👍/👎 ใน O2 เป็น label) แทนค่าคงที่

**K4 🟡 Eval ปัจจุบัน mock ค่า vector** ✅
- หัวไฟล์ `retrieval-eval.cases.ts`: *"Vector similarity is MOCKED per case … not how good the embedding model is"* → วัดตรรกะตัดสินใจ ไม่ได้วัดคุณภาพ retrieval จริง
- แก้: golden set จากคำถามจริง (ปกปิด PII) + รัน embedding จริงใน `test/live/` (มีโครงอยู่) + รายงาน Recall@k/MRR/fallback rate (§10)

**K5 🟡 `selectContexts` ≤3 รายการ/12,000 ตัวอักษรเท่ากันทุกธุรกิจ** 🔎 — ควรเป็นค่าต่อ company และปรับตามจำนวน subQuestions (ดู U5)

**K6 🟠 ไม่มี index-time enrichment** — ดู §4.5 (เป็นข้อเสนอ ไม่ใช่บั๊ก) ผลกระทบสูงสุดต่อ "เข้าใจภาษาคน" ต่อบาทที่ลงทุน

### 5.3 A — การตอบ / grounding

**A1 🔴 ตัวเลข/เวลา/ราคา/เบอร์ในคำตอบ FAQ ไม่ถูกตรวจกับ evidence** ✅
- ด่านปัจจุบัน: `decision=ANSWER` + `directlyAnswered=true` + มี evidenceId ที่อยู่ใน `selectedItems` เท่านั้น — เนื้อหา `answer` ไม่ถูกเทียบ
- Scenario: KB "เปิด 09:00–18:00 จันทร์–เสาร์" → โมเดลสรุปเป็น "เปิดทุกวัน 9 โมงถึง 5 โมงเย็น" ผ่านทุกด่าน → ลูกค้ามาร้านตอนปิด
- แก้: §4.6 (claim verifier) — เป็นงานอันดับ 1

**A2 🟠 `TRUNCATED_OUTPUT` → fallback + handoff ทันที ไม่ retry** ✅🔎
- [answer.service.ts:441](../src/modules/chatbot/answer/answer.service.ts#L441); grounded ใช้ `reasoningEffort: 'medium'` ([:378](../src/modules/chatbot/answer/answer.service.ts#L378)) — โมเดล reasoning กิน output budget ด้วย อาจตัดก่อนจบ JSON → ลูกค้าเจอ fallback "spurious" และแอดมินถูกเรียก
- แก้: retry 1 ครั้งด้วย reasoning ต่ำกว่า/limit สูงกว่า (นับอยู่ใน hard cap 3); วัดอัตรา `fallbackReason=TRUNCATED_OUTPUT` จาก `decisionLogs` ก่อนตั้งค่า; ตรวจค่า `AI_GENERATION_CONFIG.maxOutputTokens` เทียบ reasoning (ยังไม่ได้อ่านค่าจริง)

**A3 🟠 GENERAL ไม่ดู confidence + `answerGeneral` ไม่มีกรอบความสามารถ** ✅ (F5)
- classifier คืน GENERAL แม้ confidence ต่ำ → `answerGeneral` ([answer.service.ts:141](../src/modules/chatbot/answer/answer.service.ts#L141) → `generateText` temp 0.4, reasoning low, [:307-309](../src/modules/chatbot/answer/answer.service.ts#L307)) ตอบจากความรู้โมเดล โดย `ragContext: []` และมีแค่ `GENERAL_RULES` คุม — ถ้าจริง ๆ เป็นคำถามธุรกิจที่ KB ยังไม่มี โมเดลอาจแต่งข้อมูลร้าน
- แก้: confidence < ~0.6 หรือมีคำชี้ธุรกิจ (ราคา/เวลา/สาขา/ส่ง) → ไม่เข้า general ให้ CLARIFY/quick-reply; prompt general ต้องมี "ไม่ให้ข้อมูลร้านที่ไม่มีในหลักฐาน ไม่สัญญาสิทธิ/ส่วนลด/การจอง"

**A4 🟠 Evidence อยู่ใน system instruction** ✅ (F6)
- ปลอดภัยพอเมื่อ KB เขียนโดยแอดมินร้านเอง (และมี escape `& < >`) แต่ **ความเสี่ยงโตตามแหล่ง KB**: นำเข้าจาก URL/PDF/marketplace/รีวิว ฯลฯ → เป็นช่องทาง indirect prompt injection (OWASP LLM01) 📚
- แก้: ติด provenance (`trusted: admin|imported`) ต่อแถว; ครอบ evidence ด้วย delimiter แบบสุ่มต่อ turn และ datamarking (อย่าใช้ delimiter คงที่/คาดเดาได้); ย้าย evidence ไปเป็นข้อความ `user`-side ที่ติดป้าย "ข้อมูลอ้างอิง ไม่ใช่คำสั่ง"; output ผ่าน verifier (A1) จึงสร้างความเสียหายได้จำกัด

### 5.4 G — Guard / ความปลอดภัย / abuse

**G1 🟠 ระบบ fail-open ทั้งชุดเมื่อ Redis มีปัญหา** ✅
- spam: [spam-detector.service.ts:100](../src/modules/abuse/spam-detector.service.ts#L100) · pipeline switch: [pipeline-switch.service.ts:42-48](../src/modules/conversation/message/pipeline-switch.service.ts#L42) (ตั้งใจ "ไม่ให้บอทเงียบ") · rate limit default `failOpen ?? true` ([rate-limit.service.ts:63](../src/modules/usage/rate-limit/rate-limit.service.ts#L63)) · ban: [ban.service.ts:51-60](../src/modules/abuse/ban.service.ts#L51) `isBanned` catch → `false` · AI budget ใช้ค่า default ของ rate-limit
- ผล: Redis สะดุดช่วงใดก็ตาม = ไม่มี ban/spam/budget พร้อมกัน ขณะที่คอล LLM ยังวิ่ง (กระเป๋าเครดิตยังกันยอดรวมต่อบริษัท แต่ไม่กันผู้โจมตีรายเดียวกินงบทั้งร้าน)
- แก้: แยกตามระดับ — เส้นทางที่เสียเงิน (AI budget) → **fail-closed แบบ degrade**: ตอบ template/DIRECT เท่านั้นไม่เรียก LLM; มี limiter สำรองใน process (token bucket ต่อ user, ข้ามไม่ได้ข้าม instance แต่กันสแปมรุนแรง); เส้นทางที่ไม่เสียเงิน (pipeline switch) คง fail-open แต่ **ต้องมี metric/alert** เมื่อ fail-open เกิดขึ้น

**G2 🟠 AI budget: นับ global ก่อน user** ✅
- [ai-budget.service.ts:30-63](../src/modules/usage/rate-limit/ai-budget.service.ts#L30): `rl:ai:global` (30/วินาที ใช้ร่วมทุก user) ถูก `consume` ก่อนเช็ค `rl:ai:user:*` → user ที่เกินโควต้าชั่วโมงแล้วยังกินโควต้า global ทุกครั้งที่ลอง (ผู้ใช้เดียวที่ถูกจำกัดแล้วยัง "เบียด" คนอื่นได้ตามอัตรา burst ของ LINE)
- แก้: เช็ค user ก่อน (ถูกกว่า, local-first), แล้วค่อย global; หรือ Lua เดียวที่ตรวจ 2 ตัวแบบ atomic ไม่หักเมื่อ deny

**G3 🟠 PII redaction มีช่องใหญ่ (รันจริง)** ✅
```
'บัตร 4111 1111 1111 1111 หมดอายุ 12/28'  → ไม่ถูกปิด   (regex เลขบัตรประชาชนล็อกที่ 13 หลักพอดี + (?!\d))
'โทร ๐๘๑๒๓๔๕๖๗๘ ครับ'                       → ไม่ถูกปิด   (เลขไทย)
'บัญชี 123-4-56789-0 กสิกร'                  → ไม่ถูกปิด   (ต้องมีคำว่า "เลขบัญชี"/"บัญชีธนาคาร")
'ชื่อ สมชาย ใจดี อยู่ 99/9 ถ.สุขุมวิท …'     → ไม่ถูกปิด   (ชื่อ/ที่อยู่ — F8)
'เลขบัตรประชาชน 1-2345-67890-12-3'          → ปิดได้ ✔
```
([text.utils.ts:11-27](../src/utils/text.utils.ts#L11)) ใช้กับ context ใน Redis และ log — ส่วน `lineChatHistory.rawEvent`, `processedLineWebhookEvent.event`, `commerceTurns.input` เก็บดิบไม่มี retention (F8)
- แก้: normalize เลขไทยก่อน redact; เลขบัตร 13–19 หลัก + Luhn; "บัญชี" โดด ๆ + 10–12 หลัก; passport; รหัสไปรษณีย์ + คำนำหน้าที่อยู่ (ถ.,ซ.,ต.,อ.,จ.) แบบ heuristic; NER เบา ๆ สำหรับชื่อหลัง "ชื่อ/คุณ" (ผิดพลาดแบบ over-redact ได้); กำหนด retention เป็น job (ตัด `rawEvent` เหลือ field จำเป็น) — ต้องแก้ตามกฎ prisma.md (migration + backfill)

**G4 🟡 `logger.warn` ทุกข้อความ** ✅ — [chatbot.service.ts:79](../src/modules/chatbot/chatbot.service.ts#L79) `` `user session ${session}'` `` พิมพ์ `[object Object]` ทุกข้อความที่ระดับ warn (noise + กลบ warn จริง) และ **อย่า "แก้" ด้วย `JSON.stringify`** — session ของ flow สมัครสมาชิกเก็บข้อมูลสมาชิกระหว่างทางจะรั่วลง log ให้ลบทิ้ง

**G5 🟠 ไม่มีเพดานจำนวนคอล LLM ต่อ turn ที่บังคับจริง** ✅ — counter มี ([decision-trace.service.ts:117](../src/modules/decision-log/decision-trace.service.ts#L117)) ไม่มีตัวบังคับ; ปัจจุบันโครงสร้างจำกัดโดยธรรมชาติที่ ~3 แต่การเพิ่ม stage (verifier-repair, retry A2, understand-once) จะดันเกินได้ง่าย → ใส่เพดานก่อนเพิ่มอะไร (§4.4)

**G6 🟠 วนเงียบเมื่อรอแอดมิน** ✅ (พฤติกรรมตาม CLAUDE.md §3) + grep ยืนยันไม่มีเวลาทำการ
- เมื่อห้อง `waiting_admin` แล้ว fallback ถัดไปคืน `text:''` (กลไก `ALREADY_WAITING`) → ลูกค้าถามต่อกี่ข้อก็ไม่มีเสียงตอบ ถ้าแอดมินไม่ตอบ (กลางคืน/วันหยุด) ลูกค้าถูกเมินไม่มีกำหนด; grep `business hours|เวลาทำการ|นอกเวลา|office hours` ใน `src` พบแค่ในไฟล์ prompt ของ classifier ([low-confidence-classifier.prompt.ts](../src/modules/chatbot/intent/low-confidence-classifier.prompt.ts)) → **ไม่มีการตั้งเวลาทำการ/SLA ในระบบ**
- แก้: ข้อความ "ยังรอเจ้าหน้าที่อยู่" ที่ส่งซ้ำได้ทุก N นาที (rate-limited ต่อห้อง) + นอกเวลาทำการแจ้งเวลาตอบกลับ + ตัวเลือก "ให้บอทลองตอบเองหลังรอ X นาที" (Zaapi มี 1–120 นาที — §8)

**G7 🟡 โหมดธุรกิจเสี่ยง (`strictVerbatim`)** 🔎 — seed/eval มีคลินิก/ยาสมุนไพร (ดูคอมเมนต์ใน classifier) → ธุรกิจสุขภาพ/กฎหมาย/การเงินต้องตอบ "ตามหลักฐานคำต่อคำ + disclaimer" และห้าม general answer; ทำเป็น flag ใน `AiSetting`

**G8 🟠 ข้อ F2/F3/F9 ที่ยังเปิด (ต่อจากรอบก่อน)** ✅/ตาม CLAUDE.md — ลำดับข้อความต่อ user อยู่ใน `Map` ของ process เดียว ([line-events.processor.ts:59](../src/modules/channels/line/worker/line-events.processor.ts#L59)) → รัน ≥2 instance แล้วตอบสลับลำดับ; retry job ไม่มี delay; REPLY error อื่น → `UNKNOWN` ไม่มีใครรู้ — ระหว่างทำ debounce (U3) ให้ออกแบบ key ต่อ user ใน Redis/BullMQ group ให้แก้ F2 พร้อมกัน

**G9 🟡 คอนเวนชัน key `ban:line:user:*` ใช้กับทุก channel** ✅ — ไม่ผิด (userId มี prefix `app:`/…) แต่ชื่อทำให้เข้าใจผิดและ `user-limit-reset.service.ts` อ้าง pattern เดียวกัน; จะกระทบเมื่อแยกหลายธุรกิจ (§9)

**G10 🟡 ตัวตนสำหรับข้อมูลเฉพาะลูกค้า** 🔎 — ตอนนี้ pipeline ตอบ FAQ/สินค้า ยังไม่มี "สถานะออเดอร์ของฉัน" ที่ผูกกับตัวตน; เมื่อเพิ่มต้องบังคับ identity guard (ผูก `lineMemberId` ↔ order) และห้ามให้ LLM เห็น/อ้างข้อมูลลูกค้าอื่น (token render จาก DB ตามสิทธิ์ ไม่ผ่าน prose)

### 5.5 C — ช่องทาง / การส่ง

| ID | ระดับ | เรื่อง | หลักฐาน | แก้ |
|---|---|---|---|---|
| C1 | 🟠 | ตอบเป็นข้อความล้วน — ไม่พบ Flex/Quick Reply/Carousel ใน `src` (grep) | ✅ (grep ว่าง) | การ์ดสินค้า (Flex), ปุ่ม quick-reply (S1), ปุ่มเมนูที่เกี่ยวข้อง |
| C2 | 🟡 | event `follow` ถูก parse แล้ว ([line-webhook.adapter.ts:96,162](../src/modules/channels/line/webhook/line-webhook.adapter.ts#L96)) แต่ไม่พบ handler เฉพาะใน `worker/`/`conversation/` — ยังไม่ได้ยืนยันว่าข้อความต้อนรับถูกส่งอย่างไร | 🔎 | ตรวจแล้วทำ welcome message ต่อ company (ข้อความ/รูป/เมนู) |
| C3 | 🟠 | Facebook/App รับเฉพาะข้อความตัวอักษร (`ChannelInboundService`) แนบไฟล์/รูป/ติดตามไม่ครบ | ✅ (จากการอ่านรอบก่อน) | ใช้นโยบาย U7 เดียวกัน |
| C4 | 🟡 | REPLY token ใช้ได้ ~50s หลังเวลาข้อความ ถ้า turn ช้า (เช่น product flow) จะตกเป็น PUSH ซึ่งมีต้นทุนต่อข้อความ | ✅ CLAUDE.md §7 | latency budget ต่อ turn (§7) และ metric สัดส่วน PUSH |
| C5 | 🟡 | App: double-send ระหว่าง turn ได้ 409 BUSY ให้ client retry เอง | ✅ | ให้ client ใช้ `clientMessageId` เดิม (ปลอดภัยอยู่แล้ว) + บอกใน SDK |

### 5.6 P — ประสิทธิภาพ / ต้นทุน

| ID | ระดับ | เรื่อง | หลักฐาน | แก้ |
|---|---|---|---|---|
| P1 | 🟠 | `aiSetting` อ่าน DB **ทุกคอล** (answer ×5 จุด [answer.service.ts:87,117,145,167,175](../src/modules/chatbot/answer/answer.service.ts#L87) + classifier [:58,:133](../src/modules/chatbot/intent/ai-intent-classifier.service.ts#L133)) — turn ที่ผ่าน classifier อ่านแถวเดียวกัน ≥2 ครั้ง | ✅ | cache ใน process + invalidate ผ่าน pub/sub เหมือน `knowledge:changed` (ข้อมูลแทบไม่เปลี่ยน) |
| P2 | 🟠 | grounded ใช้ `reasoningEffort: 'medium'` ทุกครั้ง ([:378](../src/modules/chatbot/answer/answer.service.ts#L378)) | ✅ | adaptive: exact/แรง+คำถามเดียว → low; หลายคำถาม/conflict/ธุรกิจเสี่ยง → medium; วัดจาก `latencyMs` ใน trace |
| P3 | 🟠 | LOW path = 2 คอลเรียงกัน (classifier → grounded) | ✅ | understand-once (§4.3) |
| P4 | 🟠 | ไม่มี answer cache — คำถามซ้ำ ๆ ของร้าน (ค่าส่ง/เวลาเปิด) ที่เป็น REWRITE/RAG เรียก LLM ทุกครั้ง | 🔎 | cache คำตอบเมื่อ: route RAG, ไม่มี history ผูก, key = (company, normalized query, KB version, setting version), TTL สั้น; ล้างเมื่อ `cache.changed()` |
| P5 | 🟠 | budget นับ "ต่อคอล" ไม่ใช่ต่อข้อความ (F10): product เปิดแล้วโดน cap ~15–20 ข้อความ/ชม. | ✅ CLAUDE.md | นับต่อ turn (ตั้ง cost-weight), ตั้งเพดานต่อ company/แพ็กเกจ |
| P6 | 🟡 | embedding เรียก 1 ครั้งต่อ turn + memoize ต่อ turn | ✅ ดีแล้ว | คง; cache embedding ของคำถามซ้ำ (hash normalized) ได้อีกขั้น |

### 5.7 O — Observability / วงจรเรียนรู้

| ID | ระดับ | เรื่อง | แก้ |
|---|---|---|---|
| O1 | 🟡 | ไม่เก็บ `costThb` ต่อ turn (CLAUDE.md §10) — แต่ `aiUsageEvents` ผูก `turnId` ผ่าน idempotencyKey จึงคำนวณย้อนได้ | สร้าง view/คอลัมน์ `costThb`, ต้นทุนต่อบทสนทนา/ต่อ "เคสที่แก้จบโดยบอท" |
| O2 | 🟠 | ไม่มีสัญญาณคุณภาพหลังตอบ | สัญญาณ implicit (0 LLM): ถามซ้ำเรื่องเดิมภายใน 2 นาที, ตอบว่า "ไม่ใช่/ไม่ตรง", ขอแอดมินหลังบอทเพิ่งตอบ → `answerRejected=true`; เพิ่มปุ่ม 👍/👎 ใน quick-reply |
| O3 | 🟠 | ไม่มีวงจร "คำถามที่ตอบไม่ได้ → เพิ่มลง KB" | จัดกลุ่ม `fallbackReason ∈ {NO_USABLE_EVIDENCE, BELOW_MIN_VECTOR_SIMILARITY, NO_SEARCH_RESULTS}` ด้วย embedding clustering รายสัปดาห์ → ร่าง FAQ (LLM offline) ให้แอดมินอนุมัติ |
| O4 | 🟡 | ไม่มี dashboard ของ "ตัวชี้วัดความฉลาด" | containment rate, fallback rate แยกเหตุผล, TRUNCATED rate, claim-verifier reject rate, p50/p95 latency ต่อ route, LLM calls/turn, สัดส่วน PUSH |

---

## 6. Guard ที่ควรเพิ่ม (สรุป)

| # | Guard | ป้องกันอะไร | ที่ใส่ | LLM |
|---|---|---|---|---|
| 1 | **Claim verifier** (§4.6) | ตอบตัวเลข/เวลา/ราคา/เบอร์มั่ว | หลัง `generateFromKnowledge` | 0 |
| 2 | **Turn LLM cap = 3** | cost บวมเมื่อเพิ่ม stage | `UsersAiProviderService.generate` + trace | 0 |
| 3 | **Fail-closed degrade** ของ AI budget | โจมตีตอน Redis สะดุด | `AiBudgetService`, `RateLimitService` option | 0 |
| 4 | **Spotlighting + provenance ของ evidence** | indirect prompt injection จาก KB นำเข้า | `composeAiAnswerPrompt` | 0 |
| 5 | **PII redaction v2 + retention** | เลขบัตร/เลขไทย/บัญชี/ที่อยู่ รั่ว context/log/DB | `redactPii`, job ลบ `rawEvent` | 0 |
| 6 | **General-answer boundary** | โมเดลแต่งข้อมูลร้านในโหมด GENERAL | `answerGeneral` prompt + gate confidence | 0 |
| 7 | **Loop/repeat guard** | ถามซ้ำ/วนเงียบ/ส่งซ้ำ | session + `ALREADY_WAITING` | 0 |
| 8 | **Strict mode ธุรกิจเสี่ยง** | คำแนะนำสุขภาพ/กฎหมาย/การเงิน | `AiSetting` flag | 0 |
| 9 | **Identity guard** (ก่อนทำข้อมูลเฉพาะลูกค้า) | อ่านข้อมูลลูกค้าอื่น | ก่อนมี order-status | 0 |
| 10 | **Fail-open alert** | ไม่รู้ว่าระบบ fail-open อยู่ | metrics จาก 4 จุดใน G1 | 0 |

---

## 7. Pipeline stage ที่ควรเพิ่ม

```
ข้อความเข้า (LINE/FB/App)
 ├ S0  ชนิดข้อความไม่รองรับ → ack template + handoff (U7)                       [0 LLM]
 ├ S2  debounce/merge 1.2–2.5s ต่อ user (Redis+BullMQ, ข้าม instance) (U3, G8)    [0]
 ├ S3  Thai normalize (เลขไทย, อักษรซ้ำ, สะกดคู่, particle) (U2)                  [0]
 ├ gates เดิม: mute → ban/rate → menu → rules
 ├ S4  slot memory + needsContext (U1, U6)                                       [0]
 ├ S5  answer cache (P4) ── hit → ตอบเลย                                          [0]
 ├ retrieval เดิม (exact → BM25+vector → RRF → conflicts)  ← ดัชนีที่ผ่าน S6 (K6)
 ├ decide → DIRECT (0) | RAG (1) | LOW/needsContext → UNDERSTAND+ANSWER (1)       [≤2 รวม re-search]
 ├ S7  claim verifier (A1) → ผ่าน | render จาก evidence | fallback(UNVERIFIED_CLAIM) [0]
 ├ S1  quick-reply "คุณหมายถึง…" จาก candidate ที่ต่ำกว่าเกณฑ์ แทน handoff ทันที (S1) [0]
 └ S9  ส่ง: ข้อความ + (Flex สำหรับสินค้า) + ปุ่ม 👍/👎 (O2)
(offline) S6 enrichment ตอนบันทึก KB · O3 gap clustering · sample LLM-judge รายคืน
```

**S1 (รายละเอียด quick-reply):** วันนี้ LOW_CONFIDENCE + classifier=BUSINESS แต่ไม่มี evidence → `CONTACT_ADMIN` ทันที แต่ retrieval มีแคนดิเดตอันดับ 1–3 ที่ใกล้เกณฑ์อยู่แล้ว → เสนอ 2–3 ปุ่มจากชื่อ FAQ ให้ลูกค้าเลือก (0 LLM) ถ้าเลือก = คำถามชัดขึ้นพร้อมป้าย label สำหรับ calibrate (K3/O2); ไม่เลือก/พิมพ์ใหม่ → handoff ตามเดิม ลด handoff โดยไม่เสี่ยงตอบมั่ว

**งบเวลา (ต้องวัด ไม่ใช่ค่าที่วัดแล้ว):** ตั้ง p95 เป้า ≤ ~8–10 วินาทีต่อ turn ที่ใช้ LLM และ ≤ ~1.5 วินาทีที่ไม่ใช้ (ตัวเลขเป็นข้อเสนอ) เพื่อให้เหลือเวลาใน REPLY-token window 50 วินาทีเสมอ (C4) — เก็บ latency รายขั้นใน decision log (มี `latencyMs` ต่อคอลอยู่แล้ว)

---

## 8. Feature เพื่อสู้ Zaapi

ข้อมูล Zaapi มาจากเว็บไซต์ของ Zaapi เองและหน้ารีวิว G2 → ถือเป็นคำกล่าวอ้างของผู้ให้บริการ ไม่ได้ทดสอบใช้งานจริง 📚

| ความสามารถ | Zaapi (ตามที่เผยแพร่) | repo นี้ตอนนี้ | ข้อเสนอ |
|---|---|---|---|
| ตอบจากฐานความรู้ที่แอดมินอัปโหลด | มี ("AI Training Center") | มี และ grounded + มี evidence id | เพิ่ม KB gap loop (O3) และ preview ว่า "บอทจะตอบอะไร" ตอนแก้ KB |
| ราคา/สต็อก/สินค้า | แนะนำสินค้า (ไม่ระบุกลไกกันมั่ว) | **ราคา/สต็อกจาก DB ผ่าน token** | **จุดขายหลัก**: "ไม่เคยตอบราคาผิด" + การ์ด Flex + เปรียบเทียบสินค้า |
| AI เข้ามาตอบเมื่อไม่มีคนตอบ N นาที (1–120) | มี | ไม่มี (บอทตอบก่อนเสมอ / หรือถูก mute) | โหมด `delayed-takeover` ต่อ company (G6) |
| ตอบนอกเวลาทำการ + ข้อความต้อนรับ/ปิดแชท (รูป/วิดีโอได้) | มี | ไม่มีการตั้งเวลาทำการ (grep ยืนยัน); welcome ยังไม่ยืนยัน (C2) | business-hours + welcome/closing (รูป/Flex) |
| คิว "AI Failed Reply" / "Assign to AI" | มี | มี `waiting_admin` + decision log | สรุปเคสให้แอดมินด้วย 1 คอล LLM ตอน handoff (async) + เหตุผลที่บอทตอบไม่ได้ (fallbackReason) |
| Unified inbox: LINE/FB/IG/WhatsApp/Shopee/Lazada/TikTok | มี | LINE, Facebook, App | IG/WhatsApp ผ่าน `ChannelConnector` ที่มีอยู่; marketplace **ต้องตรวจสิทธิ์/ข้อจำกัด chat API ของแต่ละแพลตฟอร์มก่อน** — วางหลังสุด |
| Flow Builder แบบ no-code | มี | ไม่มี (rule + AI) | ไม่ต้องแข่งตรง ๆ: ทำ "สคริปต์สั้น" ผ่าน rule/preset ต่อธุรกิจ (จองคิว/สอบถามรอบ) |
| Lead qualification / follow-up / นัดหมาย | มี (จาก G2) | ไม่มี | slot-filling (ชื่อ/เบอร์/จำนวน/วัน) เก็บเข้า CRM เบา ๆ; นัดหมายผ่านตารางรอบ (preset แบบ บขส./คลินิก ใน `audit-product.md`) |
| ข้อความเสียง/ตำแหน่ง/รูป | — | **เงียบ/handoff เงียบ** (U7) | STT + vision + location→สาขา/พื้นที่ส่ง |
| หลายภาษา | — | ไทยเท่านั้น (U4) | auto-language |
| ความโปร่งใสต้นทุน | — | credit ledger/quote/usage event ครบ | แสดง "ต้นทุนต่อบทสนทนา/ต่อเคสที่จบด้วยบอท" ให้ร้านเห็น |
| ประเมินคุณภาพ | — | decision log | dashboard §5.7-O4 + A/B ของ prompt ต่อธุรกิจ |

**ลำดับที่ผมแนะนำ:** ปิดช่องโหว่ + ความเงียบ (§0 #1–#6) → ความเข้าใจภาษา (U1–U3, K6) → Flex/quick-reply/👍👎 → business-hours/takeover/welcome → เสียง/ตำแหน่ง/รูป → IG/WhatsApp → marketplace

---

## 9. ความพร้อมหลายธุรกิจ (สั้น — รายละเอียดจะไปอยู่ `saas-fable.md` เมื่อสั่ง)

สิ่งที่ปิดการ deploy "หลายร้านใน instance เดียว" ตอนนี้ (ยืนยันจาก grep รอบนี้):
- `CompanyService.getCompanyId()` เป็น singleton (ผิดถ้ามี >1 บริษัท) ถูกเรียก **18 จุดใน 10 ไฟล์** (credit ×6, admin ×5, decision-log ×4, app-session, facebook-credential, embedding-health)
- ขอบเขต KB/AiSetting มาจาก **env** (`KNOWLEDGE_TENANT_ID`, `AI_SETTING_TENANT_ID`) ผ่าน `knowledgeScope()` ([knowledge-scope.ts:13](../src/shared/knowledge/knowledge-scope.ts#L13)) — ไม่ใช่ต่อ request
- `AiProviderSetting.scope` เป็น `@unique` ระดับ global (USER/ADMIN) → โมเดลเดียวทั้งระบบ
- ตาราง LINE (`LineMember.lineUserId @unique`, conversation, history, delivery) ไม่มี `companyId`
- `rl:ai:global` 30/วินาที ใช้ร่วมกันทุกคน; cache KB ทั้ง instance เป็นของ scope เดียว; K1 (cap 500) และ K3 (threshold ตายตัว) จะ "ข้ามธุรกิจ" เป็นปัญหา
- ผลดี: App channel/Facebook/decisionLogs/product/wallet มี `companyId` อยู่แล้ว → แนวทางเดิมต่อยอดได้

ข้อเสนอเชิงหลักการ (ก่อนเขียนแผน): resolve `companyId` ที่ **ทางเข้า channel** แล้วส่งใน context ทุกชั้น (ไม่อ่านจาก env/singleton), เก็บ cache/Redis key/budget ต่อ company, และให้ preset ธุรกิจ (`BUSINESS_PRESETS`) เป็นตัวกำหนด meta/prompt/threshold/โหมดเสี่ยง

---

## 10. แผน Eval และ Test (ต้องมีก่อนเปลี่ยน threshold/prompt ตามกฎ repo)

1. **Golden set จริง**: ดึงคำถามจาก `decisionLogs` (ปกปิด PII) ~300–500 เคส/ธุรกิจ ติดป้าย gold evidence + ผลที่ควรเป็น (ANSWER / CLARIFY / HANDOFF / GENERAL) และเก็บเคสที่ "เคยตอบผิด" ทั้งหมดเป็น regression
2. **ชุดเคสภาษาไทยที่ต้องมี** (เพิ่มใน `retrieval-eval.cases.ts` / `test/live/`):
   - สะกดคู่: `ค่าส่งเท่าไหร่` / `ค่าส่งเท่าไร` / `ส่งกี่บาท`
   - เลขไทย: `ราคา ๕๐๐ บาท`; หน่วย `1.5k`, `พันนึง`
   - คำลงท้าย/คำพูด: `ส่งต่างจังหวัดไหมอ่ะ`, `ได้ป่ะ`, `ได้ววว`
   - follow-up: `แล้วต่างจังหวัดล่ะ`, `อันนี้มีสีอื่นไหม`, `ส่วนอีกรุ่นล่ะ`
   - หลายเจตนา: `เปิดกี่โมง แล้วจอดรถได้ไหม`
   - ข้อความติดกัน 3 บรรทัด (debounce)
   - ต่างภาษา: `Do you deliver to Phuket?`
   - injection ใน KB: แถวที่มี "ละเว้นคำสั่งก่อนหน้า…"
   - verifier: KB `09:00–18:00` เทียบคำตอบ "9 โมงถึง 5 โมงเย็น" ต้องไม่ผ่าน
   - PII: บัตร 16 หลัก, เลขไทย, บัญชีโดด ๆ, ที่อยู่
3. **เมตริก**: Recall@3/@10, Top-1/Top-3 accuracy (แยกเพื่อตัดสินเรื่อง reranker), MRR, fallback rate แยกเหตุผล, wrong-answer rate (ตรวจมือ+offline judge สุ่ม), claim-reject rate, LLM calls/turn (ต้อง ≤3), p50/p95 latency แยกตาม route, ต้นทุน/turn
4. **Embedding จริงใน live eval** (K4) แล้ว re-calibrate threshold/margin (K3) ทุกครั้งที่เปลี่ยนโมเดล embedding
5. **Shadow mode** สำหรับ understand-once (§4.3): รัน prompt ใหม่บน LOW_CONFIDENCE ที่ log ไว้ เทียบผลก่อนเปิดจริง
6. **Chaos**: ปิด Redis ระหว่างทดสอบ → ยืนยันว่า G1 degrade ถูกต้อง (ไม่เรียก LLM ไม่ crash); รัน 2 instance ยืนยันลำดับข้อความ (F2/U3)
7. **ผลกระทบข้างเคียงที่ต้อง re-run**: `chatbot/audit/*`, `knowledge/test/*`, `ai-setting-prompt.composer.spec.ts`

---

## 11. Roadmap

| เฟส | เนื้อหา | ID | ผลที่ได้ |
|---|---|---|---|
| **0** (≈ 1–2 วัน) | ลบ log, cache `aiSetting`, เรียงลำดับ budget, ack ข้อความที่ไม่รองรับ, เพดาน 3 คอล, ตัดสินใจ K2 (เปลี่ยนเป็นสถานะบนแถว), alert/metric K1+G1 | G4, P1, G2, U7, G5, K2 | ลดความเงียบ/ต้นทุน/เสี่ยงโดยไม่แตะคุณภาพ |
| **1** (guard) | claim verifier, PII v2 + retention, fail-closed budget, spotlighting, retry A2, general boundary | A1, G3, G1, A4, A2, A3 | ปิดความผิดพลาดที่ลูกค้าเห็นและความเสี่ยงข้อมูล |
| **2** (เข้าใจภาษา) | normalizer, debounce (พร้อมแก้ F2), needsContext + slot memory, auto-language, quick-reply | U2, U3, G8, U1, U6, U4, S1 | ฉลาดขึ้นแบบ 0 คอล |
| **3** (คุณภาพ/สเกล) | golden set + live eval, calibration ต่อธุรกิจ, index-time enrichment, answer cache, adaptive reasoning, understand-once (shadow→จริง), DB-side lexical | K4, K3, K6, P4, P2, P3, K1 | ตอบถูกขึ้น เร็วขึ้น เป็นของพกพาข้ามธุรกิจ |
| **4** (feature แข่ง) | Flex/ปุ่ม, business-hours/takeover/welcome, เสียง/ตำแหน่ง/รูป, สรุปเคสให้แอดมิน, dashboard + KB gap loop, IG/WhatsApp | C1, C2, G6, O1–O4, §8 | ตามทัน/แซง Zaapi ในจุดที่ลูกค้าไทยใช้จริง |
| **5** | `saas-fable.md` (ยังไม่ทำ) + marketplace connectors | §9 | multi-company เต็มรูป |

ข้อควรจำตอนแก้ (จาก CLAUDE.md §13): ทุกคอลผ่าน billing wrapper และ rethrow `InsufficientCreditException`/`PendingAiUsageError`; ห้ามเรียกเครือข่าย/LLM ในทรานแซกชัน DB; ใช้ `turnId` เป็น idempotency key; เพิ่ม action/answer branch ต้องรายงาน `decisionTrace.answer({mode, fallbackReason})` และกำหนด `contextPolicy`; เขียน KB ต้องเรียก `cache.changed()`; เปลี่ยน schema ต้องตาม `.claude/rules/prisma.md` (migration + backfill, ห้าม `db push`)

---

## 12. ข้อจำกัดของ audit นี้ (พูดตรง ๆ)

- ไม่ได้รันทั้งชุด test, load test, หรือคอลโมเดล/embedding จริง — ข้อสรุปเรื่อง latency, อัตรา TRUNCATED, คุณภาพ retrieval จึงเป็นสมมติฐานที่ต้องวัด (§10)
- ไฟล์ที่ **ยังไม่ได้อ่านละเอียด**: `line-webhook.service.ts`, รายละเอียด `facebook.connector.ts`, ภายใน `credit.service.ts`/`ai-billing.service.ts`, outbox ของ index KB, `infra/storage`, ค่า `AI_GENERATION_CONFIG.maxOutputTokens` — C2 และ A2 ยังต้องยืนยัน
- ข้อ 🔎 ทุกข้อต้องมี test ยืนยันก่อนลงมือแก้ (โดยเฉพาะ U3, U5, G6, P4)
- ข้อมูลฝั่ง Zaapi เป็นคำกล่าวอ้างของผู้ให้บริการ ไม่ได้ทดลองใช้
- ค้นไม่พบ benchmark เผยแพร่ของ reranker ภาษาไทย และไม่พบตัวเลข latency จริงของ cross-encoder บนภาษาไทย — เกณฑ์ตัดสินใจใน §4.1 จึงใช้ eval ของ repo เอง
- ตัวเลขเกณฑ์ (0.6, 85%, 95%, 1.2–2.5s, p95 ≤ 8–10s) เป็น **ข้อเสนอเริ่มต้น** ที่ต้องปรับจากข้อมูล ไม่ใช่ค่าที่วัดมา

---

## 13. แหล่งอ้างอิง

- Anthropic — Contextual Retrieval (ตัวเลขลดความล้มเหลว 35% / 49% / 67% เมื่อเพิ่ม contextual embeddings, BM25 และ reranking): [anthropic.com/news/contextual-retrieval](https://anthropic.com/news/contextual-retrieval) · [anthropic.com/research/contextual-retrieval](https://anthropic.com/research/contextual-retrieval)
- ข้อมูล reranker ข้ามภาษา (cross-encoder ต้องมี query ก่อนคำนวณ, `bge-reranker-v2-m3` ฐาน XLM-R): [theneuralbase.com — bge-reranker-v2-m3](https://theneuralbase.com/reranking/learn/intermediate/baai-bge-reranker-v2-m3/) · [mGTE (arXiv 2407.19669)](https://arxiv.org/html/2407.19669v2) — *ไม่พบ benchmark ภาษาไทยโดยเฉพาะ*
- Indirect prompt injection / spotlighting (delimiting, datamarking, encoding; ใช้ delimiter สุ่ม + provenance): [tianpan.co — prompt injection defense](https://tianpan.co/blog/2025-10-18-prompt-injection-defense) · [tianpan.co — RAG corpus trust boundary](https://tianpan.co/blog/2026-06-03-your-rag-corpus-trust-boundary-is-whoever-can-write-to-its-sources) · [รีวิวเปเปอร์ Spotlighting](https://themoonlight.io/en/review/defending-against-indirect-prompt-injection-attacks-with-spotlighting) — *เป็นแหล่งรอง ควรตรวจกับ OWASP LLM01 และเปเปอร์ต้นฉบับ*
- Zaapi (คำกล่าวอ้างของผู้ให้บริการ): [zaapi.com/feature/chatbot-ai](https://zaapi.com/feature/chatbot-ai) · [zaapi.com/blog/chat-with-ai](https://www.zaapi.com/blog/chat-with-ai) · [G2 — Zaapi reviews](https://www.g2.com/products/zaapi/reviews?page=4)
- เอกสารภายใน: `docs/audit-fable5.2.md`, `docs/audit-product.md`, `CLAUDE.md` §1–§16
