# แผน Turn Understanding (v2 · lean): ให้บอทเข้าใจเจตนาจากบริบท โดยไม่เพิ่ม LLM เกินจำเป็น

> 23 พ.ย. 2026 · branch `product` · สถานะ: **แผน ยังไม่ลงมือ** · ผู้ลงมือ: Sonnet (ทำทีละ Phase ตามลำดับ ห้ามข้าม)
> อ่านคู่กับ: `CLAUDE.md` (§2–§5, §9, §10, §13), `.claude/rules/rag-ai.md`, `.claude/rules/handoff.md`, `docs/ask-back-plan.md`
> v2 แทนที่ v1 ทั้งฉบับ (เหตุผลที่เปลี่ยนอยู่ใน §9) แผนนี้ **ต่อยอด** `ask-back-plan.md` และที่เก็บ pending ต้องมีที่เดียว

---

## 0. กติกาสำหรับผู้ implement (อ่านก่อนแก้โค้ด)

1. **ทำทีละ Phase** จบแต่ละ Phase ต้องผ่าน `npm run build`, `npm run lint` และ `npm test` ก่อนเริ่มงาน ให้บันทึก baseline ของ test ไว้ เพราะ **ตอนนี้มี jest แดงอยู่แล้วบางตัว** เกณฑ์คือห้ามมีตัวที่แดงเพิ่มขึ้นใหม่ ส่วน live eval ใช้ `npm run test:live-eval` (config `test/jest-live.json`)
2. **พฤติกรรมใหม่ต้องอยู่หลัง flag ที่มีค่า default ปลอดภัย** ถ้า flag ปิด พฤติกรรมต้องเหมือนวันนี้ ยกเว้น Phase A ซึ่งเป็น bug fix ที่เปิดถาวร
3. Invariants จาก `CLAUDE.md` §13 ที่เกี่ยวข้อง:
   - LLM ทุก call ต้องผ่าน `UsersAiProviderService.generate` และ `AiBudgetService.tryConsume` และต้อง rethrow `InsufficientCreditException` กับ `PendingAiUsageError` เสมอ
   - **Idempotency:** billing key คือ `usage:{turnId}:{sha256(request)}` ห้ามใส่ค่าที่อาจเปลี่ยนระหว่าง retry ลงใน prompt (ดูวิธี snapshot ใน Phase C)
   - action ใหม่ต้องแก้ครบ 4 จุด: router, switch ใน `ChatbotService`, `decisionTrace.answer({ mode })` และ `contextPolicy`
   - การเปลี่ยน prompt ต้องมี test ภาษาไทยที่สมจริง (`.claude/rules/rag-ai.md`)
   - การแก้ knowledge ต้องผ่าน admin service ที่เรียก `cache.changed()` (`admin-knowledge-pattern.service.ts`) ห้ามแก้ DB ตรง
   - state ต่อผู้ใช้ห้ามเก็บใน in-memory Map ให้ใช้ Redis
   - **F1:** ห้ามให้ข้อความของ flow สมัครสมาชิกเข้า prompt หรือ state ใหม่
4. **Gate ใน `route-stages.ts` ต้องเป็น pure ต่อไป (ไม่มี I/O)** ให้โหลด state ก่อนเข้า router แล้วส่งเข้ามาเป็นข้อมูล
5. `waiting_admin` **ไม่ใช่การปิดเสียง AI** (`.claude/rules/handoff.md`) คำถามที่มีเนื้อหาต้องตอบตามปกติเสมอ การไม่ตอบ (SILENT) ใช้ได้กับข้อความตอบรับที่ไม่มีเนื้อหาเท่านั้น
6. **ไม่แตะไส้ใน Product RAG** (planner มี history/refs ของตัวเองอยู่แล้ว)
7. ไม่อ้างเลขบรรทัด ให้ grep หาชื่อ class/function แทน

---

## 1. ปัญหาและสาเหตุราก (ตรวจกับโค้ดและ DB บนเครื่องแล้ว)

```
11:38 ลูกค้า: ขอคุยกับพนักงาน      → bot [KNOWLEDGE]: รับทราบค่ะ กำลังติดต่อเจ้าหน้าที่ให้เข้ามาดูแลในแชทนี้ รอสักครู่นะคะ
11:38 ลูกค้า: รอบรถ กรุงเทพ พัทยา  → bot [KNOWLEDGE]: ตารางรอบรถ
17:49 ลูกค้า: ครัค่ะ                → bot [AI]: สวัสดีค่ะ 😊 มีอะไรให้แอดมิน บขส. ช่วย...   ❌
17:49 ลูกค้า: ครับ                  → bot [AI]: ครับ 😊 ถ้าต้องการสอบถามรอบรถ...             ❌ เปลี่ยนเพศ
```

| # | สาเหตุ | หลักฐาน / ที่อยู่ |
|---|---|---|
| **R0** | **Handoff ไม่เคยเกิด** "ขอคุยกับพนักงาน" ไม่ตรงกับ keyword ของ rule (`ติดต่อแอดมิน`, `คุยกับเจ้าหน้าที่`, `แจ้งปัญหา`) จึงไปเจอ AnswerPattern "ติดต่อเจ้าหน้าที่แชท" (`intentKey=contact.admin`, `renderMode=direct`) ซึ่ง **ตอบข้อความว่ากำลังติดต่อเจ้าหน้าที่ โดยที่ระบบไม่ได้ทำ handoff** ผลคือ `requestAdmin` ไม่ถูกเรียก ห้องไม่เป็น `waiting_admin` และ **แอดมินไม่ได้รับแจ้งเตือน** ลูกค้ารอ 6 ชั่วโมงโดยไม่มีใครรู้ | `RuleIntentService.detect`; ข้อความของ pattern ตรงกับแชททุกตัวอักษร; เส้นทาง handoff จริง (`contactAdminResponse`) ตอบอีกข้อความหนึ่งคือ "รับทราบค่ะ เดี๋ยวแอดมินจะเข้ามาดูแลให้นะคะ" และใช้ source `RULE`; ไม่มีกลไกใดที่ทำให้คำตอบจาก KB สั่ง handoff ได้ (ตรวจกับ DB บนเครื่อง ส่วน prod ต้องตรวจซ้ำตาม Phase A ข้อ 5) |
| R1 | ไม่มีด่านสำหรับข้อความตอบรับ: "ครับ"/"ครัค่ะ" ได้ `UNKNOWN` แล้วไปทำ retrieval (embedding) → `LOW_CONFIDENCE` → classifier (สั่งให้ acknowledgement เป็น GENERAL เสมอ) → `answerGeneral` รวม **2 LLM + 1 embedding ต่อคำว่า "ครับ"** | `detect-greet.ts`, `low-confidence-classifier.prompt.ts` |
| R2 | ความจำสั้น: `chat:context` เก็บ 3 เทิร์นภายใน 30 นาที ห่าง 6 ชั่วโมงจึงไม่เหลือ history | `load-context.service.ts` |
| R3 | ไม่รู้ว่า bot ทำอะไรล่าสุด (ถามคำถาม / ตอบข้อมูล / แจ้ง handoff) และไม่รู้ว่าแอดมินเพิ่งคุยไป | `ChatResponse` ไม่มี field นี้ และข้อความแอดมินไม่เข้า context |
| R4 | ข้อความตอบรับเบียด context: คู่ "ครับ"/"สวัสดีค่ะ" เป็น `INCLUDE` | `ChatbotService.aiResponse` |
| R5 | persona ไม่ได้ล็อก LLM จึงเลียนแบบ "ครับ" ของลูกค้า | `GENERAL_RULES` ใน `ai/prompt/ai-chat.constants.ts` |

ถ้า handoff ทำงานถูกตั้งแต่ 11:38 ลูกค้าจะไม่ต้องทวงตั้งแต่แรก **R0 จึงต้องแก้ก่อนทุกอย่าง**

---

## 2. หลักการ

- **ใช้ rule เป็นตัวตีความหลักไม่เวิร์ค** เพราะความหมายของ "ครับ" ขึ้นกับ state (หลังคำถาม = ยืนยัน, หลังคำตอบ = รับทราบ, ระหว่างรอพนักงาน = ทวง) แต่ rule ใช้ได้ดีในงาน **ที่ต้องแม่นยำสูงและแคบ**: ข้อความที่ไม่มีคำที่มีเนื้อหาเลย และต้อง **ถอยเสมอเมื่อไม่แน่ใจ**
- **LLM ตีความ โค้ดตัดสิน** (แนวเดียวกับ Rasa CALM): LLM ออก label แบบมีโครงสร้าง แล้วโค้ดที่ deterministic เป็นคนเลือก action
- **เรียก LLM ตีความเฉพาะเมื่อจำเป็น** (conditional rewrite) ไม่เรียกทุกเทิร์น เพื่อไม่ให้ DIRECT ที่ใช้ 0 LLM เสียไป และไม่ให้ต้นทุนเพิ่มขึ้นในโปรเจกต์ที่คิดเงินและนับ budget ต่อ call (F10) งานที่ค้นมาพบทั้งแบบ rewrite ทุกเทิร์นและแบบเลือก rewrite จึงเป็นการแลกกันระหว่างต้นทุนกับคุณภาพ สำหรับโปรเจกต์นี้แบบเลือก rewrite เหมาะกว่า
- **Action ของระบบต้องมาจากระบบ ไม่ใช่ข้อความใน KB:** ห้ามให้คำตอบจาก KB อ้างว่าทำ action (handoff, สมัคร, ตรวจสลิป) แทนระบบ
- **ใช้ของเดิมให้มากที่สุด:** อัปเกรด classifier ตัวเดิมแทนการสร้าง LLM service ใหม่ ใช้ state เป็น Redis key เล็กๆ 1 ตัวแทน transcript store และนำ status ที่ query มาอยู่แล้วมาใช้

---

## 3. Pipeline เป้าหมาย

```
inbound
 │  adapter.saveIncomingEvent → ConversationThread { conversationId, handoffPending }   ← B: status ที่ได้มาฟรี
 │
 ChatbotService.answerText
 ├─ pre-gates เดิม: mute → session → empty → too long → register-disabled
 ├─ โหลด TurnMeta (Redis 1 key)                                                         ← B
 │
 IntentRouterService.resolve
 ├─ rich menu (เดิม)
 ├─ [D] pending resolver (ask-back §5)
 ├─ gates (pure): greeting → cancel → registerSession → phatic fast path (B) → trustedRule (A: keyword ครบขึ้น)
 ├─ retrieval (เดิม) → decideFromRetrieval
 │     ├─ A: top item intentKey=contact.admin → CONTACT_ADMIN (handoff จริง)
 │     └─ C: ถ้า needsInterpretation และไม่ใช่ exact/DIRECT → ไป classifier แม้ RAG จะมั่นใจ
 └─ LOW / needsInterpretation → classifier ที่อัปเกรดแล้ว (C: state + turnType + responseJsonSchema)
       → standalone → ค้นใหม่ → เลือกผลจาก rewrite ถ้าเป็น FOLLOW_UP/ANSWER_TO_BOT
 │
 ChatbotService switch → answer (A: ล็อก persona) → ChatResponse.assistantAct (B)
 │
 delivery/finalize → TurnMeta.markAssistant(act) (B) · admin delivery → TurnMeta.markAdmin (B)
```

**จำนวน LLM call ต่อเทิร์น (วันนี้ → หลังทำ)**

| กรณี | วันนี้ | หลังทำ |
|---|---|---|
| ข้อความตอบรับล้วน ("ครับ", "ครัค่ะ") | 2 + embedding | **0** (B) |
| ขอคุยกับคน ("ขอคุยกับพนักงาน") | 0 (DIRECT จาก KB แต่ไม่มี handoff จริง) | **0** + handoff จริง (A) |
| DIRECT/exact FAQ ที่มี context | 0 | **0** |
| คำถามยาวที่ยืนได้เอง และ RAG มั่นใจ | 1 | **1** |
| follow-up สั้นที่มี context (เช่น "แล้วราคาล่ะ") | 1 (ค้นด้วยข้อความที่ยืนเองไม่ได้ จึงเสี่ยงได้ผลผิด) | 2 + 1 embedding (C) |
| ข้อความที่ตอบสิ่งที่ bot ถาม | 1–2 | 2 (C) |
| LOW_CONFIDENCE | 2 (+ ค้นรอบสอง) | 2 (เท่าเดิม แต่ classifier เห็น state แล้ว) |

---

## 4. Use cases และว่า Phase ไหนดูแล

| # | ประเภท | ตัวอย่าง (บริบท → ข้อความ) | ควรทำ | Phase |
|---|---|---|---|---|
| U1 | ACK หลังได้คำตอบ | ส่งตารางแล้ว → "ครับ", "โอเคค่ะ", "👍" | template สั้น 1 ครั้ง ถ้าเพิ่งตอบ ack ไปแล้วให้ไม่ตอบ | B |
| U2 | ขอบคุณ/ปิดบท | "ขอบคุณค่ะ", "แค่นี้ก่อนนะคะ" | template ขอบคุณ 1 ครั้ง | B |
| U3 | ทวงระหว่างรอแอดมิน | handoff แล้ว + ห่าง 6 ชม. → "ครับ", "ยังอยู่ไหม", "??" | template "แจ้งเจ้าหน้าที่ไว้แล้ว" ครั้งเดียวต่อ cooldown | A + B |
| U4 | กลับมาหลังห่างนาน ไม่มีเรื่องค้าง | "ครับ" | template รับทราบสั้นๆ (ไม่ทักทาย) | B |
| U5 | ตอบคำถามที่ bot ถาม | bot "เดินทางวันไหนคะ" → "พรุ่งนี้" | ทำ standalone แล้วค้น | C (+D) |
| U6 | ยืนยัน/ปฏิเสธ | bot "ต้องการรอบเช้าใช่ไหมคะ" → "ค่ะ", "ได้", "ไม่ใช่" | fast path ถอย แล้วให้ classifier ตีความ | B ถอย → C |
| U7 | follow-up ที่ละประธาน | "แล้วราคาล่ะ", "รอบเย็นมีไหม" | ทำ standalone แล้วค้น | C |
| U8 | อ้างถึงของเดิม | "รอบนั้นเต็มยัง", "อันแรก" | `resolveRetrievalQuery` เดิม + C | เดิม + C |
| U9 | แก้ข้อมูล | "ไม่ใช่ ไปเชียงใหม่" | ทำ standalone ใหม่ | C |
| U10 | เปลี่ยนเรื่อง | หลังรอบรถ → "จ่ายเงินช่องทางไหน" | ไม่ลากบริบทเดิม (classifier คืนข้อความเดิม และคำถามยาวไม่เข้า C) | เดิม + C |
| U11 | หลายเจตนา | "ขอบคุณค่ะ แล้วจองยังไง" | fast path ต้องไม่จับ ให้ไปเส้นทางปกติ | B (negative test) |
| U12 | ร้องเรียน | "รอนานแล้ว สรุปรอบ 6 โมงเย็นมีไหม" | **ตอบคำถามก่อน + แนบ handoff** ถ้าไม่มีคำถามให้ handoff | C |
| U13 | ขอคุยกับคน | "ขอคุยกับพนักงาน", "คุยกับคนจริงได้ไหม" | `CONTACT_ADMIN` จริง | A |
| U14 | ลูกค้าไม่เข้าใจ bot | "หมายถึงอะไร", "งง" | GENERAL พร้อม history (เดิม) | C |
| U15 | ขอซ้ำ | "ส่งอีกที" | ทำ standalone จากหัวข้อเดิม | C |
| U16 | คุยเล่น | "อากาศเป็นไง" | GENERAL (เดิม) | เดิม |
| U17 | พิมพ์ผิด/สแลง | "ครัค่ะ", "ค่ร่ะ", "คับบ", "kub", "555" | whitelist คำพิมพ์ผิด | B |
| U18 | ข้อความถึงแอดมิน | แอดมินเพิ่งคุย → "ขอบคุณครับพี่" | ถ้าเป็นข้อความตอบรับล้วนให้ไม่ตอบ ถ้ามีเนื้อหาให้ไปเส้นทางปกติ | B |
| U19 | ข้อความแตกหลายฟอง | "รอบรถ" / "กรุงเทพ" / "พัทยา" | รวมก่อนประมวลผล | E (ต้องวัดก่อน) |
| U20 | ยกเลิก | "ยกเลิก" | cancel (เดิม) | เดิม |
| U21 | ไม่ชัดจริง | "อันนั้นอะ" | ถามกลับ ห้ามเดา | D |

---

## 5. Phase A — แก้ handoff ปลอม + ล็อก persona (bug fix, 0 LLM เพิ่ม, เปิดถาวร)

**เป้าหมาย:** แก้ R0 และ R5 ทำให้คำขอคุยกับคนทุกรูปแบบเรียก `requestAdmin` จริง

**ขั้นตอน:**

1. **ขยาย keyword ของ handoff** ใน `RuleIntentService.detect` (กลุ่ม `CONTACT_ADMIN`) ให้แยก list ออกมาเป็นค่าคงที่ `HANDOFF_KEYWORDS`:
   `ติดต่อแอดมิน, คุยกับแอดมิน, ขอคุยกับแอดมิน, ติดต่อเจ้าหน้าที่, คุยกับเจ้าหน้าที่, ขอเจ้าหน้าที่, ติดต่อพนักงาน, คุยกับพนักงาน, ขอพนักงาน, ขอคุยกับคน, คุยกับคนจริง, ขอคนจริง, แจ้งปัญหา`
   - **ห้ามใส่ "แอดมิน" คำเดียว** (เป็น greeting ใน `DETECT_GREET`) และไม่ใส่ "คุยกับคน" เฉยๆ เพราะจะชนกับประโยคอย่าง "คุยกับคนขับ"
2. **ให้ KB intent เป็นตัวสั่ง action ของระบบ:** เพิ่มค่าคงที่ `HANDOFF_INTENT_KEY = 'contact.admin'` ใน `shared/knowledge/knowledge-routing.constants.ts` แล้วแก้ 2 จุด:
   - `decideFromRetrieval` (`route-stages.ts`): หลัง branch ของ product, missing info และ conflict แต่ **ก่อน** branch ที่ RAG มั่นใจ ถ้า `retrieval.route !== 'LOW_CONFIDENCE'` และ `retrieval.selectedItems[0]?.metadata?.intentKey === HANDOFF_INTENT_KEY` ให้คืน `{ action: 'CONTACT_ADMIN', intent: 'CONTACT_ADMIN', source: 'DATABASE', reason: 'knowledge intent contact.admin → system handoff' }` (ไม่ใช่ businessFallback)
   - `IntentRouterService.resolveLowConfidence`: ใน branch BUSINESS ที่มี evidence ถ้า evidence อันดับแรกมี intentKey นี้ ให้คืน `CONTACT_ADMIN` เช่นกัน
   - วิธีนี้ใช้ semantic search ที่มีอยู่จับคำขอที่ถ้อยคำต่างกันได้ และไม่ต้องพึ่ง keyword อย่างเดียว
3. **กันไม่ให้ grounded answer ลอกข้อความ handoff ปลอม:** ใน `AiChatService.answerKnowledge` / `generateFromKnowledge` ให้ตัด item ที่ `metadata.intentKey === HANDOFF_INTENT_KEY` ออกก่อนสร้าง prompt
4. **KB row เดิม:** เก็บไว้เป็น routing anchor ได้ (question examples ช่วยให้ค้นเจอ) แต่ให้ **เจ้าของโปรเจกต์** แก้ข้อความ answer ผ่าน admin UI ให้ไม่อ้างว่ากำลังทำ action (เพราะข้อความนี้จะไม่ถูกแสดงแล้ว) **Sonnet ห้ามแก้ DB ตรง**
5. **Audit KB บน prod** (เจ้าของโปรเจกต์เป็นคนรัน อ่านอย่างเดียว) เพื่อหาแถวอื่นที่อ้างว่าทำ action แทนระบบ:
   ```sql
   select 'AP' src, id, title, "intentKey", left(answer, 100) from "answerPattern"
   where active and (answer ~* '(กำลังติดต่อ|ส่งต่อ|แจ้งเจ้าหน้าที่|ดำเนินการให้|สมัครให้|ตรวจสอบให้|บันทึกให้|ยกเลิกให้)')
   union all
   select 'MK', id, title, null, left(content, 100) from "microKnowledge"
   where active and (content ~* '(กำลังติดต่อ|ส่งต่อ|แจ้งเจ้าหน้าที่|ดำเนินการให้|สมัครให้|ตรวจสอบให้|บันทึกให้|ยกเลิกให้)');
   ```
   (ก่อนรัน ให้ตรวจชื่อคอลัมน์ของ `microKnowledge` ก่อน; ใช้ `content` เป็นตัวอย่าง)
6. **ล็อก persona (R5):**
   - `aiResponseStyleSchema` (`modules/ai/ai-setting/ai-setting-config.ts`) เพิ่ม `politeParticle: z.enum(['ค่ะ', 'ครับ']).default('ค่ะ')` (เป็นคอลัมน์ json จึงไม่ต้อง migrate แต่ต้องตรวจว่า DTO ฝั่ง admin ที่เขียน responseStyle รับ key ใหม่นี้)
   - `composeAiAnswerPrompt` (grep หาชื่อนี้ ใช้ทั้ง general, grounded และ product) เพิ่มกฎ 2 ข้อ: (a) `ใช้คำลงท้าย "ค่ะ/คะ" ทุกข้อความ ห้ามเปลี่ยนตามคำลงท้ายของลูกค้า` (สร้างข้อความจากค่า `politeParticle`) และ (b) `ถ้าข้อความลูกค้าเป็นเพียงคำตอบรับสั้นๆ ห้ามขึ้นต้นด้วยคำทักทาย ให้ตอบรับสั้นๆ 1 ประโยค` (เป็นกันชนสำรอง ส่วนตัวแก้หลักอยู่ที่ Phase B)

**Tests:**
- `rule-intent`: ทุก keyword ใน list ได้ `CONTACT_ADMIN`, "แอดมินคะ" ยังเป็น greeting, "คุยกับคนขับได้ไหม" ต้องไม่เป็น `CONTACT_ADMIN`
- `route-stages`: top item เป็น `contact.admin` (RAG และ DIRECT) ได้ `CONTACT_ADMIN`, ถ้าเป็น LOW ให้ไป classifier
- `answer.service`: item ที่เป็น handoff intent ไม่อยู่ใน prompt ของ grounded
- harness (`modules/chatbot/audit/core-chat.harness.ts`): ส่ง "ขอคุยกับพนักงาน" แล้ว `requestAdmin` ต้องถูกเรียก ห้องเป็น `waiting_admin` และข้อความตอบคือ `contactAdmin()`
- live Thai prompt test: คำตอบ GENERAL/grounded หลายเคสที่ลูกค้าใช้ "ครับ" ต้องลงท้ายด้วย ค่ะ/คะ

**เกณฑ์ผ่าน:** คำขอคุยกับคน ≥ 15 แบบใน eval เข้า handoff จริงทั้งหมด และ persona ไม่เปลี่ยนเพศ

---

## 6. Phase B — Phatic fast path + TurnMeta (0 LLM, หลัง flag)

**เป้าหมาย:** แก้ R1, R3 และ R4 สำหรับข้อความตอบรับล้วน

### B1. ข้อมูลที่เพิ่ม

```ts
// shared/contracts/chat.types.ts
export type AssistantAct =
  | 'ANSWERED'        // ให้ข้อมูลธุรกิจ (DIRECT / RAG / PRODUCT / partial)
  | 'ASKED'           // ระบบถามลูกค้าและรอคำตอบ: CLARIFY, product ที่ขอข้อมูลเพิ่ม, (D) pending clarify
  | 'GREETED'         // ทักทาย / เมนู / rich menu
  | 'ACKED'           // template ตอบรับของ Phase B
  | 'HANDOFF_NOTICE'  // แจ้งว่าเจ้าหน้าที่จะเข้ามา: CONTACT_ADMIN, fallback + requestAdmin, template รอแอดมิน
  | 'FALLBACK'        // ตอบไม่ได้ และไม่ได้ handoff
  | 'GENERAL';        // small talk / คำตอบทั่วไป / cancel

// ChatResponse เพิ่ม: assistantAct?: AssistantAct; askedText?: string  (askedText เมื่อ act=ASKED: redactPii + ≤ 300 ตัวอักษร)
// ConversationThread (shared/contracts/channel-adapter.ts) เพิ่ม: handoffPending?: boolean
// ChatRequest เพิ่ม: handoffPending?: boolean
```

- **ไม่ใช้ heuristic "ข้อความลงท้ายด้วย ไหมคะ"** เพื่อตัดสินว่า bot ถาม เพราะคำตอบภาษาไทยส่วนใหญ่ลงท้ายด้วย "ไหมคะ" act `ASKED` ต้องมาจาก branch ที่ระบบถามจริงเท่านั้น
- product: ให้ grep ว่าผลของ product บอกสถานะ "ขอข้อมูลเพิ่ม" (`MISSING_INPUT`) ไว้ที่ใด (ดู `product-answer.service.ts` และ `retrieval.product`) แล้ว map เป็น `ASKED` ถ้าหาไม่เจอ ให้ map เฉพาะ CLARIFY แล้วบันทึกไว้ใน PR

### B2. TurnMeta store — Redis 1 key ต่อห้อง

```ts
// modules/chatbot/state/turn-meta.store.ts
// key: chat:turnmeta:{conversationId}   HASH   TTL TURN_META_TTL_SEC (86400) ต่ออายุทุกครั้งที่เขียน
type TurnMeta = {
  lastAct?: AssistantAct;
  lastActAt?: number;        // ms, เวลาของ server ตอนส่งสำเร็จ
  askedText?: string;        // เฉพาะเมื่อ lastAct=ASKED
  lastAdminAt?: number;      // ms, เวลาของ server ตอนข้อความแอดมินถูกส่งสำเร็จ
  handoffNoticeAt?: number;  // ms, ครั้งล่าสุดที่ bot ส่งข้อความ act=HANDOFF_NOTICE
};
```

- **เวลาทุกค่าเป็นเวลาของ server** ทั้งตอนเขียนและตอนเทียบใน policy (`Date.now()`) จึงไม่มีปัญหานาฬิกาต่างเครื่อง ส่วน Phase B ไม่มี LLM จึงไม่มีปัญหา billing
- assistant กับ admin เขียนคนละ field จึงไม่ชนกัน ใช้ `HSET` + `EXPIRE` ใน `MULTI` และ "ใครพูดล่าสุด" ให้คำนวณจาก `lastAdminAt > lastActAt`
- ถ้า Redis error ให้ warn แล้วคืน `{}` (degrade กลับไปเป็นพฤติกรรมเดิม)
- ไม่เก็บข้อความของลูกค้า ส่วน `askedText` มาจากข้อความของ bot ซึ่งไม่ใช่ flow สมัคร เพราะ REGISTRATION ไม่ถูก map เป็น act ใดๆ

**จุดเขียน:**

| เหตุการณ์ | ที่ | เขียน |
|---|---|---|
| คำตอบของ bot ส่งสำเร็จ (LINE) | `LineDeliveryService` finalize: `row.context` เป็น `AppendContextTurnParams` ซึ่งมี `response` ครบ (เพิ่ม `assistantAct` ใน `ChatResponse` แล้วจะติดไปใน json เอง) | `markAssistant(act, askedText)` **ทุก contextPolicy** ยกเว้น `source === 'REGISTRATION'` หรือไม่มี act |
| คำตอบของ bot (App) | `channel-store.adapter.ts` จุดเดียวกับที่เรียก `appendTurn` | เหมือนข้างบน |
| คำตอบของ bot (preview) | `admin-userview.service.ts` จุดที่เรียก `appendTurn` | เหมือนข้างบน |
| ข้อความแอดมินส่งสำเร็จ (LINE) | finalize ของแถวที่มี `row.adminMemberId` | `markAdmin()` |
| ข้อความแอดมิน (App) | เส้นทางส่งข้อความแอดมินใน `channel-inbox.service.ts` | `markAdmin()` |
| act = HANDOFF_NOTICE | ภายใน `markAssistant` | ตั้ง `handoffNoticeAt` ด้วย |
| resume-bot | จุดเดียวกับ `LoadContextService.clear` | `clear()` |
| เทิร์นที่ไม่ตอบ (text ว่าง) | – | ไม่เขียน (act เดิมยังอยู่ ซึ่งใช้กันการวนลูปได้) |

### B3. `handoffPending` แบบไม่ต้อง query เพิ่ม

- LINE: `saveIncomingEvent` ใน `line-channel.adapter.ts` upsert `lineConversation` แล้วได้แถวกลับมาพร้อม `status` อยู่แล้ว ให้ใส่ `handoffPending: conversation.status === 'waiting_admin'` ใน thread ที่ return
- App: ใช้แถว conversation ที่โหลดอยู่แล้ว (ดู `app-message.service.ts` ที่ใช้ `conversation.status === 'waiting_admin'`)
- `MessageProcessorService` ส่ง `thread.handoffPending` ต่อไปยัง `ChatRequest` ส่วน preview ให้เป็น `false`

### B4. Phatic detector (pure) — `modules/chatbot/intent/utils/phatic.ts`

```ts
export type PhaticKind = 'PARTICLE_ONLY' | 'ACK' | 'THANKS' | 'CLOSING' | 'PING' | 'LAUGH';
export function detectPhatic(text: string): { kind: PhaticKind } | null;
```

**อัลกอริทึม (ห้ามใช้ edit distance):**
1. normalize: NFC → lowercase → ตัดช่องว่าง ZWJ (`‍`) และ VS (`️`)
2. ถ้ามีตัวเลข ให้คืน `null` (เช่น "ok 2 คน") ยกเว้น pattern หัวเราะ `^5{3,}$`
3. แยก emoji (`\p{Extended_Pictographic}`): ถ้ามี emoji อื่นนอกเหนือจาก 👍 👌 🙏 🙂 😊 ☺ ให้คืน `null` ส่วน emoji ใน set นี้ให้จำไว้แล้วตัดทิ้ง
4. ตัดวรรคตอน (`\p{P}`) แต่จำไว้ว่ามี "?" ถ้าไม่เหลือข้อความเลย: ถ้ามี "?" → `PING`, มี 🙏 → `THANKS`, มี emoji อื่นใน set → `ACK`, ไม่มีอะไร → `null`
5. ย่อตัวอักษรเดียวกันที่ติดกันให้เหลือตัวเดียว (`(.)\1+` → `$1` ทำบนสำเนาเฉพาะสำหรับเทียบ) เช่น "ค่าาาา" → "ค่า", "คับบบ" → "คับ"
6. **blocklist คำแสดงคำถาม:** ถ้ามีคำใดในรายการนี้ หรือมี "?" ร่วมกับตัวอักษร ให้คืน `null`: `ไหม มั้ย ม้าย มั๊ย ปะ ป่ะ ป่าว เปล่า กี่ ไหน อะไร ยังไง อย่างไร เท่าไร เท่าไหร่ หรอ เหรอ เมื่อไร เมื่อไหร่ ทำไม ไง`
7. แบ่งคำแบบ **longest-match** กับ lexicon (เก็บเป็น const array) และ **ทุกตัวอักษรต้องถูกใช้หมด** ข้อยกเว้นเดียวคือ **ส่วนของคำลงท้ายที่ถูกตัดกลางคำแล้วตามด้วยคำลงท้ายเต็ม** ต้องเป็น prefix ตามลำดับ code point ยาว ≥ 2 และไม่ใช้ edit distance เช่น "ครั" + "ค่ะ" ใน "ครัค่ะ" ผ่าน ส่วน "ปะ" ไม่ใช่ prefix ของคำลงท้ายใดและติด blocklist ด้วย ถ้าเหลือตัวอักษรอื่น ให้คืน `null`
8. เลือก kind ตามลำดับ: มีคำขอบคุณ → `THANKS`, คำปิดบท → `CLOSING`, คำทวง → `PING`, หัวเราะ → `LAUGH`, คำตอบรับ → `ACK`, มีแต่คำลงท้าย → `PARTICLE_ONLY`

**Lexicon (เริ่มต้น เพิ่มได้):**
- PARTICLE: `ครับ ครับผม คับ ค้าบ คร้าบ ครัช ขรับ ฮะ ฮับ ค่ะ คะ ค่า ค้า คร่ะ จ้า จ้ะ จ๊ะ นะ นะคะ นะครับ เด้อ เน้อ krub kub ka kha`
- TYPO (คำพิมพ์ผิดที่พบจริง ให้ match ทั้งคำ): `ครัค่ะ ค่ร่ะ คับค่ะ ครับค่ะ คัฟ ครัฟ คาบ`
- ACK: `โอเค โอเช ok okay oke รับทราบ ทราบแล้ว เข้าใจแล้ว อืม อือ อ๋อ อ่อ อ้อ`
- THANKS: `ขอบคุณ ขอบคุณมาก ขอบใจ ขอบพระคุณ thx thanks thankyou ty`
- CLOSING: `บาย บ๊ายบาย แค่นี้ก่อน แค่นี้แหละ`
- PING: `ฮัลโหล hello ยังอยู่ไหม มีใครอยู่ไหม` (คำเหล่านี้มี "ไหม" ให้เช็คว่าตรงกับ PING ทั้งข้อความ **ก่อน** blocklist ข้อ 6)
- **ห้ามใส่:** `ได้ ได้เลย ได้ค่ะ ใช่ ไม่ ไม่ใช่ ไม่เอา เค` เพราะมักเป็นการตอบคำถามหรือข้อเสนอ ต้องให้ classifier ตีความตามบริบท (Phase C)

**Negative test ที่ต้องมี (ต้องคืน `null`):** `ได้ปะ`, `ได้ไหม`, `ได้กี่ที่`, `โอเคไหม`, `ok 2 คน`, `อยู่ไหน`, `ใช่`, `ได้`, `ไม่ใช่`, `ครับ แล้วราคาล่ะ`, `ค่ะ พรุ่งนี้`, `ขอบคุณค่ะ แล้วจองยังไง`, `ขอบคุณค่ะ ส่งที่อยู่ให้แล้ว`, `บายพาส`, `คุยกับคนจริง`, `😡`
**Positive test ที่ต้องมี:** `ครับ`, `ค่ะ`, `ครัค่ะ`, `ค่ร่ะ`, `คับบบ`, `ค่าาาา`, `ครับผม`, `โอเคค่ะ`, `ok ครับ`, `👍`, `🙏`, `ขอบคุณค่ะ`, `ขอบคุณมากครับ`, `555`, `??`, `ยังอยู่ไหมคะ`, `บายค่ะ`, `อ๋อ ค่ะ`

### B5. Policy (pure) — `modules/chatbot/intent/utils/phatic-policy.ts`

```ts
decidePhatic(kind, { meta, handoffPending, now }): SmallTalkDecision | null   // null = ถอยไปเส้นทางปกติ
```

ตัดสินตามลำดับ ข้อแรกที่เข้าเงื่อนไขชนะ:

| ลำดับ | เงื่อนไข | ผลลัพธ์ | act ที่บันทึก |
|---|---|---|---|
| 0 | `meta.lastAct === 'ASKED'` และ `now - lastActAt ≤ RECENT_WINDOW_SEC` (1800) หรือมี pending (Phase D) | **null (ถอย)** เพราะเป็นการตอบคำถามของระบบ | – |
| 1 | `lastAdminAt > (lastActAt ?? 0)` และ `now - lastAdminAt ≤ ADMIN_ACTIVE_WINDOW_SEC` (1800) | **SILENT** (ข้อความนี้ถึงแอดมิน) | – |
| 2 | `meta.lastAct === 'ACKED'` | **SILENT** (กัน "รับทราบค่ะ" ↔ "ครับ" วนลูป) | – |
| 3 | `handoffPending` และ `handoffNoticeAt` อยู่ภายใน `HANDOFF_WAITING_MAX_AGE_SEC` (86400) | kind THANKS/CLOSING → template `THANKS` นอกนั้น: ถ้า `now - handoffNoticeAt ≤ HANDOFF_PING_COOLDOWN_SEC` (900) → **SILENT** ไม่เช่นนั้นใช้ template `HANDOFF_WAITING` | THANKS → ACKED, HANDOFF_WAITING → HANDOFF_NOTICE |
| 4 | อื่นๆ (เพิ่งได้คำตอบ, ห่างนาน, หรือ handoff ที่ค้างนานเกินไป) | THANKS/CLOSING → template `THANKS` นอกนั้น → template `ACK` | ACKED |

- ทุกผลลัพธ์ใช้ `contextPolicy: 'EXCLUDE'` และ `source: 'RULE'` ส่วน SILENT ให้ `text: ''` (ไม่มีแถว delivery ตามพฤติกรรมเดิม และ App ได้ `replies: []`)
- ถ้า `handoffPending` แต่ไม่มี `handoffNoticeAt` (meta หมดอายุ) ให้ถือว่า handoff ค้างนานเกินไป แล้วไปข้อ 4 จะได้ไม่บอกว่า "เจ้าหน้าที่กำลังมา" ทั้งที่ไม่รู้ว่าแจ้งไปนานแค่ไหนแล้ว
- **Template** (เพิ่มใน `ReplyTemplateService` ที่ `shared/templates/answer-template.service.ts` ใช้คำลงท้ายตาม `politeParticle` และ**ไม่ขึ้นต้นด้วยคำทักทาย**):
  - `HANDOFF_WAITING`: "รับทราบค่ะ ตอนนี้แจ้งเจ้าหน้าที่ไว้แล้ว จะรีบเข้ามาตอบในแชทนี้โดยเร็วที่สุดนะคะ"
  - `ACK`: "รับทราบค่ะ หากต้องการสอบถามข้อมูลเพิ่มเติม พิมพ์รายละเอียดมาได้เลยนะคะ"
  - `THANKS`: "ยินดีค่ะ หากมีอะไรให้ช่วยเพิ่มเติม ทักมาได้เลยนะคะ"

**ไล่เคสจริงจาก §1 (หลังทำ A + B):** 11:38 handoff จริงทำให้ `handoffNoticeAt` เป็น 11:38 → รอบรถได้ `lastAct=ANSWERED` → 17:49 "ครัค่ะ" เป็น `PARTICLE_ONLY` ข้อ 0–2 ไม่เข้า ข้อ 3 เข้าเพราะ notice ผ่านมา 6 ชม. (< 24 ชม. และ > 15 นาที) จึงได้ `HANDOFF_WAITING` แล้ว `handoffNoticeAt` เป็น 17:49 → "ครับ" ข้อ 3 อยู่ใน cooldown จึงได้ **SILENT** รวมแล้วใช้ 0 LLM และแอดมินได้รับแจ้งตั้งแต่ 11:38

### B6. การต่อสายใน router และ ChatbotService

1. `chat.types.ts`: เพิ่ม `ChatAction` `'SMALL_TALK_REPLY'` และ `RouteDecision.smallTalk?: { reply: 'ACK' | 'THANKS' | 'HANDOFF_WAITING' | 'SILENT'; kind: PhaticKind }` ถ้าเพิ่ม `ChatIntent` ใหม่ ต้องเพิ่มใน `RULE_MAP` ด้วย (เป็น `Record` ที่ต้องมีครบทุก key)
2. `route-stages.ts`: `GateInput` เพิ่ม `phaticDecision?: RouteDecision | null` ซึ่ง router คำนวณจาก `detectPhatic` + `decidePhatic` ก่อนเรียก gate (ทั้งสองเป็น pure และ meta ถูกส่งเข้ามาแล้ว) จากนั้นเพิ่ม gate `phatic` **หลัง `registerSession` และก่อน `trustedRule`** (ระหว่างสมัคร "ครับ" คือข้อมูลในฟอร์ม ส่วน "สวัสดีครับ" ยังให้ greeting gate จับ) แล้วอัปเดต comment ที่อธิบายลำดับ gate
3. `IntentRouterService.resolve`: รับ `meta`, `handoffPending` และเช็ค flag `PHATIC_FAST_PATH_ENABLED`
4. `ChatbotService.answerText`: โหลด `TurnMeta` (หลังเช็ค mute) แล้วส่งเข้า router เพิ่ม `case 'SMALL_TALK_REPLY'` เรียก `decisionTrace.answer({ mode: 'SMALL_TALK' })` หรือ `'SMALL_TALK_SILENT'` (เพิ่มใน type `DecisionAnswerOutcome`) และกำหนด `assistantAct` **ให้ทุก branch** ผ่าน helper `response(text, source, policy, act)`:
   - ANSWER_KNOWLEDGE ที่สำเร็จ / DIRECT / product → `ANSWERED` (ถ้า product ขอข้อมูลเพิ่ม → `ASKED`)
   - partial + handoff, fallback ที่เรียก `requestAdmin` สำเร็จ, CONTACT_ADMIN → `HANDOFF_NOTICE` (fallback ที่ `ALREADY_WAITING` และ text ว่าง จะไม่มีการส่งจึงไม่เขียน)
   - CLARIFY → `ASKED` + `askedText = CLARIFY_MESSAGE`
   - RICH_MENU_REPLY / default message → `GREETED` · GENERAL_QUESTION / cancel → `GENERAL` · fallback ที่ไม่ handoff → `FALLBACK` · REGISTRATION → ไม่ใส่ act

**Env (มี default ทั้งหมด prod ไม่ต้องตั้งเพิ่ม):** `PHATIC_FAST_PATH_ENABLED` (default **false** ให้เปิดหลังผ่าน staging), `TURN_META_TTL_SEC` (86400), `RECENT_WINDOW_SEC` (1800), `ADMIN_ACTIVE_WINDOW_SEC` (1800), `HANDOFF_PING_COOLDOWN_SEC` (900), `HANDOFF_WAITING_MAX_AGE_SEC` (86400) ให้ validate ค่า boolean แบบเดียวกับ `CommerceFeatureService`

**Tests:**
- `phatic.spec.ts`: positive และ negative ทุกเคสใน B4 (≥ 50 เคส)
- `phatic-policy.spec.ts`: ทุกแถวของ B5 + เคสจริงที่ไล่ไว้ใน B5
- `turn-meta.store.spec.ts`: เขียนแยก field, TTL, Redis error คืน `{}`
- `route-stages.spec.ts`: "ครับ" ระหว่าง REGISTER ได้ `CONTINUE_REGISTER`, "สวัสดีครับ" ยังเข้า greeting, "ค่ะ" หลัง `ASKED` ต้องถอยไป SEARCH
- `ChatbotService`: ทุก branch ได้ `assistantAct` ที่ถูก, SMALL_TALK_REPLY ได้ EXCLUDE, SILENT ได้ `''`
- harness: เล่นบทสนทนาจาก §1 ครบทุกเทิร์น และเช็คว่าใช้ 0 LLM ในสองเทิร์นสุดท้าย

**เกณฑ์ผ่าน:** เคสใน §1 ได้ `HANDOFF_WAITING` แล้วตามด้วย SILENT, U1–U4/U11/U17/U18 ใน eval ผ่าน ≥ 95% และ **ข้อความที่มีเนื้อหาแต่ถูกตอบด้วย SILENT หรือ ACK ต้องเป็น 0 เคส**

**Rollback:** ตั้ง `PHATIC_FAST_PATH_ENABLED=false`

---

## 7. Phase C — Conditional rewrite ด้วย classifier ตัวเดิม (หลัง flag, เปิดแบบ shadow ก่อน)

**เป้าหมาย:** U5–U7, U9, U12, U14, U15 ทำ standalone **เฉพาะเมื่อจำเป็น** โดยใช้ LLM ไม่เกิน 1 call ต่อเทิร์นสำหรับการตีความ และไม่สร้าง service ใหม่

### C1. เงื่อนไขที่ต้องตีความ (`needsInterpretation`, คำนวณใน router เป็น pure)

```
needsInterpretation =
  CONTEXT_REWRITE_MODE !== 'off'
  && recentMessages.length > 0                         // มี chat:context ภายใน 30 นาที
  && ( meta.lastAct === 'ASKED' (ภายใน RECENT_WINDOW_SEC)
       || graphemeCount(input) <= SHORT_FOLLOWUP_MAX_GRAPHEMES )   // default 24
```

- `graphemeCount` เป็น util ใหม่ที่ใช้ `new Intl.Segmenter('th', { granularity: 'grapheme' })` (สร้าง instance ครั้งเดียว) **ห้ามใช้ `.length`** เพราะสระและวรรณยุกต์ไทยเป็น code point แยก
- เงื่อนไขนี้เป็นแค่ด่านกรองต้นทุน ไม่ใช่ตัวตีความ ถ้ากรองพลาด (ข้อความที่ควรตีความแต่ไม่ผ่านด่าน) จะได้พฤติกรรมเหมือนวันนี้ ไม่ได้แย่ลง

### C2. การเปลี่ยนใน router

1. `decideFromRetrieval(retrieval, input, label, { needsInterpretation })`:
   - branch ที่ RAG มั่นใจ (`route !== 'LOW_CONFIDENCE'`): ถ้า `needsInterpretation` และผลลัพธ์ **ไม่ใช่ exact/DIRECT** (ไม่มี item ที่ `metadata.exactMatch === true`) ให้คืน `null` เพื่อส่งต่อให้ classifier ถ้าเป็น exact ให้ตอบเหมือนเดิม (DIRECT ยังใช้ 0 LLM)
   - branch `MISSING_USER_INFORMATION`: ถ้า `needsInterpretation` ให้คืน `null` (ให้ LLM ลอง resolve การอ้างอิงจาก history ก่อนถามกลับ)
   - branch product, conflict และ retrieval error: เหมือนเดิม
   - branch handoff intent (Phase A): ทำงานก่อน branch เหล่านี้เสมอ
2. `resolveLowConfidence` (ใช้ทั้งกรณี LOW เดิมและกรณี `needsInterpretation`): ส่ง state เข้า classifier แล้วตัดสินตาม `turnType` (C3):
   - `PHATIC` → `decidePhatic(PARTICLE_ONLY/ACK...)` ถ้าได้ null ให้ใช้ GENERAL เหมือนเดิม
   - `HANDOFF_REQUEST` → `CONTACT_ADMIN`
   - `COMPLAINT` → ถ้า BUSINESS และมี evidence ให้ใช้ `ANSWER_KNOWLEDGE` พร้อม `forceHandoff: true` (field ใหม่ใน `RouteDecision` ซึ่ง `ChatbotService` จะเรียก `requestAdmin` หลังตอบ เหมือน partial answer และใช้ act `HANDOFF_NOTICE`) ถ้าไม่มี evidence → `CONTACT_ADMIN` (**ตอบคำถามก่อน แล้วค่อยแนบ handoff** ไม่ใช่ทิ้งคำถาม)
   - `FOLLOW_UP` / `ANSWER_TO_BOT` ที่ standalone ต่างจาก input → ค้นใหม่ (`disableProduct`, `forceGrounded`, `recentMessages: []` เหมือนเดิม) แล้ว **เลือกผลของ rewrite ถ้ามี evidence** แม้ evidenceStrength ของข้อความเดิมจะสูงกว่า (ข้อความเดิมยืนเองไม่ได้ ผลที่ได้จึงน่าจะผิด)
   - `QUESTION` / `UNCLEAR` / อื่นๆ → logic เดิม (เลือกผลที่ evidence แข็งกว่า) ส่วน UNCLEAR → CLARIFY ให้รอ Phase D
   - ต้องเรียก classifier **ได้ครั้งเดียวต่อเทิร์น** (ตามโครงเดิม)

### C3. อัปเกรด `AiIntentClassifierService` + prompt

- เพิ่ม `responseJsonSchema` (ตอนนี้ยังไม่ได้ส่ง) และ field `turnType: 'QUESTION' | 'FOLLOW_UP' | 'ANSWER_TO_BOT' | 'PHATIC' | 'HANDOFF_REQUEST' | 'COMPLAINT' | 'UNCLEAR'` ให้เป็น optional และใช้ `.catch(undefined)` (ถ้า field นี้เสีย การจัดประเภทหลักต้องไม่ล้มตาม) ส่วน `classification` BUSINESS/GENERAL ให้คงไว้เหมือนเดิม (decision log ยังอ่าน field นี้)
- `low-confidence-classifier.prompt.ts`:
  - user turn เพิ่ม block state ที่เป็นข้อมูล: `{"assistantLastAct":"ASKED","assistantAsked":"เดินทางวันไหนคะ","waitingForStaff":true}`
  - system instruction เพิ่มนิยามของ `turnType` และกฎ: "A bare particle or ok right after the assistant ASKED is ANSWER_TO_BOT; combine the assistant's question with the answer in standaloneQuery" และ "If you cannot tell what the message refers to, use UNCLEAR. Do not guess a plausible meaning." (ตามข้อค้นพบของ MTRAG-UN)
  - ตัวอย่างแบบคู่เปรียบเทียบใช้ ≥ 2 ธุรกิจ (มีตัวอย่างเสื้อลินินอยู่แล้ว ให้เพิ่มรอบรถ) และครอบคลุม ANSWER_TO_BOT, FOLLOW_UP, CORRECTION, COMPLAINT + คำถาม, PHATIC หลัง ASKED
- **Idempotency:** state ที่ใส่ใน prompt อาจเปลี่ยนระหว่าง retry (เช่นแอดมินส่งข้อความเข้ามา) ให้ snapshot ต่อเทิร์น: `chat:turnstate:{turnId}` ใช้ `SET NX` TTL 3600 เก็บ `{ lastAct, askedText, handoffPending }` ตอนที่ใช้ครั้งแรก แล้ว retry ใช้ค่าที่ snapshot ไว้เสมอ
- **validate `standaloneQuery`:** ห้ามมีตัวเลขที่ไม่อยู่ทั้งใน input และ `recentMessages`/`askedText` (กันการแต่งวันที่หรือราคาเอง) ถ้าไม่ผ่านให้ทิ้งแล้วใช้ input เดิม

### C4. (ทางเลือก) ทำให้คำถามที่ LLM สร้างกลายเป็นข้อมูลที่มีโครงสร้าง

ใน grounded schema (`grounded-response.schema.ts` + `knowledge-instruction.ts`) เพิ่ม `asksCustomer: boolean` ("คำตอบนี้ถามข้อมูลเฉพาะจากลูกค้า เช่น วันที่ จำนวน") ถ้าเป็น true ให้ `ChatbotService` ตั้ง act `ASKED` + `askedText` ไม่ต้องเพิ่ม call (อยู่ใน call เดิม) แต่เป็นการแก้ prompt จึงต้องมี Thai test ให้ทำหลัง C1–C3 ผ่านแล้ว

**Env:** `CONTEXT_REWRITE_MODE` (`off` | `shadow` | `on`, default `off`), `SHORT_FOLLOWUP_MAX_GRAPHEMES` (24)

- **shadow = ไม่เรียก LLM เพิ่ม** แค่บันทึก `decisionTrace.note('rewrite', { wouldInterpret: true, reason: 'ASKED' | 'SHORT', route })` เพื่อวัดว่าจะมีเทิร์นที่ใช้ call เพิ่มกี่ % ส่วนคุณภาพให้วัดด้วย live eval

**Tests:**
- unit: `needsInterpretation` (ASKED, ข้อความสั้น, ไม่มี context, exact/DIRECT ไม่ถูกส่งต่อ), การตัดสินตาม `turnType` ทุกค่า, การเลือกผลของ rewrite, validation ตัวเลข, snapshot ทำให้ request hash เดิมตอน retry
- live Thai eval: กลุ่ม follow-up/confirm/correction ได้คำตอบถูก ≥ 85%, standalone ที่แต่งข้อเท็จจริงเอง = 0 และรายงาน LLM call ต่อเทิร์นแยกตามกลุ่มเทียบกับวันนี้
- regression: classifier test เดิมทั้งหมดต้องผ่าน

**การเปิดใช้:** shadow ≥ 3 วันเพื่อดูสัดส่วนเทิร์นที่จะเรียก call เพิ่ม → เจ้าของโปรเจกต์ตัดสินใจ (§10 ข้อ 3) → ตั้ง `on`

**Rollback:** ตั้ง `CONTEXT_REWRITE_MODE=off`

---

## 8. Phase D–F

**D — รวมกับ ask-back (pending)**
1. ทำ `PendingClarify` ตาม `ask-back-plan.md` §5 (`chat:clarify:{conversationId}`) **ห้ามสร้างที่เก็บ pending ที่สอง**
2. การถามกลับตั้ง act `ASKED` + `askedText` ซึ่งทำให้ Phase B ถอยและ Phase C ตีความโดยอัตโนมัติ
3. resolver แบบ deterministic ของ ask-back ทำก่อน gate ถ้ายัง resolve ไม่ได้ ให้ classifier เห็น pending แล้วโค้ด **ตรวจกับตัวเลือกใน pending เสมอ** ห้ามใช้ข้อความอิสระเป็น query ตรงๆ
4. `turnType=UNCLEAR` → CLARIFY ตามกติกา ask-back (`MAX_ASKS`, ถามทีละเรื่อง)

**E — Burst aggregation (LINE, ทางเลือก ต้องวัดก่อน)**
1. นับข้อความ USER ที่ห่างจากข้อความ USER ก่อนหน้าในห้องเดียวกัน ≤ 3 วินาที ย้อนหลัง 30 วัน (`lineChatHistory`) **ถ้า < 5% ของเทิร์นทั้งหมด ไม่ต้องทำ**
2. ถ้าต้องทำ ให้เขียน design review แยกก่อน (debounce ด้วย Redis `latestEventId` + delayed job, event ที่ถูกรวมให้ปิดเป็น `MERGED`, ใช้ reply token ของ event ล่าสุด) ส่วน App เป็น HTTP แบบ synchronous จึงต้องให้ client รวมข้อความเอง

**F — Monitoring และเอกสาร**
1. SQL บน `decisionLogs`: อัตรา SMALL_TALK / SILENT, จำนวน handoff ที่มาจาก intentKey, คำตอบ GENERAL ที่ขึ้นต้นด้วย "สวัสดี" ทั้งที่มี history, fallback rate ของ follow-up และ LLM call ต่อเทิร์น
2. อัปเดต `CLAUDE.md` §3 (gate ใหม่, intentKey handoff, ตาราง LLM call), §12 (Redis keys `chat:turnmeta:*`, `chat:turnstate:*`), §15 (env ใหม่) และใส่ cross-reference ใน `docs/ask-back-plan.md`

---

## 9. เปลี่ยนอะไรจาก v1 และทำไม

v1 ถูก review (Gemini, 23 พ.ย.) แล้วตรวจกับโค้ดและ DB บนเครื่อง ผลมีดังนี้

| ประเด็น | v1 | v2 |
|---|---|---|
| สาเหตุราก | สมมติว่าห้องเป็น `waiting_admin` (ผิด) | R0: KB ตอบข้อความ handoff ปลอม จึงแก้ด้วย Phase A |
| ตัดสินว่า bot ถาม | heuristic "ลงท้าย ไหมคะ" (ถอยแทบทุกครั้ง) | ใช้เฉพาะ act `ASKED` ที่มีโครงสร้าง (+ C4 ทางเลือก) |
| Phatic detector | ยอมรับเศษ ≤ 2 ตัวอักษรหรือ 1 edit (พลาด "ครัค่ะ" ที่ยาว 3 code point และจับ "ได้ปะ" เป็น ACK) | whitelist + คำพิมพ์ผิด + blocklist คำถาม + prefix ของคำลงท้ายเท่านั้น และตัด "ได้"/"เค" ออก |
| การตีความด้วย LLM | Turn Interpreter ใหม่ ทำงานทุกเทิร์นที่มี context 24 ชม. (ทำให้ DIRECT เสีย และต้นทุนเกือบ 2 เท่า) | อัปเกรด classifier เดิม และเรียกเฉพาะเมื่อ ASKED/ข้อความสั้น/LOW โดย DIRECT ยังใช้ 0 LLM |
| State | transcript store 24 ชม. + อ่าน status จาก DB ทุกเทิร์น + เทียบเวลาข้ามนาฬิกา | TurnMeta 1 key (เวลาของ server ล้วน) + status ที่ได้มาจาก `saveIncomingEvent` อยู่แล้ว |
| ตรวจว่าเป็นข้อความแอดมิน | ดูจาก key ที่ขึ้นต้นด้วย `admin:` | `row.adminMemberId` |
| COMPLAINT | handoff ทันที (ทิ้งคำถามของลูกค้า) | ตอบคำถามก่อน แล้วแนบ handoff |
| ข้อความกรณีห่างนาน | ทักทาย + เมนู | ตอบรับสั้นๆ ไม่ทักทาย |

ส่วนที่ **ตัดออกไปก่อน** และจะกลับมาพิจารณาเฉพาะถ้า eval แสดงว่าจำเป็น: transcript store แยก, การส่งข้อความแอดมินเข้า prompt และ Turn Interpreter ที่มี 19 act

---

## 10. สิ่งที่เจ้าของโปรเจกต์ต้องตัดสินใจ / ทำเอง

1. **แก้ข้อความของ AnswerPattern "ติดต่อเจ้าหน้าที่แชท" ผ่าน admin UI** และรัน audit SQL ใน Phase A ข้อ 5 บน prod
2. ขณะรอแอดมินแล้วลูกค้าทวงซ้ำ: ตอบครั้งเดียวต่อ 15 นาที (**แนะนำ**) หรือตอบทุกครั้ง
3. จะยอมรับ LLM +1 call บน follow-up สั้นที่มี context หรือไม่ (ตัดสินหลังดูผล shadow ของ Phase C)
4. อายุสูงสุดที่ยังถือว่ากำลังรอแอดมิน (แนะนำ 24 ชม.) และคำลงท้ายเริ่มต้น (แนะนำ `ค่ะ`)
5. เมื่อลูกค้าทวงหรือร้องเรียนระหว่างรอ จะแจ้งเตือนแอดมินซ้ำหรือไม่ (แนะนำให้ทำเป็น follow-up หลัง Phase B เพราะตอนนี้ `requestAdmin` แจ้งเฉพาะตอนสถานะเปลี่ยน)

---

## แหล่งอ้างอิง

- Rasa: [Conversation patterns](https://rasa.com/docs/learn/concepts/conversation-patterns/) · [Conversation repair](https://rasa.com/docs/rasa-pro/concepts/conversation-repair) · [Dialogue understanding](https://rasa.com/docs/learn/concepts/dialogue-understanding/) · [Command generator](https://rasa.com/docs/pro/customize/command-generator)
- Anthropic: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (routing workflow)
- Multi-turn RAG: [MTRAG (arXiv 2501.03468)](https://arxiv.org/abs/2501.03468) · [MTRAG-UN (arXiv 2602.23184)](https://arxiv.org/abs/2602.23184)
- Retrieve-or-not: [Adaptive-RAG (arXiv 2403.14403)](https://arxiv.org/abs/2403.14403)
- Query rewriting: [LLM-aided informative query rewriting (arXiv 2310.09716)](https://arxiv.org/pdf/2310.09716) · [H-RAG, SemEval-2026 Task 8 (arXiv 2605.00631)](https://arxiv.org/pdf/2605.00631) · [A Library of LLM Intrinsics for RAG (arXiv 2504.11704)](https://arxiv.org/pdf/2504.11704)
- Burst/debounce: [Chat SDK concurrency](https://chat-sdk.dev/docs/concurrency) · [n8n WhatsApp debounce](https://n8n.io/workflows/19116-debounce-and-buffer-whatsapp-ai-replies-with-redis-and-google-gemini/)
