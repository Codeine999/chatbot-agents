# Core chat logic audit — input → output (2026-09-23)

ขอบเขต: เฉพาะ core chat logic ตั้งแต่ LINE webhook รับ event จนถึงข้อความตอบกลับ
— session, mute, rule intent, rich menu, classifier, knowledge (AnswerPattern),
micro knowledge, embedding, RRF fusion, grounded generation, fallback,
contact admin, spam/rate limit, inbound persistence
ไม่รวม registration, rich menu admin, topup, usage/billing, payments, users
(17 billing tests ที่ล้มอยู่เป็นของเดิม ไม่ได้แตะในรอบนี้)

วิธีตรวจ: source review + **38 characterization tests ใหม่** ที่รัน core service
จริงทั้งชุด (AnswerPatternService, MicroKnowledgeService, SemanticSearchService,
KnowledgeRetrievalService, RuleIntentService, AiIntentClassifierService,
IntentRouterService, AiChatService, ChatbotService, UserSessionService,
LineWebhookService) โดย mock เฉพาะขอบนอก: Prisma, Redis, embedding adapter,
generation provider, LINE Messaging API
ไม่มีการเรียก LINE หรือ provider จริง ไม่มีการแก้ไข/ลบไฟล์เดิม

ไฟล์ที่เพิ่ม (ใหม่ทั้งหมด):

- `src/modules/chatbot/audit/core-chat.harness.ts`
- `src/modules/chatbot/audit/core-chat-e2e.audit.spec.ts` — 25 tests
- `src/modules/chatbot/audit/retrieval-fusion.audit.spec.ts` — 11 tests
- `src/modules/chatbot/audit/line-ingress.audit.spec.ts` — 2 tests

test ที่ขึ้นต้นว่า `observes …` คือ test ที่ **ยืนยันพฤติกรรมที่เป็นปัญหา**
ให้ทำซ้ำได้ ไม่ใช่การรับรองว่าพฤติกรรมนั้นถูก


## 1. ตอบคำถามหลัก: flow ตอนนี้คืออะไร

### Micro knowledge เช็ค keyword ด้วยไหม

**เช็ค** และใช้ scorer **ตัวเดียวกัน** กับ AnswerPattern
`MicroKnowledgeService.findMatches()` โหลด `microKnowledge` (active + tenant +
language, `take: 500`, order by priority/updatedAt) แล้วส่งเข้า
`AnswerPatternService.findMatchesFromPatterns(query, rows, 'DATABASE', 'MICRO_KNOWLEDGE')`
ดังนั้นน้ำหนัก keyword/questionExamples/intentKey/title/category/description
เหมือนกับ AnswerPattern ทุกตัว ต่างกันแค่ `safeDirect` ที่ hard-code ให้เป็น
`source === 'ANSWER_PATTERN'` เท่านั้น → micro knowledge **ตอบ DIRECT เองไม่ได้ตลอดกาล**

### ส่งเข้า LLM ทั้งคู่ตั้งแต่ step keyword เลยไหม

**ไม่** step keyword ไม่ส่งอะไรเข้า LLM เลย และไม่แตะ micro knowledge เลย

flow จริงใน `KnowledgeRetrievalService.runRetrieval()` มี 3 ด่าน:

| ด่าน | อ่านอะไร | micro knowledge | embedding | LLM |
|---|---|---|---|---|
| 1. cache DIRECT | `AnswerPatternCacheService.getAll()` (snapshot 500 แถว, TTL 240s) | ไม่ | ไม่ | **ไม่เรียก** — ส่ง `answer` verbatim |
| 2. DB DIRECT | `answerPattern.findMany(take 500)` | ไม่ | ไม่ | **ไม่เรียก** — verbatim |
| 3. fusion | DB patterns + micro (lexical) + pattern vectors + micro vectors | ใช่ | ใช่ | **เรียก 1 ครั้ง** |

เงื่อนไขผ่านด่าน 1/2 คือ `safeDirect === true` ซึ่งต้องครบ 4 อย่าง:
`questionExamples` มีตัวหนึ่ง normalize แล้ว **เท่ากับทั้งข้อความ**, ไม่ใช่
broad query (`ราคา/สินค้า/บริการ/price/...`), snapshot ที่สแกน < 500 แถว,
ไม่มี exact ตัวอื่นที่ answer ต่างกัน และ `renderMode !== 'REWRITE'`
ถ้า query ถูก rewrite จาก follow-up (`directAllowed = query === message.trim()`)
ด่าน DIRECT จะถูกปิดด้วย

### AnswerPattern + MicroKnowledge รวมกันยังไงก่อนเข้า LLM

ด่าน 3 ทำ 3 ขั้น:

1. **noise floor** — lexical (`[...database, ...micro]`) ต้อง `rawScore >= 3`
   (`KNOWLEDGE_LEXICAL_CANDIDATE_MIN_SCORE`), vector ต้อง `cosine >= 0.6`
   (`KNOWLEDGE_VECTOR_CANDIDATE_MIN_SIMILARITY`)
   ตัว matcher เองตัดที่ `MIN_MATCH_SCORE = 2` อยู่แล้ว
2. **RRF** — จัด 2 list: lexical เรียงตาม `rawScore`, vector เรียงตาม
   `vectorSimilarity` แล้วรวมด้วย `score += 1 / (60 + index + 1)`
   ผลลัพธ์ **ไม่ได้ใช้ค่าคะแนนดิบ ใช้แค่อันดับ** tie-break ด้วย `priority`
   แล้วจึง `source:id` (string compare)
3. **selectContexts** — ไล่จากอันดับบนสุด เก็บได้สูงสุด `MAX_RAG_CONTEXTS = 3`
   รายการ และรวมความยาวไม่เกิน `MAX_RAG_EVIDENCE_CHARACTERS = 12,000`

ที่ได้มา (ผสม AnswerPattern กับ MicroKnowledge ปนกันได้เต็มที่) จะถูกส่งเข้า
`AiChatService.generateFromKnowledge()` → `composeAiAnswerPrompt()` ในบล็อก
`<ragContext>` เป็น JSON ของ `{source, id, title, category, entityKey, topicKey,
content, answer}` พร้อม modeRules ที่บอกโมเดลว่า
"AnswerPattern เป็นคำตอบที่ผ่านการดูแล MicroKnowledge เป็นข้อเท็จจริงที่นำมาประกอบกันได้"
temperature 0 และถ้าหลักฐานไม่พอให้ตอบ `INSUFFICIENT_CONTEXT` อย่างเดียว

ข้อสรุปสำคัญ: **ไม่มี lexical-only RAG path**
ทุก query ที่ไม่ผ่าน DIRECT จะจ่ายค่า embedding เสมอ แม้ keyword จะ match
micro knowledge แบบชัดเจนแล้วก็ตาม (`micro.findMatches` ถูกเรียกใน
`Promise.all` คู่กับ `semantic.search` เสมอ)


## 2. Findings

ระดับ: P0 = ต้องหยุดใช้ทันที, P1 = correctness/ความเสียหายต่อลูกค้า,
P2 = ความน่าเชื่อถือ/ต้นทุนที่ควรแก้ก่อนขยาย, P3 = คุณภาพ/observability,
P4 = เอกสาร/dead code, P5 = งานเพิ่มที่ยังไม่มี defect ยืนยัน

**P0: ไม่พบในรอบนี้**

| ID | ระดับ | ปัญหา | หลักฐาน |
|---|---|---|---|
| C01 | P1 | **ไม่มี relevance gate บนคะแนนที่ fuse แล้ว** `route = selected.length ? 'RAG' : 'LOW_CONFIDENCE'` เท่านั้น แปลว่าพอ index มี vector อยู่ และเพื่อนบ้านตัวใดตัวหนึ่งผ่าน 0.6 turn นั้นกลายเป็น RAG ทันที ทั้งที่ไม่เกี่ยวกับคำถามเลย ผลคือ (ก) BUSINESS/GENERAL classifier แทบไม่มีโอกาสทำงาน (ข) เสีย generation call ทุกครั้ง (ค) โมเดลตอบ `INSUFFICIENT_CONTEXT` → `chatbot.service.ts` ส่งเข้า `contactAdminResponse(userId, true)` → conversation กลายเป็น `waiting_admin` แค่เพราะลูกค้าทักเรื่องดินฟ้าอากาศ | `observes weak vector neighbours turning small talk into a grounded RAG call and an admin handoff` |
| C02 | P1 | **Sentinel รั่วถึงลูกค้า** `isInsufficientContext()` เทียบแบบ `===` หลังตัดเฉพาะ code fence กับ quote ถ้าโมเดลเติม `.` หรือคำอื่นแม้แต่ตัวเดียว ลูกค้าจะได้ข้อความ `INSUFFICIENT_CONTEXT.` เป็นคำตอบ และถูกเก็บลง context ต่อ (`contextPolicy: 'INCLUDE'`) | `observes the sentinel leaking to the customer when the model adds any punctuation` |
| C03 | P1 | **`conflicts()` ตรวจทั้ง merged pool ไม่ใช่เฉพาะหลักฐานที่เลือก** candidate อันดับท้าย ๆ สองตัวที่ title เดียวกันและต่างกันแค่ตัวเลข ทำให้ทั้ง turn กลายเป็น `CONFLICTING_CANDIDATES` → CONTACT_ADMIN ทั้งที่ candidate อันดับ 1 ถูกต้องและไม่ขัดกับใคร | `observes a conflict between two low-ranked candidates escalating the whole turn to an admin` |
| C04 | P2 | **fallback สัญญาว่าจะส่งต่อแอดมิน แต่ไม่ได้ส่ง** provider error / ตอบว่าง / budget หมด ใน `answerKnowledge` คืน `isFallback` ธรรมดา → `aiResponse(..., 'KNOWLEDGE')` ข้อความคือ `fallbackMessage` ที่เขียนว่า "เดี๋ยวส่งต่อให้แอดมิน" แต่ `requestAdmin` ไม่เคยถูกเรียก ไม่มีใครมารับ (A07 เดิม ยังเปิดอยู่) | `observes a provider failure promising an admin in the reply text without requesting one` |
| C05 | P2 | **postback ที่ถูก process ซ้ำ เขียน LineChatHistory และ unreadCount สองครั้ง** ดักซ้ำของ `saveIncomingEvent` ใช้ `lineMessageId` เป็นคีย์ แต่ postback ของ rich menu ไม่มี `lineMessageId` เลย ถ้า crash/lease หมดอายุหลัง saveIncomingEvent commit แต่ก่อน `lineDelivery.upsert` recovery จะเขียนซ้ำ ขัดกับ AGENTS ("Persist incoming messages and unread increments only once") | `observes a reprocessed rich menu postback duplicating history and unread count` |
| C06 | P2 | **budget หมด = ส่งต่อแอดมิน** `EmbeddingService.embed()` โยน `ServiceUnavailableException` เมื่อ `tryConsume` ไม่ผ่าน → `read('semantic')` จับได้ ตั้ง `failed = true` → `RETRIEVAL_ERROR` → CONTACT_ADMIN + `businessFallback` ลูกค้าที่ถามถี่จึงถูกโยนเข้าคิวคน แทนที่จะ degrade เป็น lexical-only | `observes the retrieval embedding budget gate escalating an ordinary question to an admin` |
| C07 | P2 | **RRF ลบขนาดของคะแนนทิ้ง** candidate ที่อยู่ทั้งสอง list ได้ ~`2/61` ชนะ candidate ที่อยู่ list เดียวเสมอ (`1/61`) ไม่ว่าคะแนนดิบจะห่างแค่ไหน ในเทสต์ แถวที่ cosine 0.61 (แทบเป็น noise) แต่ติด keyword ด้วย ชนะแถวที่ keyword match แข็งกว่ามาก และขึ้นเป็นหลักฐานอันดับ 1 | `observes RRF rank fusion: a weak candidate on both lists outranks a much stronger keyword-only match` |
| C08 | P2 | **lexical scorer เป็น substring บนภาษาไทยที่ไม่ตัดคำ ไม่มี IDF ไม่ normalize ความยาว** `tokenize()` split ด้วยช่องว่าง ข้อความไทยทั้งประโยคจึงเป็น token เดียว ทางที่ทำงานจริงคือ `KEYWORD_CONTAINS` (3 คะแนน, ขั้นต่ำ 2 ตัวอักษร) query "นอนไม่หลับควรไปหาหมอนะ" ติด keyword+title "หมอน" ได้ 4 คะแนน ผ่าน floor 3 เข้าไปเป็นหลักฐานให้ LLM | `observes Thai substring keyword matching producing a false positive` |
| C09 | P2 | **DIRECT ปิดตัวเองเงียบ ๆ ที่ 500 แถว** `safeDirect` ต้อง `patterns.length < MAX_PATTERNS_SCANNED` พอ tenant มี active pattern ครบ 500 คำตอบ preset ที่ curate ไว้ทั้งหมดจะเลิกตอบ verbatim พร้อมกัน และเริ่มเสียค่า embedding + generation ทุกครั้ง โดยไม่มี log บอก | `observes the verbatim DIRECT path switching itself off once the scan cap is reached` |
| C10 | P2 | **ordering ต่อ conversation ไม่ข้าม process** `userProcessingTails` เป็น `Map` ใน worker เดียว ส่วน DB lease กันได้แค่ event เดียวกัน สอง event ของ user เดียวกันบนคนละ instance รันพร้อมกันได้ (A03 เดิม ยังเปิด) | source: `line-events.processor.ts:processQueuedJob` |
| C11 | P2 | **webhook ที่ส่งซ้ำกินโควตา rate limit ของลูกค้า** `passesAbuseChecks()` รันก่อน `claimWebhookEvent()` LINE redelivery จึงกิน burst/hourly และสะสม ban strike ได้ ทั้งที่ event นั้นจะถูก skip อยู่แล้ว | source: `line-events.processor.ts:processInOrder` |
| C12 | P3 | **evidence budget ตัดตัวอันดับ 1 ทิ้งเงียบ ๆ** `selectContexts` ใช้ `continue` ถ้า item ยาวเกินงบ 12,000 ตัวอักษร ตัวอันดับ 1 ที่ยาวเกินจะหายไปเฉย ๆ แล้วไปตอบจากอันดับรอง ๆ ไม่มี log ไม่มี truncate policy | `observes the evidence budget silently skipping the top-ranked item when it is oversized` |
| C13 | P3 | **`MAX_RAG_CONTEXTS = 3` ไม่มีโควตาแยกตาม source** micro fact ที่คะแนนสูงกว่าเบียด AnswerPattern ที่ curate ไว้หลุดออกจากหลักฐานได้ ทั้งที่งบตัวอักษรยังเหลือเยอะ | `observes only three contexts reaching the LLM, so curated patterns can be crowded out by micro facts` |
| C14 | P3 | **tie-break ตัดสินด้วยชื่อ source** `tieBreak()` เทียบ `priority` แล้วตกไปที่ `` `${source}:${id}` ``.localeCompare → คะแนนเท่ากันเมื่อไร `ANSWER_PATTERN` ชนะ `MICRO_KNOWLEDGE` เพราะเรียงตามตัวอักษร เป็น precedence ที่ไม่ได้ตั้งใจและไม่ได้เขียนไว้ที่ไหน | source: `knowledge-retrieval.service.ts:tieBreak` |
| C15 | P3 | **ลำดับ exact-match ของ matcher ถูกทิ้ง** `findMatchesFromPatterns` เรียง exact ขึ้นก่อน แต่ `rank()` เรียงใหม่ด้วย `rawScore` ล้วน exact ที่เป็น REWRITE หรือ ambiguous จึงหล่นต่ำกว่า non-exact ที่คะแนนดิบสูงกว่าได้ | source: `knowledge-retrieval.service.ts:rank` |
| C16 | P3 | **rich menu label ชนะทุก rule** `resolveRichMenu()` รันก่อน `ruleIntentService.detect()` ถ้า tenant ตั้งชื่อปุ่มว่า "ยกเลิก" คำว่ายกเลิกที่ลูกค้าพิมพ์จะไม่ออกจาก flow registration อีกต่อไป | `observes a typed message equal to a menu caption being answered as a menu tap, ahead of every rule` |
| C17 | P3 | **session REGISTER กลืนคำถามธุรกิจ** digression ทำได้เฉพาะเมื่อ rule confidence ≥ 0.9 คำถามที่ knowledge ตอบได้จะถูกส่งเข้า `registrationService.handle()` แทน สวนกับ AGENTS ("Preserve registration state across allowed informational digressions") | `observes an active registration session swallowing an unrelated business question` |
| C18 | P3 | **`Number(env)` = NaN ปิด guard เงียบ ๆ** `AI_MAX_MESSAGE_LENGTH` ที่ตั้งผิดทำให้ `input.length > NaN` เป็น false เสมอ = ไม่มีลิมิตความยาว ขณะที่ `AI_GLOBAL_LIMIT_PER_SEC` ที่เป็น NaN จะทำให้ `current <= NaN` เป็น false = บล็อก AI ทั้งระบบ ทิศทางพังตรงข้ามกัน และไม่มี validation ตอน boot | `observes a non-numeric AI_MAX_MESSAGE_LENGTH silently disabling the length guard` |
| C19 | P3 | **1 turn กิน AI budget ได้ถึง 3 หน่วย** embedding + classifier + generation ต่างเรียก `tryConsume` แยกกัน `AI_USER_LIMIT_PER_HOUR = 60` จึงเท่ากับลูกค้าพิมพ์ได้จริงประมาณ 20 ข้อความ/ชม. ชื่อ config สื่อผิด | source: `embedding.service.ts`, `ai-intent-classifier.service.ts`, `aichat.service.ts` |
| C20 | P3 | **รูปที่จัดเป็น BUSINESS_UNVERIFIED ตอบ fallback แต่ไม่ส่งต่อแอดมิน** ลูกค้าส่งสลิปแล้วได้ข้อความขอโทษ ไม่มีใครถูกเรียก (คลาสเดียวกับ C04) | `observes an image classified as business returning a fallback without an admin handoff` |
| C21 | P3 | **log สกปรกบน hot path** `intent-router.service.ts:61` มี `console.log('menuDecision', menuDecision)` พิมพ์ `replyText` ของ tenant ดิบ ๆ ไม่ผ่าน `logSafeText` และไม่ผ่าน Nest Logger ส่วน `chatbot.service.ts:57` `logger.warn(\`user session ${session}\`)` พิมพ์ `[object Object]` ระดับ WARN ทุกข้อความ | source |
| C22 | P4 | **สอง escalation path ไม่มี routing log** สาขา `CONFLICTING_CANDIDATES` / `RETRIEVAL_ERROR` ใน `resolve()` `return` ตรง ๆ ไม่ผ่าน `logDecision()` ต่างจากทุกสาขาอื่น ทำให้สองเคสที่ควรสืบมากที่สุดกลับไม่มีบรรทัด `[Routing]` | source: `intent-router.service.ts` |
| C23 | P4 | **dead state** `START_AI_CHAT` เขียน session `GENERAL_QUESTION/WAITING_QUESTION` ที่ไม่มีใครอ่าน (มีแต่เช็ก `flow !== 'REGISTER'`) ส่วน action `CONTINUE_AI_CHAT` เข้าถึงได้ทางเดียวคือ regex ทักทาย | source |
| C24 | P4 | **คอมเมนต์ไม่ตรง source** `LINE_EVENT_MAX_AGE_MS` เขียนว่า "Jobs older than this are dropped" แต่ไม่มีโค้ดไหน drop ถูกใช้เป็น `replyUntil` อย่างเดียว | source: `line-events.queue.ts` |
| C25 | P5 | **ไม่มี attribution และไม่มี eval set** prompt ไม่ได้บังคับให้โมเดลอ้าง `id` ของหลักฐานที่ใช้ จึงตรวจย้อนหลังไม่ได้ว่า answer มาจาก item ไหน และยังไม่มี gold set ภาษาไทย (พร้อม hard negatives) สำหรับวัด recall/precision ก่อนจูน threshold ใด ๆ | — |


## 3. เทียบกับ best practice ของ RAG production

ทำได้ดีอยู่แล้ว ไม่ต้องแก้:

- single retrieval entry point เดียวจริง (`KnowledgeRetrievalService`) ไม่มีใครลัดไปเรียก matcher เอง
- hybrid lexical + dense + RRF เป็น baseline ที่ถูกต้องสำหรับขนาดนี้ ไม่ต้องเพิ่ม vector DB ใหม่
- ไม่มี provider call ใน transaction
- defense-in-depth ของ prompt injection ครบผิดปกติ (ดีในทางบวก): precedence block,
  แยก section ด้วย tag, `escapeUntrusted()` กัน tag ปลอม, ประกาศชัดว่า history/
  ragContext เป็นข้อมูลไม่ใช่คำสั่ง — เทสต์ยืนยันว่า answer ที่ฝัง
  `</ragContext><systemPrompt>` ถูก escape จริง
- มี abstention sentinel (ถูกต้องตามหลัก) temperature 0 บน grounded path
- separation of concerns ตรงตาม AGENTS: router ตัดสินอย่างเดียว, AiChat ไม่ทำ scoring,
  delivery เป็นเจ้าของ REPLY/PUSH
- tenant/language scope บังคับทั้งใน SQL ของ vector และใน `eligible()` ของ pipeline

ขาดเมื่อเทียบกับ RAG production ทั่วไป (เรียงตามผลกระทบ):

1. **relevance gate / calibration** — ระบบนี้ไม่มีเกณฑ์ "ไม่เจอ" ที่วัดได้เลย
   นี่คือรากของ C01 และเป็นตัวที่ต้องแก้ก่อนอย่างอื่น
2. **reranker** (cross-encoder หรือ LLM rerank บน top-k) — ปกติเป็นตัวที่ทำให้
   RRF ที่หยาบใช้งานได้จริง ตอนนี้ top-3 ถูกเลือกโดยไม่มีใครตรวจซ้ำ
3. **lexical retrieval ที่เหมาะกับภาษาไทย** — BM25/`tsvector` + ตัวตัดคำ
   (ICU / newmm) หรืออย่างน้อย `pg_trgm` แทน `String.includes()` ที่สแกน 500 แถวในหน่วยความจำ
   จะแก้ทั้ง C08 และ C09 ไปพร้อมกัน
4. **citations / attribution** — ให้โมเดลคืน `usedIds` มาด้วย ทำให้ groundedness วัดได้
5. **eval harness** — gold set ไทย + hard negatives เป็นเงื่อนไขที่ AGENTS บังคับอยู่แล้ว
   สำหรับการแก้ scoring/threshold แต่ยังไม่มี
6. **evidence dedup** — ตอนนี้ item ที่ answer เหมือนกันจาก 2 source กิน slot ใน 3 slot ได้
7. **query understanding** — `resolveRetrievalQuery` รู้จักเฉพาะรูปแบบ `รุ่น X`
   คำถามต่อเนื่องแบบอื่นไม่ถูก rewrite แต่ก็ไม่ถูก reject (ออกแบบแบบ no-provider ซึ่งสมเหตุสมผล)


## 4. ข้อเสนอแนะ เรียงลำดับที่ควรทำ

**ทำก่อน (แก้ความเสียหายที่ลูกค้าเห็น)**

1. C02 — เปลี่ยน `isInsufficientContext` ให้จับ sentinel แบบ token
   (เช่น ถ้า normalize แล้ว `includes(INSUFFICIENT_CONTEXT)` และไม่มีเนื้อหาอื่นที่ใช้ได้)
   และเพิ่ม guard สุดท้ายก่อนส่ง: ถ้าข้อความที่จะส่งยังมี sentinel อยู่ ให้เป็น fallback เสมอ
2. C01 — เพิ่ม relevance gate ก่อนตั้ง `route = 'RAG'` โดยใช้เกณฑ์ที่วัดจาก gold set
   (ข้อเสนอเริ่มต้น: ต้องมีอย่างน้อยหนึ่งใน `max(vectorSimilarity) >= τ_vec`
   หรือ `max(rawScore) >= τ_lex` โดย τ ทั้งสองมาจาก eval ไม่ใช่เดา)
   และย้ำว่า **ห้ามเทียบ RRF score กับ threshold** — ค่ามันไม่มีความหมายเชิงสัมบูรณ์
3. C03 — เรียก `conflicts()` บนผลของ `selectContexts()` เท่านั้น
   (หรือบน candidate ที่อยู่ในช่วงคะแนนใกล้ top-1) ไม่ใช่ทั้ง pool
4. C04 + C20 — ให้ `AiAnswerResult` บอกสาเหตุ (`PROVIDER_ERROR`/`BUDGET`/`BLOCKED`)
   แล้ว ChatbotService ตัดสินใจครั้งเดียวว่าจะ `requestAdmin` หรือไม่
   ทางเลือกที่ถูกกว่าคือแก้ข้อความ fallback ให้ไม่สัญญาสิ่งที่ไม่ได้ทำ แต่แนะนำทางแรก
5. C05 — เพิ่ม unique key สำหรับ inbound ที่ไม่มี `lineMessageId`
   (เช่น คอลัมน์ `sourceEventId` unique บน `LineChatHistory` เขียนด้วย `webhookEventId`)
   ต้องมาพร้อม migration + backfill plan ตามกฎ Prisma ใน AGENTS

**ทำต่อ (ต้นทุนและความน่าเชื่อถือ)**

6. C06 — แยก error ของ budget ออกจาก error ทั่วไปใน `read()` ถ้า budget หมด
   ให้ degrade เป็น lexical-only แทนที่จะ escalate
7. C09 + C08 — ย้าย lexical ไปเป็น query ที่มี index จริง เลิกพิสูจน์ uniqueness
   ด้วย snapshot ที่ถูก cap และให้ DIRECT ตรวจความเป็นเอกลักษณ์ด้วย query ตรงจุด
8. C07 + C13 + C14 — ระบุนโยบาย fusion ให้ชัดเป็นลายลักษณ์อักษร: weighted RRF,
   โควตา source (อย่างน้อย 1 AnswerPattern ถ้ามี), และ tie-break ที่ตั้งใจ
   ขยาย `MAX_RAG_CONTEXTS` เป็น 5–8 ได้ เพราะงบตัวอักษร 12k ยังเหลือมาก
9. C10 + C11 — serialize ต่อ conversation ข้าม process (Redis lock หรือ BullMQ
   group/FIFO key) และย้าย abuse check ไปหลัง claim
10. C25 — สร้าง gold set ไทย (รวม hard negatives แบบ "หมอน/หาหมอ") ก่อนจูน τ ใด ๆ
    และให้ prompt คืน id ของหลักฐานที่ใช้

**ทำเมื่อว่าง**

11. C12, C15, C16, C17, C18, C19, C21–C24 ตามตาราง
    โดยเฉพาะ C21 (`console.log` ที่พิมพ์ข้อความ tenant ดิบ) ควรลบทันที ใช้เวลาไม่ถึงนาที


## 5. สรุปผลเทส

```
Test Suites: 3 passed, 3 total      (audit ใหม่)
Tests:       38 passed, 38 total

ขอบเขต chatbot + line (รวมของเดิม):
Test Suites: 16 passed, 16 total
Tests:       170 passed, 170 total

ทั้ง repo:
Tests:       355 passed, 17 failed, 5 skipped, 377 total
```

- `npx tsc -p tsconfig.json --noEmit` — ผ่าน
- `npx eslint src/modules/chatbot/audit/*.ts` — ผ่าน (0 error, 0 warning)
- 17 tests ที่ล้มทั้งหมดอยู่ใน `usage/billing` (`ai-billing.service`,
  `ai-billing.ten-events`, `ai-pricing.service`) ล้มมาก่อนรอบนี้ สาเหตุคือ mock
  ไม่มี `creditReservation`/`createQuote` ไม่เกี่ยวกับ core chat และอยู่นอกขอบเขตที่ตกลงกันไว้

สิ่งที่ยัง **ไม่ได้** วัดในรอบนี้ อย่าตีความว่าผ่าน:

- embedding จากโมเดลจริง — ค่า cosine ทั้งหมดในเทสต์เป็นค่าที่กำหนดเอง
  ตัวเลข 0.6 ที่เป็น noise floor จึงยังไม่ถูก calibrate กับ distribution จริง
- คุณภาพ/ความเป็นธรรมชาติของคำตอบภาษาไทยจากโมเดลจริง (mock text ไม่ใช่หลักฐาน)
- recall ของ retrieval บน corpus จริง
- HTTP → signature → BullMQ → worker เต็มเส้น, Redis restart, crash injection
  ระหว่าง provider acceptance
- throughput/latency และ race จริงของ C10 (ยืนยันจาก source อย่างเดียว)
- pgvector index behaviour และ performance ของ `ORDER BY <=>` บนข้อมูลจริง
