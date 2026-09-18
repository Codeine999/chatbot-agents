# Full-loop audit — 14 กันยายน 2026

ตรวจ text-reply flow ทั้งเส้นบน working tree หลัง core refactor (micro knowledge, renderMode, RRF, single-pass retrieval) ด้วยของจริงทั้งหมด: PostgreSQL/pgvector จริง, Redis จริง, Gemini จริง, คิดเครดิตจริง

เอกสารประกอบ: [E2E ทั้งระบบ](mvp-line-rag-billing-flow.md) · [LINE field/state](line-message-e2e-current.md) · [Service dependencies](service-flow.md) · [แผน refactor](rag-core-refactor-plan.th.md)

## 1. วิธีทดสอบและขอบเขต

| ชั้น | วิธี | ครอบคลุม |
| --- | --- | --- |
| Unit | `npx jest` ทั้ง repo | 16 suites / 172 tests |
| Decision + answer | บูต `ChatbotModule` จริงผ่าน Nest testing module ดักทุก log block แล้วเรียก `ChatbotService.handleTextMessage()` ตรง | 21 scenario |
| Concurrency | `Promise.allSettled` ผู้ใช้ 10 คนพร้อมกัน คนละ conversation | 10 request |
| Billing | snapshot wallet/ledger/usage/reservation ก่อน–หลัง แล้วตรวจสมการ | 32 usage event |
| HTTP ingress | POST `/api/line/webhooks` ลงเซิร์ฟเวอร์ที่รันอยู่จริง พร้อม HMAC-SHA256 signature | 4 webhook event |

**ไม่ได้ครอบคลุม:** image/sticker flow, admin chat, top-up, registration flow เต็มรูปแบบ (ระบบสมัครปิดอยู่)

ใช้ `lineMember` สังเคราะห์ (`Uaudit*`) เท่านั้น ไม่แตะแถวลูกค้าจริง และลบทิ้งครบหลังทดสอบ (ตรวจแล้วเหลือ 0 แถว) reply token ปลอมทำให้ LINE ปฏิเสธ ไม่มีข้อความจริงถูกส่งออก

## 2. ผลรวม

| ด้าน | ผล |
| --- | --- |
| Routing ทุก event | **21/21 ตรงตามที่ออกแบบ** |
| ความถูกต้องของคำตอบ RAG | **6/6 ตรงคำถามและตรงกับ evidence** |
| Concurrency 10 คน | 10/10 route ถูก, **8/10 ตอบสำเร็จ**, 2 ตกลง fallback เพราะ provider 429 |
| Credit accounting | **ตรงทุกสมการ ไม่มีข้อผิดพลาด** |
| HTTP ingress → delivery | COMPLETED ครบ delivery ถูกสร้างและ retry ตาม policy |
| Unit test | **17 failed / 155 passed** — ทั้งหมดกระจุกใน 3 suite ของ billing |

## 3. Decision audit ทุก event

รันเดี่ยว เคลียร์ session ก่อนทุกครั้ง

| input | action ที่ได้ | source | ค้น KB? | หลักฐาน / ผล |
| --- | --- | --- | --- | --- |
| `ยกเลิก` | CANCEL_SESSION | RULE 1.0 | ไม่ | ✅ ด่าน 1 ทำงานก่อน session gate |
| `1` | START_REGISTER | RULE 1.0 | ไม่ | ✅ แต่ตอบว่ายังไม่เปิดระบบสมัคร |
| `2` | START_AI_CHAT | RULE 1.0 | ไม่ | ✅ |
| `3` | CONTACT_ADMIN | RULE 1.0 | ไม่ | ✅ |
| `สมัคร` | START_REGISTER | RULE 0.95 | ไม่ | ✅ |
| `วิธีสมัคร` | ANSWER_KNOWLEDGE | RULE 0.9 | **ใช่** | ✅ rule ยก intent ให้ retrieval หา evidence (ruleKnowledgeDecision) |
| `ติดต่อแอดมิน` | CONTACT_ADMIN | RULE 0.95 | ไม่ | ✅ |
| `สวัสดี` | CONTINUE_AI_CHAT | RULE 1.0 | ไม่ | ✅ regex ทักทาย |
| `ขอบคุณ` | CONTINUE_AI_CHAT | RULE 1.0 | ไม่ | ✅ |
| `สวัสดีค่า` | ANSWER_KNOWLEDGE | EMBEDDING 0 | **ใช่** | ⚠️ หลุด regex → RAG เต็มรูปแบบ (16 candidate) |
| `ขอบคุณมากครับ` | ANSWER_KNOWLEDGE | EMBEDDING 0 | **ใช่** | ⚠️ หลุด regex → RAG เต็มรูปแบบ (11 candidate) |
| `"   "` | — | SYSTEM | ไม่ | ✅ คืนเมนูหลัก ไม่เข้า router |
| `เช็คอินกี่โมง` | ANSWER_KNOWLEDGE | CACHE | ใช่ (cache) | ✅ **DIRECT preset 2ms ไม่เรียกโมเดล** |
| `พรุ่งนี้ฝนตกไหม` | GENERAL_QUESTION | AI 1.0 | ใช่ (0 candidate) | ✅ LOW_CONFIDENCE → classifier → GENERAL |
| `คุณคือใคร` | ANSWER_KNOWLEDGE | EMBEDDING 0 | ใช่ | ⚠️ ตอบจาก persona ไม่ใช่ evidence (cosine 0.62) |

## 4. ความตรงของคำตอบกับคำถาม

ตรวจคำตอบเทียบกับ evidence ที่ส่งเข้าโมเดลจริง

| คำถาม | cosine อันดับ 1 | match | ประเมิน |
| --- | --- | --- | --- |
| `มีห้องประชุมไหม ราคาเท่าไร` | 0.8458 | HYBRID | ✅ ราคา 3,000/5,000 ชั้น 2 รองรับ 30 คน ตรงกับแถวใน DB ทุกตัวเลข |
| `ห้องพักมีกี่แบบ` | 0.8108 | EMBEDDING | ✅ ครบ 4 แบบ ขนาดและเตียงตรง |
| `ห้อง Deluxe King คืนละเท่าไร` | 0.8348 | HYBRID | ✅ 2,300 บาท + คำนวณ 7 คืน 13,800 ถูกต้อง |
| `เช็คอินกี่โมง` | — (exact) | EXACT | ✅ ตอบจาก preset ตรงตัว |
| `อยากจัดสัมมนา 30 คน มีห้องรองรับไหม` | 0.7930 | HYBRID | ✅ **paraphrase ข้ามคำได้** ไปเจอห้องประชุมถูกต้อง |
| `ขอเลขบัญชีโอนเงินมัดจำ` | 0.7274 | HYBRID | ✅ **ปฏิเสธและส่งต่อแอดมิน** ตามกฎใน systemPrompt |
| `โอนเงินแล้ว ตรวจสลิปให้หน่อย` | 0.6089 | HYBRID | ✅ ปฏิเสธการยืนยันการชำระเงิน |

ไม่พบการแต่งตัวเลข ไม่พบการยืนยันสถานะการชำระเงิน ซึ่งเป็นข้อห้ามหลักใน `KNOWLEDGE_RULES`

## 5. Concurrency — 10 คนทักพร้อมกัน

wall clock **1,842 ms** สำหรับ 10 request, `[Routing]` ครบ 10 block, ไม่มี request ไหน reject

- **ไม่มีการปนกันของ context** — แต่ละคนได้คำตอบของคำถามตัวเอง คนละ conversation
- `CreditService` log `Retrying serialized AI credit transaction` 5 ครั้ง (สูงสุด 2/3) แล้วสำเร็จทุกครั้ง — Serializable isolation ชนกันแล้ว retry ได้ตามออกแบบ
- **2/10 ได้ fallback** (`u0` ห้องประชุม, `u6` Deluxe King) สาเหตุคือ Gemini ตอบ **HTTP 429 quota exceeded** ระบบ retry 1 ครั้งภายใน ~430 ms แล้วยอมแพ้ → `RAG answer generation failed` → คืนข้อความ fallback

ข้อดีคือ **degrade แบบปลอดภัย**: ไม่ crash ไม่ตอบผิด ไม่หักเครดิต ข้อเสียคือผู้ใช้ 2 คนไม่ได้คำตอบทั้งที่คำถามตอบได้

## 6. Credit accounting

| ตรวจ | ผล |
| --- | --- |
| wallet balance | 9992.963563 → 9991.602122 (**−1.361441**) |
| ผลรวม DEBIT 30 แถวใหม่ | **−1.361441** → ตรงกับ balance เป๊ะ |
| `lifetimeSpentCredit` | +1.361441 → ตรงกับยอดหัก |
| usage event ใหม่ | 32 แถว (LINE_AI_REPLY 36 / EMBEDDING 24 ในหน้าต่างที่ดู) |
| ledger ใหม่ | 30 แถว → **ต่างกัน 2 แถวพอดีคือ call ที่ล้มเหลว** |
| call ที่ล้มเหลว (429) | `status=failed`, 0 token, `chargedCredit=0`, `pricingId=null`, **ไม่มี DEBIT** |
| `reservedCredit` ก่อน/หลัง | 0.217470 / 0.217470 — **ไม่มี hold รั่ว** |
| `idempotencyKey` ซ้ำ | **0** |
| usage ที่ถูก charge แต่ไม่มี ledger | **0** |
| เครื่องหมาย ledger | DEBIT 60 แถว ติดลบทั้งหมด ไม่มีแถวขัดแย้ง |
| `scopeKey` | แยก `query` (embedding) กับ `*` (LINE_AI_REPLY) ถูกต้อง |

ตรงตาม invariant ใน AGENTS.md ทุกข้อ รวมถึง *"Failure before a billable result releases the hold exactly once without DEBIT"*

**ยกเว้นหนึ่งจุด:** มี reservation ค้าง `HELD` 1 แถวตั้งแต่ **9 ก.ย. 2026** (`operationKey=admin-chat:...`, 0.217470 credit, `expiresAt` ผ่านมา 5 วัน) ไม่ได้เกิดจากการทดสอบนี้ แต่ล็อกเครดิตไว้ถาวรเพราะยังไม่มีตัว reclaim reservation ที่หมดอายุ

## 7. HTTP ingress → delivery

POST `/api/line/webhooks` พร้อม HMAC signature จริง 4 event

- HTTP **200** ทุก event, `processedLineWebhookEvent.status = COMPLETED` ทุกแถว
- `lineChatHistory` บันทึกข้อความขาเข้าครบ `sentStatus=received`
- `lineDelivery` ถูกสร้างพร้อมข้อความตอบจริง แล้วขึ้น `FAILED` เพราะ LINE ปฏิเสธ `to` ที่เป็น user สังเคราะห์ — **พิสูจน์ว่าไม่มีข้อความจริงถูกส่งออกระหว่างทดสอบ**
- delivery ที่ล้มเหลวไม่ทำให้ webhook ค้าง และไม่เขียน assistant history (ตรงกับที่เอกสารระบุว่า `finalizedAt` คือขั้นบันทึก local history)

## 8. Unit test

`npx jest` → **155 passed / 17 failed** ใน 3 suite: `ai-billing.service.spec`, `ai-billing.ten-events.spec`, `ai-pricing.service.spec`

ทั้งหมดเป็น **เทสเก่าที่ไม่ได้อัปเดตตามโค้ด** ไม่ใช่บั๊กใน production path:

1. `ai-pricing.service.spec` คาดว่า *"records usage uncharged when the model has no active price"* แต่ `requireActivePricing()` เปลี่ยนไปโยน `ServiceUnavailableException` แล้ว — เป็นการเปลี่ยนโดยตั้งใจเพื่อไม่ให้ AI ทำงานฟรีเมื่อไม่มีราคา คอมเมนต์ในโค้ดระบุเจตนาไว้ชัด
2. อีก 2 suite ล้มที่ `prisma.creditReservation` เป็น `undefined` เพราะ mock ไม่มี model นี้ ขณะที่ `CreditService.findSettledAiResult()` เรียกใช้

ไฟล์ทั้ง 3 รวมถึง service ที่เกี่ยวข้องไม่ได้ถูกแก้ใน working tree → **สถานะนี้มีอยู่ใน commit แล้ว**

## 9. ปัญหาที่พบ เรียงตามความสำคัญ

| # | ปัญหา | ผลกระทบ | ข้อเสนอ |
| --- | --- | --- | --- |
| 1 | Gemini 429 ตอนโหลดสูง retry แค่ 1 ครั้งใน ~430 ms | 2/10 ผู้ใช้ไม่ได้คำตอบตอนคนทักพร้อมกัน | หน่วง exponential + อ่าน `retryDelay` ที่ Gemini ส่งกลับมา ก่อนยอมแพ้ |
| 2 | regex ทักทายครอบคลุมแคบ (`สวัสดีค่า`, `ขอบคุณมากครับ` หลุด) | เสีย 1 embedding + 1 generation ต่อคำทักทายที่หลุด ทั้งที่ตอบจาก template ได้ | ย้ายกฎเข้า `RuleIntentService` ให้รวมศูนย์ แล้วขยายคำลงท้าย |
| 3 | 3 billing suite / 17 tests ล้มใน commit | `npm test` ไม่เขียว ปิดบังการ regress จริงในอนาคต | อัปเดตเทสให้ตรงพฤติกรรมใหม่ (throw) และเติม `creditReservation` ใน mock |
| 4 | คำถามนอกขอบเขต (`คุณคือใคร`) ตอบจาก persona ใน systemPrompt โดยใช้ evidence คนละเรื่อง (cosine 0.62) | ตอบดูดีแต่ไม่ได้มาจากคลังความรู้ | เพิ่มกฎใน `KNOWLEDGE_RULES` ให้คำถามเกี่ยวกับตัวผู้ช่วย/นอกขอบเขตคืน `INSUFFICIENT_CONTEXT` — **ไม่ใช่** ตั้ง similarity threshold ซึ่งขัดกับ §7.5 ของแผน refactor |
| 5 | reservation `HELD` ค้างตั้งแต่ 9 ก.ย. ล็อก 0.217470 credit | `reservedCredit` ไม่มีวันคืน สะสมไปเรื่อย ๆ | job เก็บกวาด reservation ที่ `expiresAt` ผ่านแล้วให้ RELEASED |
| 6 | เมนูโชว์ `1️⃣ สมัครสมาชิก` แต่กดแล้วตอบว่ายังไม่มีระบบ | ผู้ใช้สับสน | ซ่อนตัวเลือกเมื่อ registration ปิด หรือเปลี่ยนข้อความเมนู |

## 10. สิ่งที่ยืนยันว่าทำงานถูกต้อง

- ด่านตัดสินใจทั้ง 9 ชั้นใน `IntentRouterService.resolve()` ทำงานตามลำดับที่ออกแบบ ไม่มีด่านไหนถูกข้าม
- `CANCEL` มาก่อน session gate จริง ยกเลิกกลางการสมัครได้
- `RULE_MAP` ครอบคลุม `ChatIntent` ครบ 7/7 บังคับด้วย `Record<ChatIntent, …>` ตอน compile
- เส้นทาง DIRECT preset ตอบใน **2 ms โดยไม่เรียกโมเดลและไม่เสียเครดิต**
- RAG ตอบตรงคำถามและตรงกับ evidence ทุกข้อ รวม paraphrase ที่ไม่มีคำร่วมกัน
- กฎห้ามยืนยันการชำระเงิน/ตรวจสลิปทำงานจริง
- LOW_CONFIDENCE → classifier → GENERAL ทำงานถูกต้องกับคำถามนอกธุรกิจ
- ระบบ degrade แบบปลอดภัยเมื่อ provider ล้ม: fallback ไม่ crash ไม่ตอบมั่ว ไม่หักเงิน
- Credit accounting ตรงทุกสมการ ไม่มี double charge ไม่มี hold รั่วจากการทดสอบนี้
- 10 request พร้อมกันไม่มี context ปนกัน Serializable retry ทำงานตามออกแบบ
