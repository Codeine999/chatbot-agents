# Core AI/RAG audit — P0–P5

วันที่ตรวจ: 2026-09-20

รายงานผลตรวจ ความเสี่ยง ผลทดสอบ และข้อเสนอแก้ไข แยกจาก [architecture และ function flow ปัจจุบัน](ai-chatbot-architecture.md) ขอบเขตไม่รวม registration; ไม่มีการแก้ runtime defects ในรอบ audit

## 1. ข้อสรุปและระดับหลักฐาน

โครงสร้าง single retrieval entry point → lexical + vector → RRF → grounded answer เหมาะกับระบบ support RAG ขนาดนี้ PostgreSQL/pgvector เพียงพอเป็นฐานเริ่มต้น ไม่จำเป็นต้องเพิ่ม framework หรือ vector database ใหม่เพื่อแก้ปัญหาที่พบ แต่ **ยังไม่ควรถือว่า matching score ผ่านการ calibrate หรือระบบพร้อมหลาย worker/tenant**

หลักฐานรอบนี้แยกเป็น:

- **ทดลองจริงใน sandbox:** สร้าง container PostgreSQL/pgvector ใหม่ชื่อ `chatbot-core-audit-20260920`, database `core_audit`, bound localhost random port; migrate ทั้ง 33 migrations ผ่าน ไม่มีการอ่าน/เขียนข้อมูลลูกค้าจาก DB เดิม
- **19 characterization/integration tests ผ่าน:** ใช้ Prisma, SQL, pgvector, router, retrieval, AiChat, admin services และ billing/credit จริงตามแต่ละ test; embedding เป็น synthetic 1536-dimensional basis vectors; model/LINE/Redis boundary เป็น mock
- **ชุดเดิม:** 24 suites, 203 passed / 18 failed (ก่อนเพิ่ม sandbox suite); 17 failures เป็น billing mocks/expectations ไม่ตรง source และ 1 เป็นข้อความ CLARIFY ไม่ตรง assertion
- **Source review:** worker ordering, auth, handoff, cache invalidation, query limits, provider request construction, reservation recovery และ schema
- **Verification สุดท้าย:** 19 sandbox tests ผ่านหลังแก้ test setup, build ผ่าน, ESLint ไฟล์ test ใหม่ผ่าน, diff whitespace check ของเอกสารผ่าน; container sandbox ถูก stop หลังจบและเก็บไว้ให้ตรวจซ้ำ ไม่มีการลบฐานเดิม
- **ยังไม่ได้วัด:** embedding จากโมเดลจริง, live-model Thai answer quality, retrieval recall บน corpus จริง, throughput/latency หลาย worker, HTTP signature-to-BullMQ E2E เต็มชุด, Redis restart และ crash injection ระหว่าง provider acceptance/settlement

Mock text ที่เขียนให้โมเดลตอบ **ไม่ใช่** หลักฐานว่าโมเดลตอบเป็นธรรมชาติหรือ grounded จริง ไม่มีการส่ง LINE จริงหรือเรียก provider โดยใช้ credentials จาก environment เดิม ไม่มีการอ้างว่า 19 tests ที่ผ่านแปลว่า defects ถูกแก้: tests ชื่อ “observes …” ตั้งใจยืนยันพฤติกรรมที่มีปัญหาเพื่อให้ทำซ้ำได้


## 2. Findings P0–P5

ระดับใช้ในเอกสารนี้: P0 = เหตุวิกฤตที่ต้องหยุดใช้งานทันที, P1 = correctness/security สำคัญ, P2 = คุณภาพ/ความน่าเชื่อถือที่ควรแก้ก่อนขยาย, P3 = usability/observability, P4 = documentation/test maintenance, P5 = improvement ที่ยังไม่มี defect ยืนยัน ระดับขึ้นกับ deployment จริง โดยเฉพาะหลาย instance/tenant

| ID | ระดับ | ปัญหาและ trigger | หลักฐาน / แนวแก้ |
|---|---|---|---|
| A01 | P1 | AnswerPattern admin list/count/update/delete/reindex ไม่มี tenant predicate ขณะที่ MicroKnowledge และ retrieval scoped; เมื่อมี foreign-tenant rows admin เห็นและลบได้ สร้าง pattern ใหม่ก็ไม่ผูก deployment tenant | Sandbox ยืนยัน foreign row ถูก list/delete ผ่าน `AdminKnowledgePatternService`; เพิ่ม trusted scope ให้ทุก CRUD/indexing query และ negative tests |
| A02 | P1 | ADMIN POST AiSetting ใหม่ใช้ default platform prompt และ active=true; runtime เลือกใหม่ล่าสุด กฎ DEV ของ row ก่อนหายจาก effective prompt แม้ POST ไม่ส่ง systemPrompt | Sandbox ยืนยัน `DEV_ONLY_RULE` หาย; กำหนด platform-policy continuity ภายใน AiSetting รวมกรณี create/activate/deactivate/delete; การ copy ตอน create อย่างเดียวไม่แก้ทุกกรณี |
| A03 | P1 | หลาย process ไม่มี per-conversation ordering ร่วมกัน: `userProcessingTails` เป็น Map ภายใน worker ส่วน DB lease ป้องกันเฉพาะ event เดียว ไม่กันสอง event ของ user เดียวทำพร้อมกัน | Source: `line-events.processor.ts:processQueuedJob` + `claimWebhookEvent`; ต้อง serialize ต่อ conversation ข้าม process และรักษาลำดับเมื่อ event เก่ารอ retry; ยังไม่ได้ load-test race นี้ |
| A04 | P1 | Worker cache snapshot ยังตอบ DIRECT จาก pattern ที่อีก instance ปิด/แก้/ลบแล้วได้จน TTL 240s; refresh หลัง CRUD กระทบเฉพาะ cache instance ที่รับคำขอ | Sandbox disable row หลัง cache.refresh แล้วยังได้คำตอบเก่า; ใช้ invalidation/version ข้าม instance หรือ authoritative check ก่อน DIRECT |
| A05 | P1 | Reindex อ่าน document ก่อน provider call แล้ว upsert vector โดยไม่เทียบ revision; concurrent update ใหม่ถูก vector เก่าทับ ทำให้ similarity มาจากคนละเนื้อหากับ answer ปัจจุบัน | Sandbox คุมจังหวะ promise และ transaction พิสูจน์ cosine=1 ของ old vector คู่กับ new answer; ใช้ content hash/version + compare-and-swap/retry ทั้ง reindex และ PATCH; อย่าย้าย provider เข้า transaction |
| A06 | P2 | Substring ไทยทำ false positive: query “นอนไม่หลับควรไปหาหมอนไหม” ติด keyword/title “หมอน” ได้ lexical=4 และ RAG แม้ vector ไม่มีผล; GENERAL classifier ถูกข้าม | Sandbox SQL จริง; ต้อง gold set hard negatives, entity/topic matching และ relevance gate ที่ไม่ใช้ raw RRF เป็น confidence |
| A07 | P2 | RAG provider error/empty/budget fallback อาจบอก “ส่งต่อแอดมิน” แต่ไม่เรียก requestAdmin; เฉพาะ sentinel/conflict/LOW→BUSINESS เข้าสู่ handoff จริง | Sandbox provider timeout ได้ข้อความ handoff แต่ requestAdmin ไม่ถูกเรียก; ให้ response action สอดคล้องผลจริง หรือเปลี่ยนข้อความ fallback ให้ตรงสถานะ |
| A08 | P2 | Prompt ซ้ำ history/current ใน systemInstruction และ messages ทั้ง GENERAL/RAG และ history ของ image; เพิ่ม input/reservation ทุก turn | Sandbox ยืนยัน payload ซ้ำ; รักษา role/section แต่ส่งข้อมูลชุดเดียว |
| A09 | P2 | 17 billing tests เก่าล้มเพราะไม่มี createQuote/findSettledAiResult/creditReservation ใน mock หรือคาดว่า unpriced model ได้ใช้ฟรี; จึงไม่ใช่ regression protection ปัจจุบัน | Execute ชุดเดิมแล้ว; ปรับ fixtures ให้ตรง reserve/settle/replay โดยรักษา assertions ทางธุรกิจ; 3 DB tests ใหม่ช่วยบางกรณีแต่ไม่แทน full billing acceptance |
| A10 | P2 | จำกัด lexical scan 500 rows เรียง priority/updatedAt ไม่ใช่ query relevance; row หลัง 500 ที่ไม่มี vector จะค้นไม่เจอ และ cap ยังทำให้ safeDirect ถูกปิดทั้ง snapshot | Source matcher/cache/micro; ต้อง coverage monitoring และ indexed lexical retrieval/pagination ที่ไม่สูญ recall |
| A11 | P2 | current input ถูกส่งให้ embedding/classifier/generation โดยตรง; PII redaction ทำกับ logs และ persisted context ไม่ใช่ provider boundary ทั้งหมด | Source: Chatbot input → retrieve → embedQuery; ไม่ใช่ registration audit และยังไม่ได้ live-egress test; วาง data-minimization policy ก่อน provider สำหรับข้อความลูกค้าทั่วไป |
| A12 | P3 | GENERAL classification confidence=0 ยังเข้า GENERAL; scalar ถูกเก็บ/แสดงแต่ไม่เป็น decision gate | Sandbox ยืนยัน; อย่าตีความ confidence เป็น calibrated probability; กำหนด uncertainty policy จาก eval ก่อนเพิ่ม threshold |
| A13 | P3 | style ใช้เฉพาะ generated replies; DIRECT ใช้ text ใน DB, templates มีทั้งครับ/ค่ะ และ CLARIFY ถามกว้าง ไม่บอกว่าต้องการรุ่นไหน | Source + static output review; curate DIRECT/templates ให้ persona สอดคล้อง แยกคำถามขอข้อมูลตาม missing field |
| A14 | P3 | promptVersion อยู่ใน prompt แต่ไม่มี AiSetting ID/version/content hash ใน AiUsageEvent; version ไม่เพิ่มเองเมื่อแก้ ownerPrompt | Source schema/composer; tracing หลังแก้ prompt หลายรอบยังคลุมเครือ ใช้ request metadata และ explicit version policy |
| A15 | P3 | Socket namespace มี JWT authentication แต่ CORS origin='*' ไม่ใช่ approved-origin list ตาม AGENTS | Source notification.gateway.ts; จำกัด deployment origins; wildcard ไม่ได้แปลว่า anonymous bypass JWT |
| A16 | P4 | เอกสารเดิมระบุ agentic second pass, classifier ตอบ final ใน call เดียว, reserve commented out และลิงก์ไฟล์ที่ถูกลบ | แก้ในเอกสาร architecture แล้ว; source comments บางจุดยังเก่า เช่น stale events “dropped” แต่ปัจจุบันอายุใช้ตัด REPLY eligibility |
| A17 | P4 | CLARIFY text test คาด “รุ่นไหน” แต่ source ตอบ “ช่วยอธิบายเพิ่มเติมหน่อยได้มั้ยครับ” | Execute ยืนยัน; ไม่เปลี่ยน assertion ให้เขียวโดยไม่ได้ตกลง UX ที่ต้องการ |
| A18 | P5 | ยังไม่มี held-out Thai evaluation corpus/รายงาน naturalness จริงและ relevance metrics | เป็นงานเพิ่ม ไม่ใช่ช่องโหว่ยืนยัน; rubric และแผน eval อยู่ หัวข้อคำตอบลูกค้า |

**P0:** ไม่พบจากหลักฐานรอบนี้ ไม่ใช่คำรับรองว่าไม่มี P0 ในระบบทั้งหมด

**Handoff policy conflict:** AGENTS ต้อง mute จน explicit release แต่ source ปัจจุบันแยก waiting_admin กับ Redis TTL 10m และประวัติคำขอผู้ใช้เคยต้องการ auto-resume จึงบันทึกเป็น policy mismatch ที่ต้องเลือก contract ให้ชัด ไม่เปลี่ยนพฤติกรรมใน audit นี้


## 3. Matching score makes sense แค่ไหน

### Lexical

`AnswerPatternService` ใช้ scorer เดียวกับ cache/DB/MicroKnowledge เพื่อกัน formula drift:

- Keyword: full message 5, whitespace token exact 4, substring 3, loose partial 1.5; ใช้ best keyword + extra-hit bonus สูงสุด 1
- Question example: exact 5, contains 2.5, token-overlap สูงสุด 2; ใช้ best example
- intentKey +2, title +1, category +1, description +0.5
- Matcher ทิ้ง score <2; hybrid layer ทิ้ง lexical <3 (configurable)
- Exact approved questionExamples เท่านั้นที่มีสิทธิ์ DIRECT; broad words เช่น ราคา/product ไม่ DIRECT, ambiguous presets/capped 500-row set ปิด safeDirect
- Exact DIRECT เช็คข้อขัดแย้งจาก pool ที่อ่านมา แต่ cache exact short-circuit ไม่อ่าน MicroKnowledge/vector มาตรวจอีกครั้ง

นี่คือ heuristic score ไม่ใช่ BM25 หรือ probability จุดดีคืออธิบาย contribution ได้และไม่ให้ keyword กว้างตอบ DIRECT จุดอ่อนคือ substring ไทยไม่รู้ขอบเขตคำ/ความหมาย “หาหมอนไหม” ชน “หมอน” ได้จริง การเพิ่ม keyword จำนวนมากหรือ metadata ที่ซ้ำช่วย score โดยไม่ได้รับประกัน intent

### Vector + RRF

`SemanticSearchService` สร้าง query embedding ครั้งเดียวแล้วใช้ค้น AnswerPatternVector กับ MicroKnowledgeVector พร้อมกัน; SQL cosine = `1 - (embedding <=> query)`, model/active/tenant/language filter ก่อนส่งผลให้ retrieval

สอง rank lists คือ lexical (รวมสอง source) กับ vector (รวมสอง source) แล้ว sum `1/(60+rank)`; rank เริ่ม 1:
- อันดับ1จาก channel เดียว = 0.016393…
- อันดับ1ทั้งสอง channel = 0.032787…
- ไม่ควรแปลงเป็น “มั่นใจ 3.28%” หรือเทียบกับ cosine 0.6
- priority เป็น tie-break ภายหลัง relevance ไม่ควรเป็นความถูกต้องของเนื้อหา

RRF เหมาะกับคะแนนคนละ scale และเป็นแนวปฏิบัติที่มีในระบบ search จริง ([Elastic RRF](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion)); แต่ algorithm รวมอันดับไม่ได้พิสูจน์ answerability

Cosine floor 0.6 เป็นค่าเริ่มต้น ยังไม่มีผล Thai held-out evaluation รองรับ ทุก candidate ที่ผ่าน floor มีโอกาสเข้า top3 โดยไม่มี calibrated relevance/answerability gate ก่อน RAG ระบบพึ่ง model sentinel เป็นชั้นท้าย หากพบ unrelated lexical match ก็ข้าม BUSINESS/GENERAL classifier ได้

Select สูงสุด 3 contexts / 12,000 characters (title+content+answer) โดยข้าม fact ที่ใหญ่เกินแทนการตัด negation/condition ออก ข้อดีคือรักษา fact เต็ม แต่ metadata/JSON/prompt overhead ไม่อยู่ใน character budget นี้ และ candidate ใหญ่ทั้งหมดทำให้ LOW ได้

pgvector เป็นทางเลือกที่สมเหตุผล แต่หากใช้ approximate indexes การ filter อาจลดจำนวนผลลัพธ์หลัง index scan ต้องทดสอบ recall บนข้อมูลขนาดจริงก่อน tuning ([pgvector filtering](https://github.com/pgvector/pgvector#filtering)); synthetic basis-vector test รอบนี้พิสูจน์ SQL/model/scope filtering เท่านั้น


## 4. คำตอบลูกค้า: สิ่งที่ประเมินได้และไม่ได้

| กรณี | ผลที่ตรวจได้ | ประเมินคุณภาพ |
|---|---|---|
| Exact “หมอน Cloud ซักได้ไหม” | จริงจาก curated sandbox row: “ถอดปลอกซักได้ครับ แต่ไส้หมอนห้ามซักนะครับ” ไม่มี model call | ตรงคำถาม มีข้อยกเว้นครบ สั้นและอ่านเหมือนแชท; คุณภาพมาจากคนเขียน source |
| “นอนไม่หลับควรไปหาหมอนไหม” | จริงจาก retrieval: RAG, lexical4, RRF1/61; ไม่ใช่ GENERAL | คัด context ผิด domain แล้ว แม้ final model อาจ refuse ได้ก็เสีย call/เสี่ยงตอบเรื่องสินค้า |
| Ambiguous reference | static: “ช่วยอธิบายเพิ่มเติมหน่อยได้มั้ยครับ” | สุภาพแต่ไม่ actionable; ควรบอกว่าต้องการชื่อสินค้า/รุ่นและถามเพียงข้อเดียว |
| Menu “2” | static: “ได้เลยค่ะ ต้องการสอบถามเรื่องอะไรคะ” | เป็นธรรมชาติ แต่เสียง persona สลับจาก templates ที่ใช้ครับ |
| RAG provider error | จริงจาก sandbox setting: “ส่งต่อแอดมินช่วยตรวจสอบให้ครับ” แต่ไม่มี requestAdmin | ภาษาโอเค แต่คำสัญญาไม่ตรงระบบ; correctness ต้องมาก่อน tone |
| Greeting / vector RAG / general sky question | มี mock outputs เพื่อ test request/route/call count | **ห้ามให้คะแนน naturalness ของโมเดลจากผลนี้** |
| Knowledge insufficient | sentinel → static handoff ไม่มี classifier loop | fail-safe ดีเมื่อ model ส่ง sentinel ถูก แต่ไม่ได้พิสูจน์ว่า model ตรวจ evidence ได้ทุกครั้ง |

ตัวอย่างเป้าหมายที่ควรใช้เป็น rubric (เป็นข้อเสนอ ไม่ใช่ผล live model):
- “ซักได้เฉพาะปลอกครับ ส่วนไส้หมอนห้ามลงเครื่องนะครับ”
- “หมายถึงหมอน Cloud หรือ Air ครับ จะได้แนะนำวิธีดูแลให้ตรงรุ่น”
- ข้อมูลไม่มี: ระบุสิ่งที่ยังยืนยันไม่ได้ แล้วส่งต่อจริง; ไม่ถามซ้ำสิ่งที่ history ชัดอยู่แล้ว
- Greeting ไม่ต้องอธิบายยาว/ขายทันที; อีโมจิ light ให้เป็นทางเลือก ไม่เติมทุกประโยค

Eval ต่อไปต้องใช้ **synthetic non-PII corpus + sandbox-only provider endpoint ที่ยืนยันแล้ว**: golden queries อย่างน้อยแยก exact/paraphrase/typo/negation/condition/follow-up/GENERAL/hard-negative/conflict/injection/unknown entity ให้ human label relevant source IDs + expected route + required facts + forbidden claims

วัด retrieval Recall@3/MRR, false-DIRECT, false-RAG on GENERAL, business misroute, fallback/handoff rate; generation rubric แยก groundedness/completeness/natural Thai/redundant questions/persona พร้อม latency/token usage และ model/prompt version ไม่รวมเป็นคะแนนเดียวแล้วกลบ factual failures ขณะนี้ยังไม่มีข้อมูลพอให้ให้เปอร์เซ็นต์คุณภาพทั้ง project


## 5. ทำซ้ำการทดสอบอย่างปลอดภัย

ไฟล์: [core-audit.sandbox.spec.ts](../src/modules/chatbot/core-audit.sandbox.spec.ts)

- Opt-in ด้วย CORE_AUDIT_DATABASE_URL เท่านั้น; check hostname=127.0.0.1, database=core_audit, username=audit และห้าม port5432
- beforeEach ล้างเฉพาะ knowledge/AiSetting ใน database ทดสอบนี้; fixture billing สร้างบริษัท/wallet/ledger ใหม่ด้วย synthetic credits; ห้ามชี้ไปฐานจริง
- ใช้ container ใหม่ไม่มี mounted volume ของเดิม; migrate ด้วย DATABASE_URL override ของ sandbox
- Prisma 7 compiler ใน Jest ต้องใช้ node --experimental-vm-modules; การรัน bun run test ธรรมดากับ real Prisma เคยล้มด้วย missing VM modules ก่อนปรับ command
- ไม่ instantiate AppModule; test/app.e2e-spec.ts เดิม import AppModule เต็มและไม่ mock LINE/AI จึงไม่รันกับ environment เดิม
- “webhook service → billed greeting → accepted delivery survives replay” ใช้ real inbound/claim/outbox/history/usage/ledger และ mocked LINE/model/context; ไม่ใช่ HTTP/BullMQ/Redis integration

```sh
# หลังสร้าง ephemeral pgvector container และตรวจ localhost port แล้ว
DATABASE_URL='postgresql://audit:<sandbox-password>@127.0.0.1:<port>/core_audit' bunx prisma migrate deploy
CORE_AUDIT_DATABASE_URL='postgresql://audit:<sandbox-password>@127.0.0.1:<port>/core_audit' node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand core-audit.sandbox.spec.ts
bun run test -- --runInBand --testPathIgnorePatterns registration
bunx eslint src/modules/chatbot/core-audit.sandbox.spec.ts
bun run build
```

Tests ใหม่ครอบคลุม migration defaults, DIRECT no calls, Thai collision, SQL scope/model filters, vector RAG calls, GENERAL zero confidence, BUSINESS/malformed fail-safe, greeting, stale cache, platform reset, duplicated prompt, foreign admin scope, fallback/handoff mismatch, embed-on-create, stale reindex race, webhook/delivery replay, billing replay, failure release, concurrent reservation


## 6. ลำดับงานแก้หลัง audit

1. ทำ tenant scope ของ AnswerPattern CRUD ให้ครบ, platform-policy continuity และ distributed ordering ก่อนขยาย instance/tenant
2. แก้ cache invalidation และ source/vector revision consistency; ทำ regression tests จาก characterization ให้เป็น desired contract
3. แก้ fallback side effects ให้ตรงคำตอบลูกค้า; เลือก handoff contract ให้ตรง AGENTS/ผลิตภัณฑ์
4. แก้ billing mocks ที่ drift แล้วเพิ่ม DB-backed acceptance สำหรับ insufficient wallet/budget, cached/long-context pricing, embedding scopes, expiry, settlement failure และ crash หลัง provider acceptance
5. ทำ Thai gold set และ sandbox live-model eval ก่อนปรับ noise floor/เพิ่ม reranker; ปรับ template/DIRECT tone ตาม rubric และ expose renderMode ตามสิทธิ์ที่เหมาะสม
6. เก็บ tracing IDs/version/hash และลด prompt duplication; ตรวจ schema/links/comment drift ต่อเนื่อง

เอกสารอ้างอิงที่ยังมีใน working tree: [LINE current flow](line-message-e2e-current.md), [ERD](erd-database.md) อาจมีบางข้อความเก่าที่ต้องเทียบ source; ไม่คืนไฟล์เอกสารอื่นที่ผู้ใช้ลบไว้
