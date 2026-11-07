# Intent classifier และ routing: ระบบภายนอกทำอย่างไร และควรเอาอะไรมาใช้

วันที่ 2026-11-04 · ค้นคว้าจากเอกสารทางการและงานวิจัย (ลิงก์อยู่ท้ายแต่ละหัวข้อ) แล้วเทียบกับโค้ดใน branch `multi/app`
ข้อที่ยังยืนยันไม่ได้มีป้าย **(ยังไม่ยืนยัน)** · ผลตรวจ prompt ภายในอยู่ที่ [audit-prompt.md](audit-prompt.md)

---

## 1. สรุปสั้น

1. **ทุก platform แยก "หาคำตอบไม่เจอ" ออกจาก "ส่งต่อคน"** การส่งต่อคนจะเกิดเมื่อลูกค้าขอเอง, เจอคำอันตราย หรือหาคำตอบไม่เจอ 2–3 ครั้งติดกัน
   ระบบเรายังเอา "BUSINESS แต่ตอบไม่ได้" ไปส่งต่อแอดมินทันที
2. **คำถามถึงตัวบอท ("คุณคือใคร", "ทำอะไรได้บ้าง") ตอบจาก persona หรือ chit-chat set เสมอ** ไม่มี platform ไหนเอาไปค้นจากเอกสารธุรกิจ
   Azure ยกคำถามเหล่านี้เป็นตัวอย่างแรกที่ควรเขียนคำตอบเองด้วยซ้ำ
3. **ใช้ classifier หลายชั้น (cascade)** เรียงจาก rule ไป embedding/kNN แล้วค่อยถึง LLM ชั้นที่ถูกกว่าตัดสินกรณีที่ชัดไปก่อน LLM จัดการเฉพาะกรณีที่เหลือ
4. **class ที่เป็น "ทุกอย่างที่เหลือ" (catch-all) พังเป็นอย่างแรก** ใน cookbook ของ Anthropic class "General Inquiries" ได้ recall **0.00** เมื่อใช้ prompt แบบง่าย
   ซึ่งตรงกับอาการของเรา (GENERAL ถูกนิยามแบบกว้างๆ)
5. **ห้ามใช้ confidence ที่ LLM บอกเองเป็นเกณฑ์** ถ้าจะใช้ threshold ต้อง calibrate กับชุด eval ของเราเอง

---

## 2. Managed NLU services

| Platform | วิธีจัดกลุ่ม | ไม่ match ทำอย่างไร | chit-chat / identity | ส่งต่อคนเมื่อไหร่ |
|---|---|---|---|---|
| **Dialogflow CX** | intent + classification threshold ต่อ flow (default 0.3) และมี Default Negative Intent ไว้เก็บตัวอย่างที่ไม่ใช่ | event `no-match` → generative fallback (ถ้า generate ไม่ได้ก็กลับไปใช้ข้อความ scripted) ถ้า data store ได้ `NOT_ENOUGH_INFORMATION` จะนับเป็น no-match ไม่ใช่ handoff | Small Talk / prebuilt agent (สมัย ES) และ Default Welcome Intent | กำหนดเองใน flow |
| **Amazon Lex V2** | `nluIntentConfidenceThreshold` คะแนนเป็นค่าเทียบกันเอง (comparative) ไม่ใช่ค่าสัมบูรณ์ ได้ intent อันดับ 1 + ตัวเลือกอีก 4 | ทุก intent ต่ำกว่า threshold → `AMAZON.FallbackIntent` ส่วน `QnAIntent` (Bedrock KB) ทำงานเฉพาะเมื่อไม่มี intent อื่น match | ทำเป็น intent ปกติ | กำหนดเอง และมี assisted NLU ช่วย disambiguation |
| **Azure AI Language** | Orchestration workflow → CLU หรือ Custom Question Answering ต้องมี None intent (threshold 0.5) | CQA คะแนน 0–100 แนะนำ threshold 50 ถ้าคะแนนของหลายคำตอบใกล้กันแปลว่าคำถามกว้างเกินไป | **chit-chat personality dataset** อยู่ใน KB เดียวกัน และแนะนำให้เขียนคำตอบ "Who are you? What can you do?" เองสำหรับบอทของเรา | กำหนดเอง |
| **IBM watsonx Assistant** | actions + irrelevance detection ที่ใช้ counterexample | action "No matches" รับ 3 ครั้งแรกก่อน จากนั้นจึงไปที่ Fallback | แนะนำให้บอกว่าบอททำอะไรได้/ไม่ได้ในข้อความ "No matches" | Fallback 5 เหตุผล: validation fail, ลูกค้าขอเอง, no match ซ้ำ, danger word, profanity |
| **Copilot Studio** | topics + generative orchestration | conversational boosting (generative answers) ก่อน ถ้าไม่ได้จึงไป Fallback (ขอให้พูดใหม่ 2 ครั้ง) แล้วค่อย Escalate | Conversation Start แนะนำตัวและบอกความสามารถ | หลังลองใหม่ 2 ครั้ง หรือเมื่อลูกค้าขอ ส่วน "Multiple Topics Matched" = ถามกลับว่า "หมายถึง…ใช่ไหม" |

**เอามาใช้กับเรา:** แยก no-match ออกจาก handoff, ตอบคำถามถึงตัวบอทจาก persona หรือ KB entry ที่เขียนคำตอบไว้แล้ว (match ด้วยความมั่นใจสูง จึงไม่ถึงเส้นทาง fallback) และเก็บตัวอย่างที่ไม่ใช่ (negative example) ไว้ใช้คู่กัน

แหล่งอ้างอิง: [CX NluSettings](https://docs.cloud.google.com/dialogflow/cx/docs/reference/rest/v3/NluSettings) ·
[CX intents](https://docs.cloud.google.com/dialogflow/cx/docs/concept/intent) ·
[CX generative fallback](https://docs.cloud.google.com/dialogflow/cx/docs/concept/generative/generative-fallback) ·
[CX data store settings](https://docs.cloud.google.com/dialogflow/cx/docs/concept/data-store/settings) ·
[ES small talk](https://docs.cloud.google.com/dialogflow/docs/agents-small-talk) ·
[Lex confidence scores](https://docs.aws.amazon.com/lexv2/latest/dg/using-intent-confidence-scores.html) ·
[Lex QnAIntent](https://docs.aws.amazon.com/lexv2/latest/dg/built-in-intent-qna.html) ·
[Azure None intent](https://learn.microsoft.com/en-us/azure/ai-services/language-service/orchestration-workflow/concepts/none-intent) ·
[Azure CQA confidence](https://learn.microsoft.com/en-us/azure/ai-services/language-service/question-answering/concepts/confidence-score) ·
[Azure CQA best practices](https://learn.microsoft.com/en-us/azure/ai-services/language-service/question-answering/concepts/best-practices) ·
[watsonx errors](https://cloud.ibm.com/docs/watson-assistant?topic=watson-assistant-handle-errors) ·
[watsonx irrelevance](https://cloud.ibm.com/docs/watson-assistant?topic=watson-assistant-irrelevance-detection) ·
[Copilot system topics](https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-system-topics)

---

## 3. Open-source

| Tool | วิธีการ | ตัวเลขหรือค่า default | เอามาใช้กับเรา |
|---|---|---|---|
| **Rasa NLU** | DIET classifier + `FallbackClassifier` | `threshold` 0.3 (ในโค้ด), docs ใช้ 0.7, `ambiguity_threshold` 0.1 (ถ้าอันดับ 1 กับ 2 ห่างกันไม่ถึงจะ fallback) | two-stage fallback: ยืนยัน intent → ขอให้พูดใหม่ → ส่งต่อคน, มี `out_of_scope` ที่ train จากแชทจริง, chit-chat เป็น retrieval intent (`chitchat/ask_name`), `bot_challenge → utter_iamabot` **(ยังไม่ยืนยัน: เห็นจาก community เท่านั้น)** |
| **Rasa CALM** | LLM สร้าง command: start flow, set slot, cancel, clarify, **chitchat**, **knowledge answer**, **human handoff** | `pattern_cannot_handle` (เหตุผล `no_relevant_answer`), `pattern_clarification` เสนอตัวเลือกได้ไม่เกิน 3 | **หาคำตอบใน KB ไม่เจอไม่ได้แปลว่าต้อง handoff** และ handoff เป็น output แยกต่างหาก |
| **semantic-router** | route = ตัวอย่างประโยค + embedding similarity | v0 threshold 0.5 ต่อ route แล้วให้ `fit()` ปรับ (chitchat ได้ 0.32), v1 ใช้ calibration กับ held-out set, `Chain` ใช้ router เร็วก่อนแล้วจึงใช้ตัวช้า | kNN router ที่ทำบน pgvector + gemini-embedding ที่มีอยู่แล้วได้ ต้นทุนแทบเป็นศูนย์ |
| **NeMo Guardrails** | ค้น vector ตัวอย่าง 5 อันดับแรก แล้วให้ LLM ตั้งชื่อ intent หรือใช้ embedding อย่างเดียว + threshold + fallback intent | – | ใช้ตัวอย่างที่ค้นได้เป็น few-shot ให้ LLM |
| **LlamaIndex / LangGraph** | LLM หรือ Pydantic selector / structured-output classifier → conditional edge | – | label ต้องเป็น enum ที่ระบบบังคับ **(LangGraph ยังไม่ยืนยัน: เห็นจาก tutorial)** |
| **SetFit / classifier ขนาดเล็ก** | fine-tune few-shot บน sentence embedding | ใช้ 8 ตัวอย่างต่อ class ได้ผลใกล้กับ RoBERTa-Large ที่ train ด้วย 3k ตัวอย่าง | LLM แบบ zero-shot ตรวจจับ out-of-scope ได้ดี แต่ยังแพ้ model ที่ fine-tune มา การใช้ classifier ขนาดเล็กคู่กับ LLM จึงคุ้มค่าที่สุด |

แหล่งอ้างอิง: [Rasa constants](https://github.com/RasaHQ/rasa/blob/main/rasa/core/constants.py) ·
[Rasa fallback/handoff](https://legacy-docs-oss.rasa.com/docs/rasa/fallback-handoff) ·
[Rasa chitchat](https://legacy-docs-oss.rasa.com/docs/rasa/chitchat-faqs) ·
[Rasa CALM](https://rasa.com/docs/rasa-pro/concepts/dialogue-understanding) ·
[Rasa patterns](https://www.rasa.com/docs/reference/primitives/patterns) ·
[semantic-router thresholds](https://docs.aurelio.ai/docs/semantic-router/v0/user-guide/features/threshold-optimization) ·
[calibration](https://docs.aurelio.ai/docs/semantic-router/v1/user-guide/features/calibration) ·
[NeMo Colang](https://docs.nvidia.com/nemo/guardrails/v0.22.0/reference/colang-architecture-guide.md) ·
[LlamaIndex router](https://developers.llamaindex.ai/python/framework/module_guides/querying/router/) ·
[SetFit](https://huggingface.co/blog/setfit) ·
[LLM OOS detection](https://arxiv.org/abs/2402.17256) ·
[small+LLM hybrid](https://aclanthology.org/2025.findings-emnlp.791/)

---

## 4. LLM-as-classifier: หลักที่มีตัวเลขรองรับ

| หลัก | หลักฐาน | ระบบเรา |
|---|---|---|
| กำหนดบทบาท, ระบุ label ให้ชัด, มีกฎ edge case และตัวอย่าง | Anthropic ticket routing: เป้าหมายคือ consistency ≥95% และ edge case ≥80% | ✅ (prompt ใหม่) |
| few-shot ที่ค้นมาจากตัวอย่างที่ใกล้ที่สุดได้ผลกว่าตัวอย่างตายตัว | cookbook: accuracy 0.70 → **0.94** (k=5 retrieved) → 0.97 (+CoT); ticket routing 71% → 93% | ❌ ตัวอย่างยังเป็นแบบตายตัว 10 ข้อ |
| class catch-all พังก่อน ต้องนิยามด้วยเงื่อนไข | cookbook: General Inquiries ได้ recall 0.00 | ✅ ตอนนี้ GENERAL มีรายการ Always แล้ว |
| กฎ "ถ้าไม่แน่ใจให้เลือก X" จะเลื่อนเส้นแบ่งทั้งหมด ไม่ใช่แค่กรณีก้ำกึ่ง | Anthropic: "If in doubt" ทำให้ overtrigger | ⚠️ ยังมีกฎนี้อยู่ แต่ให้ Always GENERAL ชนะ |
| ให้เหตุผลก่อน label (provider รักษาลำดับ key ของ schema) | OpenAI structured outputs, Gemini `propertyOrdering`, ตัวอย่างของ Anthropic | ⚠️ `reason` อยู่หลัง label |
| ใช้ enum / structured output ที่ provider บังคับ | OpenAI strict json_schema, Gemini enum | ❌ classifier ยังใช้ JSON + zod อย่างเดียว ถ้า parse fail จะ handoff |
| ไม่ใช้ verbalized confidence | Xiong et al. 2023: ค่าที่บอกมักอยู่ 80–100% และเป็นเลขลงท้าย 5 · OpenAI: logprob ≠ ความถูกต้อง | ✅ ไม่ได้ใช้ |
| ตัวอย่างต้องสมดุลและสลับลำดับ | Zhao et al. 2021: majority / recency bias | ✅ สลับเป็นคู่ 5/5 |
| ใช้ temperature ตามที่ provider แนะนำ | Gemini 3 แนะนำให้ใช้ default (1.0) และ 3.6+ ไม่สนค่านี้ ส่วน reasoning model บางตัว reject | ⚠️ ใช้ 0.1 และ model ใน DB dev คือ `openai/gpt-6-luna` ผ่าน OpenRouter **(ยังไม่ยืนยันว่าค่านี้มีผลไหม)** |
| แก้ prompt ทุกครั้งถือว่าเสี่ยง regression ต้องรัน eval | งานหนึ่งพบว่ากฎทั่วไปทำให้ compliance ของ RAG ตกจาก 26/30 เหลือ 9/30 | ⚠️ live eval มีอยู่แต่เป็นของ KB โรงแรม |

แหล่งอ้างอิง: [Anthropic ticket routing](https://platform.claude.com/docs/en/about-claude/use-case-guides/ticket-routing) ·
[Anthropic classification cookbook](https://platform.claude.com/cookbook/capabilities-classification-guide) ·
[OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) ·
[OpenAI logprobs](https://developers.openai.com/cookbook/examples/using_logprobs) ·
[Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output) ·
[Gemini 3 guide](https://ai.google.dev/gemini-api/docs/gemini-3) ·
[Xiong et al.](https://arxiv.org/abs/2306.13063) ·
[Zhao et al.](https://arxiv.org/abs/2102.09690) ·
[arXiv 2601.22025](https://arxiv.org/abs/2601.22025)

---

## 5. คำถามถึงตัวบอท (identity / capability)

| Platform | วิธีที่ใช้ |
|---|---|
| Azure CQA | chit-chat dataset: "Who are you / What can you do / Who created you" ที่ต้องเขียนคำตอบใหม่ให้เข้ากับบอท |
| Dialogflow | Small Talk / Default Welcome Intent |
| Rasa | `chitchat/ask_name`, `bot_challenge → utter_iamabot` |
| Copilot Studio | Conversation Start แนะนำตัวและบอกความสามารถ |
| watsonx | บอกว่าทำอะไรได้/ไม่ได้ในข้อความ No matches |
| ระบบเรา (ก่อนแก้) | ไปทาง BUSINESS → grounded กับ FAQ "หมอ X คือใคร" → INSUFFICIENT → handoff **ซึ่งกลับด้านกับทุก platform** |

ทางเลือกที่ทำได้ เรียงจากทนทานที่สุด:
1. **Rule หรือ DIRECT pattern**: regex ที่แม่นสำหรับรูปประโยคเปล่าๆ เช่น `(คุณ|น้อง|นี่)?(คือ|เป็น)ใคร`, `ชื่ออะไร`, `เป็นบอท|คนจริง`, `ช่วยอะไรได้บ้าง`
   หรือ AnswerPattern ที่เขียนคำตอบไว้แล้วพร้อม `questionExamples` หลายแบบ (`prisma/bks-identity-pattern.json` คือแนวทางนี้)
2. **classifier label แยกหรือรายการ Always GENERAL**: กันประโยคที่ถามต่างไปจากรูปแบบที่ rule จับได้ (**ทำแล้ว** ใน prompt ใหม่)
3. **Evidence item "assistant profile"** ที่แพลตฟอร์มสร้างจาก ownerPrompt พร้อม ID ของตัวเอง ให้ grounded generator อ้างได้
   แต่ต้องระวังไม่ให้ข้อความ persona กลายเป็น fact ของธุรกิจ

---

## 6. ภาษาไทย

- **"คุณ" ใช้ได้ทั้งเป็นสรรพนาม "you" และเป็นคำนำหน้าชื่อ** ใน "คุณคือใคร" ทั้ง 3 token (คุณ/คือ/ใคร) อยู่ใน stopword list ของ PyThaiNLP
  overlap ของ BM25 กับ "หมอ X คือใคร" จึงมาจาก function word ทั้งหมด ส่วน "คุณ + ชื่อ" ให้ถือเป็นการถามถึงคนที่มีชื่อ
- **Segmenter:** ตาม Figure 1 ของ AttaCut, Chrome ICU (v8BreakIterator) ได้ word-F1 ราว 0.8 เทียบกับ DeepCut ราว 0.97
  **(ยังไม่ยืนยัน: อ่านจากกราฟ และสมมติว่า Intl.Segmenter ใช้ dictionary ICU ชุดเดียวกัน)** ผลที่เราทดลองเองอยู่ใน audit-prompt.md ข้อ 5
- **stopword list ต้องอยู่ใน token space เดียวกับ Segmenter** (`เท่าไหร่` → `เท่า|ไหร่`) และห้ามเอารายการของ PyThaiNLP มาใช้ทั้งชุด
  เพราะรวมคำอย่าง `วัน`, `เปิด`, `ส่ง` ที่ร้านค้าใช้เป็นคำสำคัญ
- **ข้อมูลสำหรับทำ eval:** MASSIVE มีชุด th-TH 60 intent ใช้เป็นจุดเริ่มต้นได้ (ส่วนข้อมูลจริงต้องเป็นแชท LINE ที่ redact แล้ว), มี WangchanBERTa
  ส่วน leaderboard ของ embedding ภาษาไทยดูแลโดย community และผลยังไม่สอดคล้องกัน **(ยังไม่ยืนยัน)**
- **Platform ไทย:** Botnoi และ Zwiz.ai ไม่มีเอกสารสาธารณะเรื่องวิธี match **(ยังไม่ยืนยัน)** ส่วน AI chatbot (beta) ของ LINE OA
  ให้ keyword auto-reply ทำงานก่อน AI คือใช้ rule เป็นชั้นแรก

แหล่งอ้างอิง: [PyThaiNLP stopwords](https://github.com/PyThaiNLP/pythainlp/blob/dev/pythainlp/corpus/stopwords_th.txt) ·
[AttaCut](https://arxiv.org/abs/1911.07056) · [WangchanBERTa](https://arxiv.org/abs/2101.09635) ·
[MASSIVE](https://huggingface.co/datasets/AmazonScience/massive) ·
[LINE OA AI chatbot](https://help2.line.me/official_account_jp/web/categoryId/200000650/3/pc?lang=en)

---

## 7. Cascade และการเลือกระหว่างส่งต่อคน, ถามกลับ หรือตอบทั่วไป

- **Cascade:** FrugalGPT ลดต้นทุนได้สูงสุด 98%, classifier ที่ตัดสินว่า "ต้องค้นหาไหม" ช่วยลด latency ของ RAG
  (**ยังไม่ยืนยัน:** ตัวเลข latency มาจากบทสรุปรอง), Adaptive-RAG แยกเส้นทางตามความซับซ้อนของคำถาม
- **ส่งต่อคน:** หลังพลาด 2–3 ครั้ง (Copilot, watsonx, Rasa two-stage), เมื่อลูกค้าขอเอง หรือเจอ danger word
- **ถามกลับ (clarify):** เมื่อคะแนนอันดับ 1 กับ 2 ใกล้กัน (Lex 0.75 กับ 0.72, Rasa ห่างกันไม่ถึง 0.1, CALM เสนอได้ไม่เกิน 3 ตัวเลือก, Copilot ใช้ "หมายถึง…ใช่ไหม")

แหล่งอ้างอิง: [FrugalGPT](https://arxiv.org/abs/2305.05176) · [retrieval necessity](https://arxiv.org/abs/2407.01219) ·
[Adaptive-RAG](https://arxiv.org/abs/2403.14403)

---

## 8. เทียบกับระบบเรา

| ชั้น | Industry | ระบบเรา | ช่องว่าง |
|---|---|---|---|
| Rule / keyword | ทุก platform (LINE OA ก็ใช้ keyword ก่อน AI) | `RuleIntentService`, rich menu, register gate | ไม่มี rule สำหรับ identity / ขอคุยกับคน (นอกจาก "ติดต่อแอดมิน", "คุยกับเจ้าหน้าที่") |
| KB entry ที่มีคำตอบเขียนไว้ / chit-chat | Azure chit-chat, Rasa retrieval intent | AnswerPattern DIRECT | ยังไม่มี identity pattern ใน DB (มีแต่ไฟล์ json) |
| Embedding router ที่มี threshold | semantic-router, NeMo | vector ≥ 0.75 = RAG ที่มั่นใจ | ยังไม่มี kNN ตัดสิน *intent* (มีแค่ค้นหาคำตอบ) |
| LLM classifier | CALM, LangGraph, ticket routing | BUSINESS / GENERAL | 2 class ยังน้อยไป: ไม่มี HUMAN_REQUEST หรือ UNCLEAR, ไม่มี enum schema, ไม่มี retrieved few-shot |
| เกณฑ์ไม่ match | threshold ที่ calibrate แล้ว + negative example | ค่า cosine คงที่ 0.75 / 0.6 | ไม่มี negative example และไม่มี ambiguity gap |
| ไม่มีคำตอบใน KB | no-match → generative fallback / ถามใหม่ | handoff ทันที | **ช่องว่างใหญ่ที่สุด** (R2 + P1) |
| Handoff | ลูกค้าขอเอง, พลาด N ครั้ง, danger word | ทุก fallback | – |
| Eval | confusion matrix, consistency ≥95% | live eval (KB โรงแรม), test offline | ไม่มีชุด Thai ที่ติด label สำหรับ routing |

---

## 9. ข้อเสนอเรียงตามความคุ้ม

| # | ทำอะไร | ผลที่ได้ | ขนาด / ความเสี่ยง | สถานะ |
|---|---|---|---|---|
| 1 | classifier prompt: label แบ่งตามแหล่งคำตอบ + Always GENERAL/BUSINESS + ตัวอย่างคู่เทียบ | แก้ "คุณคือใคร" ที่ classifier | เล็ก / ต่ำ | **ทำแล้ว** |
| 2 | import identity AnswerPattern + rule regex สำหรับประโยคถามตัวตน | ตอบ DIRECT ได้ 0 AI call และแม่นที่สุด | เล็ก / ต่ำ | ยังไม่ทำ |
| 3 | ชุด eval ภาษาไทย 200–500 ข้อความ (redact แล้ว) มีคู่เทียบ + confusion matrix + อัตรา handoff ที่ไม่จำเป็น | ทำให้วัดผลข้อ 4–8 ได้ | กลาง / ไม่มีความเสี่ยงต่อ production | ยังไม่ทำ (เริ่มแล้วที่ live eval E8–E11) |
| 4 | INSUFFICIENT หรือ classifier fail → ตอบ "ยังไม่มีข้อมูลนี้" + quick reply "ติดต่อแอดมิน" ส่วน handoff อัตโนมัติเฉพาะเมื่อลูกค้าขอ หรือพลาด 2–3 ครั้ง | ลด handoff ที่ไม่จำเป็นได้มากที่สุด | กลาง / **ต้องตัดสินใจทางธุรกิจ** | ยังไม่ทำ |
| 5 | ส่ง enum `responseJsonSchema` ให้ classifier + ย้าย `reason` ขึ้นก่อน label | ลด parse fail ที่ทำให้ handoff | เล็ก / ต่ำ | ยังไม่ทำ |
| 6 | แยก class เพิ่ม: ASSISTANT_META, CHITCHAT, BUSINESS, HUMAN_REQUEST, UNCLEAR → CLARIFY | เส้นทางตรงกับ action, ไม่ต้องพึ่งกฎ "ไม่แน่ใจให้เลือก BUSINESS" | กลาง / กลาง (แก้ router + type) | ยังไม่ทำ |
| 7 | few-shot ที่ค้นได้: ดึงตัวอย่างที่ติด label ไว้ k=5 จาก pgvector | งาน benchmark ได้ 0.70 → 0.94 | กลาง / ต่ำ (ใช้ embedding ที่มีอยู่) | ยังไม่ทำ |
| 8 | kNN intent router ก่อน LLM (แนว semantic-router) | ตัดกรณีที่ชัดออกโดยไม่ต้องเรียก LLM | กลาง / กลาง | ยังไม่ทำ |
| 9 | แก้ BM25 สำหรับภาษาไทย (audit-prompt.md ข้อ 5) | ลด evidence ขยะที่พาไป grounded | เล็ก–กลาง / กลาง | ยังไม่ทำ |
| 10 | ตรวจ temperature ให้ตรงกับ model ที่ใช้จริง | ทำตามที่ provider แนะนำ | เล็ก / ต่ำ | ยังไม่ทำ |

ข้อ 2 + 3 + 4 รวมกันน่าจะลด handoff ที่ไม่จำเป็นได้มากกว่าการปรับ prompt อย่างเดียว ข้อ 6–8 ควรทำหลังมีชุด eval จากข้อ 3 แล้ว
