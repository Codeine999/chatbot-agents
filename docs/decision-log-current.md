# Decision log — บันทึกการตัดสินใจของบอทต่อข้อความ (current)

อัปเดต 5 พฤศจิกายน 2026 · module `src/modules/decision-log/` · ตาราง `decisionLogs` (migration `20261105000000_add_decision_logs`)

## ไว้ทำอะไร

ทุกข้อความลูกค้าที่เข้า chatbot จะได้ **1 แถว** ที่ตอบได้ว่า
- ข้อความนี้ถูก route ไปทางไหน และเพราะอะไร (rule, gate, classifier)
- ค้นเจออะไร คะแนนเท่าไร (3 อันดับแรก + หลักฐานที่ถูกเลือก)
- ตอบด้วยวิธีไหน (DIRECT preset, grounded LLM, general, product template)
- ถ้า fallback เป็นเพราะอะไร และส่งต่อแอดมินหรือไม่
- เรียก LLM กี่ครั้ง ในขั้นไหน ใช้ token เท่าไร และใช้เวลาเท่าไร

แถวผูกกับข้อความด้วย `eventId` ซึ่งเป็น key เดียวกับ `lineDelivery.key` และ `commerceTurns.externalEventId` (LINE ใช้ `webhookEventId`, App ใช้ `app:<messageId>`) และมี `conversationId` สำหรับดูทั้งห้องแชต

## Flow การบันทึก

```
MessageProcessorService.process
  └─ DecisionTraceService.run(meta)            ← เริ่ม trace (AsyncLocalStorage) ต่อ 1 turn
       ChatbotService        inbound · route · handoff · early exits (muted/empty/too long/no credit)
       IntentRouterService   rule · gate · classifier (BUSINESS/GENERAL + confidence + reason)
       KnowledgeRetrieval    retrieval (route/matchType/fallbackReason/selected, query rewrite)
       ProductRetrieval      product (plan mode/operation/asks/options/filters, search status)
       AiChatService         answer (DIRECT_PRESET/GROUNDED/GENERAL/IMAGE/FALLBACK + reason + askedAbout)
       ProductAnswerService  answer (PRODUCT_LLM_TEMPLATE/PRODUCT_SAFE_TEMPLATE/… + reason)
       UsersAiProviderService llm (provider/model/tokens/latency/status, ติดป้ายว่าเรียกระหว่างขั้นไหน)
  └─ finally: DecisionLogService.save()        ← upsert 1 แถว แม้ delivery ล้ม (status=ERROR)
```

- ทุก service รับ `DecisionTraceService` แบบ `@Optional()` นอก turn (admin chat, เทสต์, worker อื่น) การบันทึกเป็น no-op
- การบันทึกไม่ทำ I/O ระหว่าง turn เขียน DB ครั้งเดียวตอนจบ ถ้าเขียนไม่สำเร็จจะ log warn แล้วกลืน error ไม่กระทบคำตอบที่ส่งลูกค้า
- event ที่ถูก retry จะ upsert ทับแถวเดิม (`attempt` +1) ไม่เพิ่มแถวใหม่
- turn ที่ไม่มี `turnId` และคำตอบสำเร็จรูปจาก adapter (`kind: 'response'`) ไม่ถูกบันทึก

## คอลัมน์หลัก

| กลุ่ม | คอลัมน์ |
|---|---|
| ผูกข้อความ | `channel` (enum `MessageChannel`: LINE, FACEBOOK, INSTAGRAM, APPLICATION, TIKTOK, SHOPEE, TELEGRAM, ANOTHER; ตอนนี้มี adapter แค่ LINE กับ APPLICATION), `eventId` (unique ต่อ company), `userId` (id ผู้ใช้ของ channel นั้นตามที่ chatbot ได้รับ: LINE = LINE userId, APPLICATION = `app:<contactId>` ตัวเดียวกับ key ของ session/mute/ban ใน Redis), `conversationId` (ของ channel นั้น: LINE = `lineConversation`, APPLICATION = `channelConversations`), `commerceTurnId`, `messageType` (`text`/`image`/`sticker` ตามที่ chatbot รับ; การกด rich menu เข้ามาเป็น `text`) |
| คำถาม | `inputText` (redact PII + ตัด 1000 ตัวอักษร, **null ระหว่างกรอกฟอร์มสมัคร**), `retrievalQuery` (query ที่ค้นจริงหลัง rewrite) |
| route | `action`, `intent`, `routeSource`, `routeConfidence`, `routeReason` |
| ประเภทคำตอบ | `answerType`, `answerMode` |
| retrieval | `retrievalRoute`, `matchType`, `retrievalFallbackReason`, `topScore` (RRF ใช้เรียงอันดับเท่านั้น **null เมื่อ route เป็น `DIRECT` หรือเป็น product** เพราะคนละมาตรา), `topVectorSimilarity` (cosine สูงสุด = ค่าที่ใช้ gate), `topLexicalScore` (BM25 ดิบสูงสุดของทุก candidate รวม exact match), `scoreGap`, `candidateCount`, `candidates` (JSON; `fusedScore` เป็น null สำหรับ exact match และแถวสินค้า) |
| ผลลัพธ์ | `isFallback`, `fallbackReason`, `handoffRequested`, `responseSource`, `contextPolicy`, `responseText` (redact + ตัด 2000, **null ในทุก turn สมัครสมาชิก** เพราะคำตอบมีชื่อผู้ใช้/รหัสผ่านที่เพิ่งสร้าง) |
| ต้นทุนและเวลา | `llmCallCount` (ทุกครั้งที่เรียก provider ผ่าน `UsersAiProviderService` รวมครั้งที่ล้ม ไม่รวม embedding), `llmInputTokens` (ค่าที่ provider รายงานจริง รวม cached และ cache write), `llmOutputTokens`, `latencyMs` (จากเริ่ม turn ถึงตอนบอตสร้างคำตอบเสร็จ ไม่รวมเวลาบันทึกและส่งเข้า LINE), `status` (`COMPLETED`/`ERROR` ตามว่า turn โยน error หรือไม่ ไม่ใช่คุณภาพคำตอบ), `errorCode` (ชื่อ class ของ error เมื่อ `ERROR`), `attempt` |
| ลำดับขั้น | `trace` (JSON array `{stage, atMs, data}` ตามลำดับเวลา สูงสุด 60 notes) |

ไม่เก็บ `costThb` เก็บแค่ token ส่วนต้นทุนจริงอยู่ที่ `aiUsageEvents`

### `answerType`

| ค่า | เกิดเมื่อ |
|---|---|
| `KNOWLEDGE` / `MICRO_KNOWLEDGE` / `MIXED_KNOWLEDGE` | `ANSWER_KNOWLEDGE` ตามแหล่งหลักฐานที่คำตอบ cite (ถ้าไม่มี ใช้หลักฐานที่ถูกเลือก) |
| `PRODUCT` | product plan mode `PRODUCT` หรือ `BOTH` |
| `GENERAL` | `GENERAL_QUESTION`, `CONTINUE_AI_CHAT` หรือ product plan `GENERAL` |
| `IMAGE` | ข้อความรูปภาพ |
| `MENU`, `REGISTRATION`, `HANDOFF`, `RULE`, `SYSTEM` | rich menu, ฟอร์มสมัคร, `CONTACT_ADMIN`/`FALLBACK`, rule template อื่น, ไม่ผ่าน router (muted, empty, too long, no credit) |

### `fallbackReason` ที่พบได้

- **ขั้นค้น (retrieval):** `NO_USABLE_EVIDENCE`, `BELOW_MIN_VECTOR_SIMILARITY`, `CONFLICTING_CANDIDATES`, `RETRIEVAL_ERROR`, `MISSING_USER_INFORMATION`, `NO_SEARCH_RESULTS`
- **ขั้น grounded LLM:** `INSUFFICIENT_CONTEXT`, `NOT_DIRECTLY_ANSWERED`, `INVALID_EVIDENCE_REFERENCE`, `INVALID_GROUNDED_OUTPUT`
- **general และรูปภาพ:** `EMPTY_GENERAL_ANSWER`, `IMAGE_BLOCKED_<classification>`, `IMAGE_INVALID_OUTPUT`
- **product:** `PRODUCT_PLAN_FAILED`, `NO_POLICY_EVIDENCE`, `PRODUCT_UNAVAILABLE`, `PRODUCT_INSUFFICIENT_CONTEXT`, `PRODUCT_TEMPLATE_REJECTED`, `PRODUCT_LLM_UNAVAILABLE`
- **ระบบ:** `AI_BUDGET_EXHAUSTED`, `PROVIDER_ERROR`, `CLASSIFIER_FAILED` (classifier ล้มหรืองบ AI หมดที่ขั้น classifier; ขั้นนี้จบด้วย handoff เสมอ และ `retrievalFallbackReason` ยังเก็บเหตุผลฝั่งค้นไว้แยก)
- `UNREPORTED`: มี fallback แต่ไม่มีขั้นไหนรายงานเหตุผล ถ้าเจอให้เพิ่มการรายงานที่ branch นั้น

ถ้าหลายขั้นรายงานเหตุผล ลำดับความสำคัญคือ answer, `CLASSIFIER_FAILED`, route, retrieval ส่วน `retrievalFallbackReason` เก็บค่าของ retrieval แยกไว้เสมอ

### `answerMode` ที่พบได้

`DIRECT_PRESET`, `GROUNDED`, `GENERAL`, `IMAGE`, `FALLBACK`, `TEMPLATE` (คำตอบสำเร็จรูปของ rule/เมนู/สติกเกอร์ที่ไม่มีขั้นไหนรายงาน), `ADMIN_MUTED`, `EMPTY_INPUT`, `MESSAGE_TOO_LONG`, `NO_CREDIT` และของสินค้า: `PRODUCT_LLM_TEMPLATE`, `PRODUCT_SAFE_TEMPLATE` (template ของ LLM ถูกปฏิเสธ ใช้รายการจาก DB แทน), `PRODUCT_<status>` เมื่อค้นไม่สำเร็จ (`NO_MATCH`, `MISSING_INPUT`, `NO_RELIABLE_CANDIDATE`, `VARIANT_UNAVAILABLE` ซึ่งไม่นับเป็น fallback แต่ลูกค้าไม่ได้คำตอบเรื่องสินค้า ใช้นับคำถามสินค้าที่ตอบไม่ได้), `PRODUCT_UNMATCHED_SUGGESTIONS`, `PRODUCT_REPLAY`

## Admin API (`dev`, `owner` เท่านั้น)

| Endpoint | ใช้ทำอะไร |
|---|---|
| `GET /api/admin/decision-logs` | list ใหม่สุดก่อน filter: `from`, `to`, `conversationId`, `userId`, `eventId`, `action`, `answerType`, `isFallback`, `fallbackReason`, `limit`≤100, `cursor` (ใช้ `nextCursor` ของหน้าก่อน) |
| `GET /api/admin/decision-logs/summary` | จำนวนต่อ answerType และ fallback, เหตุผล fallback, action, token และ latency, **histogram ของ `topVectorSimilarity`** (`bucket` default 0.05) แยก total กับ fallback ไว้ใช้เลือก threshold |
| `GET /api/admin/decision-logs/:id` | 1 turn เต็ม: candidates และ trace |

`summary` ถ้าไม่ระบุ `from` จะใช้ 7 วันล่าสุด เพื่อไม่ให้ scan ทั้งตาราง ส่วน list ไม่มีช่วงเวลาเริ่มต้น (ค้นด้วย `eventId`/`userId`/`conversationId` ได้ทุกแถวที่ยังอยู่ใน retention) ลูกค้าและแอดมินอ่านข้อความผ่านฟิลด์ข้อความได้ ฝั่ง UI ต้อง escape ก่อนแสดง

## Config

| Env | Default | ความหมาย |
|---|---|---|
| `DECISION_LOG_ENABLED` | `true` | `false` = ไม่เขียนแถว (trace ยังรันแต่ไม่บันทึก) |
| `DECISION_LOG_RETENTION_DAYS` | `90` | ลบแถวที่เก่ากว่านี้ทุก 6 ชั่วโมง |

## ใช้จูน RAG อย่างไร (ตัวอย่าง query)

```sql
-- คำถามที่ fallback เพราะ LLM บอกว่าหลักฐานไม่พอ: ดูว่าค้นเจออะไรและคะแนนเท่าไร
SELECT "createdAt", "inputText", "topVectorSimilarity", candidates, trace
FROM "decisionLogs"
WHERE "fallbackReason" = 'INSUFFICIENT_CONTEXT' ORDER BY "createdAt" DESC LIMIT 50;

-- สัดส่วนที่ classifier ถูกเรียก (LOW_CONFIDENCE) ต่อช่วงคะแนน ใช้ปรับ KNOWLEDGE_RAG_MIN_VECTOR_SIMILARITY
SELECT width_bucket("topVectorSimilarity", 0.5, 1.0, 10) AS b, count(*),
  count(*) FILTER (WHERE "retrievalRoute" = 'LOW_CONFIDENCE') AS low,
  count(*) FILTER (WHERE "isFallback") AS fallback
FROM "decisionLogs" WHERE "topVectorSimilarity" IS NOT NULL GROUP BY 1 ORDER BY 1;
```

ขั้นตอนแนะนำ: ส่งออกแถวที่ fallback หรือ `LOW_CONFIDENCE` มาให้คนติดป้ายว่า "ควรตอบได้หรือไม่ / ควรใช้ pattern ไหน" แล้วนำไปคำนวณ precision/recall ต่อ threshold

## ความถูกต้องของข้อมูล และข้อจำกัดที่ทราบ

- **ไม่ได้อ่านจาก Redis:** trace อยู่ในหน่วยความจำของ process ที่ประมวลผล turn นั้น (AsyncLocalStorage) เขียน DB ครั้งเดียวตอนจบ ถ้า process ตายก่อนถึง `finally` แถวนั้นหายไป
- **token มาจากค่าที่ provider รายงานจริง** ผ่าน `normalizeTokenUsage` ของแต่ละ adapter และ billing จะปฏิเสธ response ที่ไม่มี usage ระบบไม่ประมาณเอง ตรวจแล้วว่าผลรวมใน log เท่ากับ `aiUsageEvents` ของ conversation เดียวกัน **log ไม่เก็บราคา/ต้นทุน** (ราคาอยู่ใน `aiModelPricing` ที่ admin ตั้ง ใช้คิด `aiUsageEvents`)
- **`llmCallCount` ไม่รวม embedding** และนับ call ที่ล้มด้วย (token = 0) ส่วนผลที่ billing replay (retry ของ event เดิม) ยังถูกนับใน attempt ใหม่ แต่ billing คิดเงินครั้งเดียว
- **event ที่ถูกประมวลผลซ้ำ:** แถวถูกเขียนทับด้วยผลรอบล่าสุด (`attempt` +1) trace ของรอบก่อนหายไป และ ERROR ที่มาทีหลังจะไม่ทับแถว COMPLETED
- **`status=ERROR` อาจค้าง:** ถ้าส่งเข้า LINE ล้มหลังบันทึกคำตอบแล้ว รอบ retry จะส่งซ้ำอย่างเดียว (ไม่ผ่าน trace) แถวจึงยังเป็น ERROR แม้ลูกค้าได้ข้อความแล้ว ใช้ `lineDelivery.status` เป็นตัวตัดสินการส่ง
- **`routeConfidence` = 0** คือ "ไม่ได้ให้คะแนน" (route ที่ตัดสินจากผลค้น) ไม่ใช่ความมั่นใจศูนย์ อย่าเอาไปหาค่าเฉลี่ยรวมกับ rule/classifier
- **`createdAt` คือเวลาที่เขียน log** (หลังส่งข้อความ) ไม่ใช่เวลาที่ลูกค้าส่ง
- **เขียน DB หลังส่งเข้า LINE และ await อยู่ใน worker:** ถ้า DB ช้า worker ถูกถือนานขึ้น แต่ลูกค้าได้ข้อความแล้ว save ที่ล้มเหลวถูกกลืนพร้อม log warn
- **ขนาดแถว:** เฉลี่ยราว 1.7–2.5 KB (ถามความรู้ ~2 KB, สินค้า ~1.7 KB, ข้อความ rule สั้น ~0.3 KB) ที่ 10,000 ข้อความต่อวันและ retention 90 วัน ≈ 1.8 GB ก่อนรวม index

## ข้อจำกัด

- `topVectorSimilarity` คือค่าสูงสุดของ candidate ทั้งหมด ตรงกับที่ gate ปัจจุบันใช้ ไม่จำเป็นต้องเป็นค่าของหลักฐานที่ถูกเลือก (ดูคะแนนรายตัวใน `candidates`)
- รายละเอียด planner และ LLM ของ product (raw template, slot) อยู่ใน `commerceTurns` และ `commerceLlmCalls` ผ่าน `commerceTurnId` ไม่ได้ซ้ำไว้ที่นี่
- การ purge ลบทุก company ตาม retention เดียวกัน
