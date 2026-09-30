# ตรวจสอบ audit และ fallback — 2026-09-27

ตรวจ working tree ที่มีการแก้ไขค้างอยู่ ไม่ใช่เฉพาะ HEAD และรักษาการแก้ไขเดิมไว้

**หมายเหตุ 2026-09-30:** เอกสารนี้บันทึกผลตรวจและ guard ที่มีในวันที่ 27 กันยายน; ต่อมาได้ถอด `requiresLiveData` ออกแล้ว พฤติกรรมปัจจุบันดู [AI chatbot architecture](ai-chatbot-architecture.md) ตัวเลข 42/55 ด้านล่างยังเป็นผลก่อนแก้จาก audit เดิม

## ข้อสรุปจากการนับผลดิบ

พบ artifacts ของ audit เดิมใน scratchpad บนเครื่อง จึงตรวจนับผลเดิมได้โดยไม่เรียก provider หรือแก้ฐานข้อมูล:

`/tmp/claude-1000/-home-codeine-Documents-mine-chatbot-api/044edabc-05d3-4765-a357-b98d7b5fb034/scratchpad/`

| Artifact | SHA-256 |
| --- | --- |
| result-chat.json | efe751729e52483055ac07067441f89883d74b0ff65c442856b643b8b7ef17f9 |
| result-retrieval.json | a392dc3a460a0c901e98ffb8f83d942d2f358546515fb4e7adbcc0b73a490624 |

อ่าน `real.audit.ts` และ `logs-chat.txt` ประกอบเพื่อเทียบ raw response กับ selected evidence แบบเต็ม source/UUID ของแต่ละ turn ด้วย ผลที่ยืนยันได้:

- มี **51 เคส / 55 turns** ไม่ใช่ 48 เคสตามเอกสาร
- คำตอบตรงกับ configured fallback **42/55 = 76.36%**; อีก 13 turns เป็นคำตอบชนิดอื่น รวม DIRECT, rule, general และ clarify ไม่ใช่คำตอบธุรกิจสำเร็จทั้งหมด
- เป็นชุดคำถาม synthetic ใน local environment ไม่ใช่ traffic ลูกค้าจริง และไม่ใช่ผลที่วัดหลัง patch นี้
- มี 43 generation attempts: grounded สำเร็จ 41, general 1, provider error 1 จำนวนนี้ไม่รวม embedding

| สาเหตุของ fallback เดิม | Turns | หลักฐาน |
| --- | ---: | --- |
| ANSWER มี bare ID ที่ตรง selected evidence แบบไม่กำกวม แต่ validator รับเฉพาะ SOURCE:ID | 33 | ตรวจ IDs กับ selected refs ใน logs ของ turn เดียวกัน |
| โมเดลคืน INSUFFICIENT_CONTEXT | 7 | raw decision |
| ANSWER แต่ evidenceIds ว่าง | 1 | E2 คำถามคณิตศาสตร์; สมควรถูกปฏิเสธตาม grounded contract |
| Provider error | 1 | B7; ไม่มี grounded result |
| รวม | 42 | 76.36% ของ 55 turns |

ดังนั้น “34/34 คำตอบถูกต้องถูกทิ้งเพราะรูปแบบ ID” ไม่แม่น: มี ANSWER 34 ครั้งจริง แต่ 1 ครั้งไม่มี citation และการอ้าง ID ที่มีอยู่ไม่ได้พิสูจน์ว่าคำตอบถูกต้อง ตัวเอกสารเองระบุคำตอบบางส่วนที่อนุมานข้อมูลหรือใช้ snapshot เป็นสถานะปัจจุบัน

คำว่า “ทุกคำถามที่ไม่ exact จะ fallback 100%” กว้างเกินผลทดสอบ โค้ดยังมี rule/general และรับ namespaced citations ได้อยู่แล้ว บั๊กนี้เกิดเมื่อ output ไม่ตรง contract ไม่ใช่กฎที่บังคับทุก paraphrase ต้อง fallback

## Retrieval และข้อสรุปอื่น

| ข้ออ้าง | ผลตรวจ |
| --- | --- |
| Gold อยู่ใน selected context 31/31, top-1 29/31, MRR 0.968 | นับจาก result-retrieval.json ได้ตรง: MRR 0.9677419355 |
| 31/31 แปลว่ามีข้อมูลครบทุกส่วน | ไม่ใช่: harness ใช้ `selected.some(...)` แปลว่าเจอ gold อย่างน้อยหนึ่งรายการ; ไม่ใช่ตรวจ answerability หรือความครบถ้วนทุก fact |
| คำถามไม่มี gold เข้า RAG 11/11 | ตรงกับ artifacts สำหรับ D1–D6, E1–E4, F2; H3 อีกหนึ่งเคสเป็น missing reference → LOW_CONFIDENCE |
| ไม่มี relevance gate | จริงในความหมายว่าไม่มีด่านแยกความเกี่ยวข้องก่อน RAG นอกเหนือจาก candidate floors; ยังมี conflict checks และ grounded output validation อยู่ |
| BM25 แยก corpus แล้วรวมจัดอันดับ | พบใน source: AP/Micro คำนวณแยกและ merge เข้า lexical list เดียวก่อน RRF |
| ตัวเลข 1/2/3 ตีเป็นเมนูเสมอ | พบ rule โดยไม่ตรวจประวัติเมนู; ต้องแก้อย่างคง compatibility ของเมนูเก่า |
| Provider/budget fallback ไม่ส่งต่อ admin | พบจริงใน grounded error/budget path ซึ่งคืน isFallback แต่ไม่คืน insufficientContext; orchestrator จึงไม่ requestAdmin |
| Timeout ไม่ retry ทุกกรณี | เหมารวมเกินไป: transient detector รองรับ AbortError/TimeoutError, timeout text และ status บางชนิดอยู่แล้ว แต่ generic error ที่มีเพียงข้อความ aborted ไม่เข้ากฎปัจจุบัน |
| Ordering ใช้ memory | พบ userProcessingTails Map ใน worker; ไม่รับรองการเรียงลำดับข้าม process |
| ความพร้อม 45%, 65%, 78%, 88% | เป็นคะแนนประเมิน ไม่ใช่สถิติจาก test หรือหลักฐานว่าขึ้น production ได้ |

ไม่ได้ตรวจทุก finding ใน audit แบบครบวงจร รวมถึงสภาพ KB/ข้อมูล SNAPSHOT ปัจจุบันในฐานข้อมูล, LINE delivery จริง, PII ทุกเส้นทาง และ ledger/billing

## Patch ที่ทำในรอบตรวจนี้

1. ส่ง `ref: "SOURCE:ID"` ในแต่ละ ragContext item และสั่งให้โมเดลคัดลอก ref ลง evidenceIds ตรงตัว
2. รองรับ bare ID เฉพาะเมื่อระบุ selected item ได้หนึ่งรายการเท่านั้น ยังคงปฏิเสธ wrong source, unknown ID, citation ว่าง และ ID กำกวมข้ามแหล่งข้อมูล ไม่มีการค้นข้าม tenant หรือไปยอมรับ ID นอก context
3. แยก log เหตุผล `INVALID_EVIDENCE_REFERENCE` จาก `INVALID_GROUNDED_OUTPUT` และ `INSUFFICIENT_CONTEXT`; เดิม citation ผิดกลับ log ว่า reason=ANSWER
4. เพิ่ม regression suite โดย replay คำตอบ B1 ที่บันทึกจากโมเดลจริง และ mock provider boundary ตรง ๆ ไม่ผ่านตัวช่วยที่สร้าง citation ให้อัตโนมัติ

ก่อน patch suite ใหม่นี้ fail 4 / pass 8; หลัง patch pass 12/12 เคส B1 เปลี่ยนจาก SYSTEM/CLEAR เป็น KNOWLEDGE/INCLUDE และไม่เรียก requestAdmin ส่วน citation ที่ผิดหรือกำกวมยัง fallback/handoff

ไม่ได้แก้ threshold, เพิ่ม dependency, เปลี่ยน schema, ลบ KB, เปลี่ยน pricing/billing หรือ deploy

## วิธีลด fallback ต่อโดยไม่เพิ่มคำตอบผิด

ลำดับที่ควรทำต่อ:

1. **แยกสาเหตุและวัดจริง:** เก็บ turn-level final outcome ได้แก่ DIRECT, GROUNDED_ANSWER, MODEL_INSUFFICIENT, INVALID_OUTPUT, INVALID_EVIDENCE, PROVIDER_ERROR, BUDGET_DENIED, HANDOFF และ CLARIFY ให้ dedupe ด้วย turn/event ID แยก fallback ที่ควรเกิดกับ fallback ทั้งที่ KB ตอบได้ และแยก model insufficiency จาก validation failure ไม่ใช้จำนวน AI calls เป็นตัวหารแทนข้อความลูกค้า
2. **ตรวจความปลอดภัยก่อนเปิดคำตอบที่เคยถูกทิ้ง:** ทบทวน snapshot/ข้อมูลทดลองตาม tenant; แยกคำถามสถานะปัจจุบัน เช่น ห้องว่าง สต็อก ยอดเงิน ไป authoritative DB/API หรือ handoff เพิ่มข้อห้ามอนุมาน “ไม่มี” จาก “ไม่ได้กล่าวถึง” พร้อม Thai KB-gap tests การเพิ่ม prompt อย่างเดียวไม่รับรองความถูกต้องและไม่ครอบคลุม DIRECT
3. **ทำ relevance gate จากชุดประเมิน:** เก็บชุด Thai exact/paraphrase/multi-fact/นอกโดเมน/ข้อมูลไม่พอ แยก calibration กับ held-out evaluation แก้คะแนน lexical ข้าม corpus และ stopword โดยรักษาคำปฏิเสธ แล้ววัด recall และการปฏิเสธคำถามนอกขอบเขตก่อนปรับ gate; ให้ weak/unrelated retrieval ไป classifier เดิมก่อน generation ไม่ลด/เพิ่ม cosine เป็น 0.70 แบบเดา และไม่ใช้ RRF score เป็น probability
4. **แก้ handoff และเลขเมนู:** provider/budget fallback ที่สัญญาส่งต่อ admin ต้องทำ durable requestAdmin โดยไม่ mute AI; ทดสอบ retry/pending usage เดิม เลข 1/2/3 ต้องตรวจบริบทเมนู/active flow พร้อมรักษาปุ่มเก่าที่ใช้งานอยู่
5. **ลด malformed output:** เพิ่ม structured output ผ่าน shared provider abstraction หากจะทำต้องตรวจ adapters ทุกตัวและ replay/billing fingerprint ที่อิง request; ยังต้อง validate citations และความเพียงพอของข้อมูลเสมอ

ใช้ recordings เดิมตรวจ backward compatibility ได้ แต่ต้องรัน fresh Thai eval บน KB ที่ตรวจแล้วเพื่อวัดคุณภาพหลังแก้ prompt ไม่ควรสรุปว่า patch ID เพียงอย่างเดียวทำให้ fallback เหลือ 9/55 เพราะ output ใหม่และ context ใน turn ถัดไปอาจเปลี่ยน และบางคำตอบเดิมที่ผ่าน citation check ยังอาจผิด

## Verification และข้อจำกัดก่อน deploy

ผ่านจริง:

- `bun run test --runInBand --silent --runTestsByPath src/modules/chatbot/audit/grounded-evidence.audit.spec.ts` — 12 tests
- `bun run test --runInBand --silent --testPathPatterns='modules/chatbot|ai-provider|modules/ai/embeding'` — 19 suites / 195 tests (รวม 12 ข้อข้างต้น ไม่ใช่บวกเพิ่ม)
- `bunx --no-install tsc --noEmit`
- `bunx --no-install eslint src/modules/chatbot/aichat.service.ts src/modules/chatbot/prompt/ai-setting-prompt.composer.ts src/modules/chatbot/audit/grounded-evidence.audit.spec.ts`
- `bun run build`

รอบตรวจครั้งแรกไม่ได้รัน Gemini/embedding สด, ไม่ส่ง LINE, ไม่เขียน DB, ไม่รัน billing/full-repository suite หรือ HTTP → queue → delivery E2E ผล unit/replay ไม่ใช่อัตราความแม่นยำโมเดลจริง ณ ตอนนั้นปัญหา relevance, mutable facts, provider handoff และเลขเมนูยังอยู่ ส่วนการแก้ไขถัดมาอยู่ด้านล่าง

## แก้ไขต่อหลังการตรวจ — 2026-09-27

ใช้ service/provider abstraction เดิม ไม่เพิ่ม dependency, reranker, ตาราง, migration หรือ integration ใหม่

| ประเด็น | สิ่งที่แก้และขอบเขต |
| --- | --- |
| Grounded output | คง ref/unique bare ID validation และเพิ่ม native JSON schema สำหรับ Gemini ผ่าน AiGenerateRequest; provider อื่นยังใช้ prompt + Zod/citation checks |
| Relevance | Lexical match ที่ตรงเพียง function words หรือตัวเลขไม่ผ่าน; เก็บ หรือ/และ/ไหม/ไม่ ไว้ใน scoring เมื่อมี content term ตรงกัน; vector-only RAG ผ่าน classifier เดิมก่อน GENERAL หรือ grounded BUSINESS |
| Classifier failure | budget/provider/malformed output ระบุ failed=true; ห้ามใช้ผล fail-safe BUSINESS เป็นการอนุญาตให้ generate จาก vector-only evidence |
| BM25 fusion | AP กับ Micro คำนวณคนละ corpus จึงแยกเป็นคนละ RRF list ร่วมกับ vector อีก list ไม่เปรียบเทียบ raw BM25 ข้าม corpus; ไม่เปลี่ยน cosine/BM25 floors |
| Context selection | ไม่เติมช่องที่เหลือด้วย unrelated vector-only candidates; dedupe คำตอบเทียบเท่าในเรื่องเดียวกัน; source/id เดียวกันใช้ content จาก DB lexical ก่อน vector |
| Mutable facts | ตรวจคำถามห้องว่าง สต็อก ยอดเงิน สถานะบัญชี/ธุรกรรม และราคาปัจจุบันที่ policy รองรับก่อนค้น/DIRECT; คืน REQUIRES_LIVE_DATA → requestAdmin เนื่องจากยังไม่มี authoritative live integration |
| SNAPSHOT / missing facts | กันรายการที่มี marker SNAPSHOT/ข้อมูลทดสอบ/ห้ามใช้เป็นข้อมูลปัจจุบันตั้งแต่ matcher และก่อนเลือกหลักฐาน; ไม่ให้ snapshot สร้าง false exact conflict; prompt ระบุว่าการไม่กล่าวถึงไม่ใช่หลักฐานว่าไม่มี |
| Digits | อัปเดต 29 ก.ย.: ถอดเมนูเลข hard-code ออก ใช้ Rich Menu postback/label ที่กำหนดไว้; ตัวเลขกลางบทสนทนาใช้หัวข้อ user ก่อนหน้า; active registration รับเลขตาม flow |
| Fallback / handoff | ทุก AI fallback รวม provider error, งบหมด, malformed/insufficient, general และ image ทำ requestAdmin + SYSTEM/CLEAR; ไม่ mute AI ไม่ทับ registration; PendingAiUsageError ยังโยนให้ worker recovery |
| Timeout | generic SDK error ที่มีข้อความ aborted เข้า transient retry loop เดิม |
| PII | เพิ่ม email/เลข13หลักใน redaction และใช้กับ current message/history ก่อน generation รวมทั้ง query ก่อน embedding; เป็น pattern redaction ไม่ใช่เครื่องตรวจ PII ทุกรูปแบบ |
| Logs / copy | ลบ console.log เมนูดิบและ session WARN ทุกข้อความ; conflict/retrieval error/live fact ผ่าน logDecision; template ถามคำถามใช้ “ครับ” ให้สม่ำเสมอ |
| Replay | request ที่มี responseJsonSchema นำ schema เข้าคำนวณ fingerprint ด้วย; request ปกติไม่มี schema ใช้สูตร key เดิม; ไม่เปลี่ยน reserve/settle/release หรือ rate calculation |

เพิ่ม regressions สำหรับ Thai small talk, business paraphrase ที่ cosine 0.638, KB gap, snapshots, exact conflict, numeric follow-up, active registration, budget/provider/pending failure, current-message PII, Gemini request payload และ schema-aware replay tests ใช้ mocked provider/embedding/LINE boundaries

### ผลตรวจหลังแก้

- ชุดที่เกี่ยวข้องช่วงก่อนตรวจทั้ง repo: 23 suites / 237 tests ผ่าน; ต่อมาเพิ่มอีกหนึ่งเคส snapshot + exact conflict และรันรวมทั้ง repo
- `env -u DATABASE_URL -u RICH_MENU_CONCURRENCY_TEST bun run test --runInBand --silent`: **444 passed, 17 failed, 5 skipped**; 50 suites ผ่าน, 3 ล้ม, 2 skipped
- รัน billing baseline ก่อนเพิ่ม schema fingerprint ได้ 17 ข้อล้มเดิม; เทียบรายชื่อกับ final full run ไม่มี failure ใหม่ ทั้ง 17 ข้อยังเป็น billing/pricing tests เดิม จึงไม่ถือว่า full test gate ผ่าน
- `bunx --no-install tsc --noEmit`: ผ่าน
- `bunx --no-install eslint <ไฟล์ TypeScript ที่เปลี่ยนและไฟล์ใหม่ทั้งหมด>`: ผ่าน
- `bun run build`: ผ่าน

### ข้อจำกัดและ deploy

- ยังไม่มี fresh Gemini/embedding eval หลังเปลี่ยน prompt/scoring จึงไม่รายงาน fallback rate ใหม่หรือรับรองคุณภาพคำตอบจาก unit tests; การทดสอบ closed-world ตรวจ policy/prompt และการจัดการ output ที่ mock มา ไม่ได้พิสูจน์ว่าโมเดลจริงจะไม่อนุมานผิด
- Guard สถานะสดเป็น deterministic patterns ที่มี regression coverage ไม่ใช่ semantic detector ที่ครอบคลุมทุกถ้อยคำ; ไม่มี live inventory/account API เพิ่มเข้ามา
- Classifier ใช้เพิ่มเติมสำหรับ vector-only candidates; lexical/hybrid ที่ผ่านยังต้องพึ่ง grounded sufficiency contract ไม่มี reranker ที่พิสูจน์ความเกี่ยวข้องทุกกรณี
- Vector-only successful answer เพิ่มหนึ่ง classification call; context dedupe/filter อาจเปลี่ยน recall ของคำถามหลาย fact จึงต้องประเมินกับ KB จริงก่อน deploy
- Prompt/schema/fingerprint เปลี่ยน: ให้ turn ที่ค้างอยู่จบด้วย worker รุ่นเดิมก่อน rollout เพื่อไม่ให้ event เดิมคำนวณเป็น request key ใหม่กลาง retry; ยังไม่ได้ deploy หรือแก้ข้อมูลใน DB
- งาน LINE/infra อื่นใน audit เช่น ordering ข้าม process, postback inbound deduplication, rich-menu cache ข้าม instance, payload/LINE length validation และ sticker routing ไม่อยู่ใน patch core นี้; billing tests เดิมยังต้องแก้แยกตาม behavior ปัจจุบัน
