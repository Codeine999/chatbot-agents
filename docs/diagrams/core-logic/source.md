# Core logic · Service flow & ERD

ตรวจจาก working tree วันที่ 11 ตุลาคม 2026; ไม่ยืนยัน production. Flow คือการส่งต่อระหว่าง service; ERD แสดง FK จริง เฉพาะฟิลด์ที่เกี่ยวกับ core logic ไม่รวม CRUD ทั่วไป

## 01 · End-to-end

```mermaid
flowchart TB
  L["LINE OA · webhook"] --> G["LineSignatureGuard<br/>HMAC ของ raw body"]
  G --> C["LineWebhookController → LineWebhookAdapter<br/>validate payload · ingress rate limit"]
  C --> Q["BullMQ · line-events<br/>jobId = webhookEventId · HTTP ตอบหลัง enqueue"]
  Q --> W["LineEventsProcessor<br/>ban / rate limit / spam → DB claim + lease"]
  W --> WS["LineWebhookService.processEvent"]
  WS --> MP["MessageProcessorService"]
  MP --> EX{"LineChannelAdapter.findDelivery<br/>มีคำตอบที่ persist แล้ว?"}
  EX -->|มี| D["LineDeliveryService.deliver<br/>ใช้ข้อความเดิม"]
  EX -->|ไม่มี| IN["LineChannelAdapter.saveIncomingEvent<br/>LineMember + Conversation + USER history<br/>dedup lineMessageId · unread +1 ใน transaction"]
  IN --> CT["LoadContextService.load<br/>Redis · 3 turns · TTL 30 นาที"]
  CT --> TURN["LineChannelAdapter.toChatTurn<br/>text / postback / image / sticker"]
  TURN --> BOT["ChatbotService<br/>mute gate → route → execute"]
  BOT --> OUT["ChatResponse<br/>text · source · contextPolicy · catalogRefs"]
  OUT --> CLR["MessageProcessorService<br/>CLEAR: clear context ก่อน saveReply"]
  CLR --> SAVE["LineChannelAdapter.saveReply<br/>ตรวจ claim owner · upsert LineDelivery.key"]
  SAVE --> D
  D --> API["LineService.replyText / LineAdminService.pushText"]
  API --> ACC["LINE accepted → ACCEPTED"]
  ACC --> FIN["finalize<br/>history by deliveryId · conversation preview<br/>INCLUDE: append context + catalogRefs"]
  W -. retry / recovery .-> R["line-events-retry<br/>LineEventsRetryProcessor → processor เดิม"]
  R --> W
```

- Queue main concurrency 10; retry concurrency 3. Retryable provider errors ที่หลุดออกจาก main ไป retry queue; webhook recovery scan ทุก 15 วินาที
- การเรียงต่อ user ใช้ userProcessingTails ใน process; ไม่ใช่ distributed lock แม้ event claim เป็น DB lease
- Adapter รับ follow/unfollow แต่ saveIncomingEvent คืน null สำหรับ lifecycle event เหล่านี้ จึงไม่มี chatbot turn; event/message type ที่ไม่รองรับถูก acknowledge โดยไม่ enqueue
- Image จาก LINE ดาวน์โหลดใน adapter ก่อน chatbot mute gate; external image คืน SYSTEM response แบบ EXCLUDE
- Loading indicator เป็น best effort และไม่บล็อก turn. Automatic outbound history ใน finalize ใช้ sender SYSTEM แม้ ChatResponse.source เป็น AI/KNOWLEDGE
- Sources: src/modules/line/line-webhook.adapter.ts, line-signature.guard.ts, line-events.processor.ts, line-webhook.service.ts, line-channel.adapter.ts, line-delivery.service.ts; src/modules/events/message/message-processor.service.ts

## 02 · Chatbot routing

```mermaid
flowchart TB
  A["ChatbotService.handleTextMessage"] --> M{"UserSessionService.isMuted?"}
  M -->|ใช่| Z["ข้อความว่าง · SYSTEM / EXCLUDE"]
  M -->|ไม่| S["load workflow session<br/>empty / length / registration feature gates"]
  S --> RT["IntentRouterService.resolve"]
  RT --> RM{"Rich menu postback / exact label match?"}
  RM -->|reply key| RR["RICH_MENU_REPLY<br/>verbatim cached reply · clear active session"]
  RM -->|built-in intent| ACT["ChatbotService execute RouteDecision"]
  RM -->|ไม่มี| RULE["RuleIntentService.detect<br/>deterministic · ไม่มี I/O"]
  RULE --> CANCEL{"CANCEL?"}
  CANCEL -->|ใช่| ACT
  CANCEL -->|ไม่| REG{"active REGISTER?"}
  REG -->|ไม่มี high-confidence interruption| ACT
  REG -->|มี informational interruption| HI["rule / session decision<br/>registration data ยังคงอยู่"]
  REG -->|ไม่ active| HI
  HI -->|action ไม่ใช่ knowledge| ACT
  HI -->|ต้อง retrieval / unknown| KR["KnowledgeRetrievalService.retrieve<br/>active REGISTER: disableProduct"]
  KR --> DEC{"ผล retrieval"}
  DEC -->|product / confident knowledge| ACT
  DEC -->|missing reference| CL["CLARIFY · INCLUDE"]
  DEC -->|conflict / retrieval error| HA["CONTACT_ADMIN + business fallback"]
  DEC -->|LOW_CONFIDENCE| PC{"plannerIntent = KNOWLEDGE?"}
  PC -->|ใช่ + evidence| ACT
  PC -->|ใช่ ไม่มี evidence| HA
  PC -->|ไม่| CLASS["AiIntentClassifierService.classifyLowConfidence"]
  CLASS -->|GENERAL| GEN["AiChatService.answerGeneral"]
  CLASS -->|BUSINESS + selected evidence + ไม่ failed| ACT
  CLASS -->|ไม่มี evidence / failed| HA
  ACT -->|START / CONTINUE_REGISTER| RF["RegistrationFlowService"]
  ACT -->|ANSWER_KNOWLEDGE| AI["AiChatService.answerKnowledge"]
  ACT -->|cancel / menu / ask question| T["ReplyTemplateService + UserSessionService"]
  ACT -->|CONTACT_ADMIN / FALLBACK| HA
  HA --> UA["UserSessionService.requestAdmin<br/>waiting_admin + notification"]
  AI -->|isFallback| UA
  GEN -->|isFallback| UA
```

- ลำดับจริง: rich menu มาก่อน rule CANCEL; ไม่ควรอ้างว่า cancel เป็นอันดับแรกของ router เสมอ
- Whole-message inquiry opener ไป CONTINUE_AI_CHAT ก่อน retrieval. START_AI_CHAT ตั้ง GENERAL_QUESTION session เมื่อไม่ได้อยู่ใน active registration
- StickerIntentService: greeting/thanks/unknown ตอบ template แบบ EXCLUDE; TEXT กลับเข้า handleTextMessage. Image ผ่าน AiChatService.answerImage + image safety policy; unsafe/transaction/business-unverified ใช้ fallback + handoff
- Sources: src/modules/chatbot/chatbot.service.ts, intent-router.service.ts, rule-intent.service.ts, sticker-intent.service.ts, ai-intent-classifier.service.ts, image-analysis.policy.ts

## 03 · Knowledge RAG

```mermaid
flowchart TB
  K["KnowledgeRetrievalService.retrieve"] --> P["ProductRetrievalService gate<br/>อาจ return product หรือ delegate legacy"]
  P --> LEG["runRetrieval<br/>resolveRetrievalQuery + redactPii"]
  LEG --> MISS{"missing reference?"}
  MISS -->|ใช่| CL["LOW_CONFIDENCE / MISSING_USER_INFORMATION"]
  MISS -->|ไม่| CACHE["AnswerPatternCacheService<br/>AnswerPatternService.findMatchesFromPatterns"]
  CACHE --> EXACT{"verbatim safe DIRECT<br/>ไม่ REWRITE / ไม่ forceGrounded?"}
  EXACT -->|ใช่| DIR["DIRECT result"]
  EXACT -->|ไม่| DB["AnswerPatternService.findMatches<br/>DB เป็น authoritative"]
  DB -->|safe DIRECT| DIR
  DB -->|ยังต้องค้น| PAR["parallel retrieval"]
  PAR --> MICRO["MicroKnowledgeService.findMatches<br/>lexical"]
  PAR --> SEM["SemanticSearchService.search"]
  SEM --> EMB["EmbeddingService.embedQuery<br/>ใช้ prepared embedding ได้"]
  EMB --> V["AnswerPatternVectorRepository<br/>MicroKnowledgeVectorRepository<br/>model + tenant + language + active"]
  DB --> FUSE["noise filtering → RRF rank<br/>select bounded context → conflict check"]
  MICRO --> FUSE
  V --> FUSE
  FUSE --> RES["RAG / LOW_CONFIDENCE<br/>evidence · fallbackReason"]
  DIR --> ANS["AiChatService.answerKnowledge"]
  RES --> ROUTER["IntentRouterService decision"]
  ROUTER --> ANS
  ANS -->|usable safe DIRECT| VER["stored answer · ไม่มี generation"]
  ANS -->|usable evidence| GRO["generateFromKnowledge<br/>AiSetting + grounded prompt"]
  GRO --> PRO["UsersAiProviderService → billing → provider"]
  PRO --> VAL{"JSON ANSWER + directlyAnswered<br/>evidenceIds valid?"}
  VAL -->|ผ่าน| OK["grounded response · INCLUDE"]
  VAL -->|ไม่ผ่าน| FB["configured fallback → requestAdmin"]
  ANS -->|ไม่มี usable evidence| FB
```

- Retrieval reuse ใน router ส่งต่อให้ AiChatService; ไม่ค้นซ้ำใน path ปกติ. Product gate ที่ตรวจ legacy ใช้ promise เดียวเมื่อ query เดิม
- REWRITE / follow-up / BOTH ที่ forceGrounded ไม่เข้า safe DIRECT. Read failure ที่จำเป็นหรือ conflict ห้าม generate จาก pool ที่ไม่ครบ
- RRF เป็น ranking score; confidence gate ใช้ exact match หรือ cosine similarity ไม่เอา RRF เทียบ threshold ของ cosine
- Sources: src/modules/chatbot/knowledge/knowledge-retrieval.service.ts, semantic-search.service.ts, retrieval-query-planner.service.ts, knowledge-scope.ts; src/modules/chatbot/aichat.service.ts

## 04 · Product RAG

```mermaid
flowchart TB
  K["KnowledgeRetrievalService"] --> G{"PRODUCT_ENABLED + PRODUCT_RAG_ENABLED<br/>และ context identifiers ครบ?"}
  G -->|ไม่| L["legacy Knowledge RAG"]
  G -->|ใช่| S["CommerceScopeService.forLineDeployment<br/>company / tenant ownership"]
  S --> FAST["ProductRetrievalService.routeWithoutPlanner<br/>policy exact / confident FAQ → legacy<br/>catalog signal / unresolved → PLAN"]
  FAST -->|legacy| L
  FAST -->|ต้อง product workflow / stored turn| T["CommerceTurnService.find / open / withLease<br/>pin provider/model · redacted input snapshot"]
  T --> PL["reuse stored plan หรือ probe + plannerCatalog<br/>exact SKU / pure policy: deterministic plan<br/>อื่น ๆ: CommerceTurnService.call PLAN"]
  PL --> MODE{"validated ProductPlan.mode"}
  MODE -->|KNOWLEDGE| L
  MODE -->|PRODUCT / BOTH| SEARCH["ProductSearchService.search<br/>scoped DB snapshot · product / variant / inventory"]
  SEARCH --> NEED{"semantic enabled + ไม่มี productIds<br/>weak result หรือ RECOMMEND?"}
  NEED -->|ใช่| E["EmbeddingService.embedQuery<br/>ProductVectorRepository → search อีกครั้ง"]
  NEED -->|ไม่| SAVE["save CommerceTurn.retrieval"]
  E --> SAVE
  MODE -->|BOTH| POLICY["knowledge policyQuery<br/>forceGrounded · share embedding เมื่อ query ตรงกัน"]
  POLICY --> SAVE
  MODE -->|GENERAL| SAVE
  PL -->|invalid / failed| SAVE
  SAVE --> AI["AiChatService.answerKnowledge<br/>ProductAnswerService.answer"]
  AI --> SAFE{"stored response / failed / non-FOUND?"}
  SAFE -->|stored response| REPLAY["return stored AiAnswerResult"]
  SAFE -->|non-FOUND| DET["safeProductAnswer<br/>clarify / no-match / unavailable"]
  SAFE -->|failed| FB["configured fallback + handoff"]
  SAFE -->|FOUND / GENERAL| CALL["CommerceTurnService.call ANSWER"]
  CALL --> CHECK["renderProductAnswer<br/>validate citations + allowlisted fact tokens"]
  CHECK -->|invalid non-critical / unavailable response| DET
  CHECK -->|INSUFFICIENT_CONTEXT| REJECT["identified product: fallback + handoff<br/>unmatched candidates: clarify choices"]
  CHECK -->|critical invalidity + ไม่ explicit rejection| REPAIR["CRITICAL_REPAIR · ได้ไม่เกิน 1 slot"]
  REPAIR --> CHECK2["validate อีกครั้ง"]
  CHECK -->|ผ่าน| FINAL["render tokens จาก snapshot<br/>save response + catalogRefs"]
  CHECK2 -->|ผ่าน| FINAL
  CHECK2 -->|ไม่ผ่าน| DET
```

- Durable uniqueness: companyId + connectionKey + externalEventId. CommerceLlmCall unique turnId+slot และ turnId+ordinal; ไม่เกิน 3 calls: PLAN, ANSWER, CRITICAL_REPAIR (บาง turn ไม่ต้องใช้ทุก slot)
- ราคา/stock เป็น DB snapshot ของ turn; vector ช่วยหา candidate ไม่ใช่แหล่งราคา/stock. Product mode ไม่มี checkout/order/payment mutation
- BOTH เมื่อไม่มี policy evidence ตอบ product half พร้อมข้อความว่ policy ยังยืนยันไม่ได้; ไม่แต่ง policy
- Product GENERAL ใช้ general rules ภายใต้ workflow นี้. KNOWLEDGE ส่ง plannerIntent กลับ router เพื่อไม่ classify BUSINESS/GENERAL ซ้ำ
- Feature defaults เป็น false; PRODUCT_SEMANTIC_ENABLED ขึ้นกับสอง flags ก่อนหน้า ไม่ได้อ่าน .env เพื่อสรุป deployment
- Sources: src/modules/chatbot/knowledge/product-retrieval.service.ts, product-answer.service.ts, product-answer.policy.ts; src/modules/commerce/commerce-turn.service.ts, commerce-scope.service.ts, commerce-feature.service.ts; src/modules/products/search/product-search.service.ts

## 05 · Provider & credit lifecycle

```mermaid
flowchart TB
  A["AiChatService / AiIntentClassifierService<br/>หรือ CommerceTurnService.call"] --> U["UsersAiProviderService.generate<br/>USER settings หรือ pinned selection"]
  U --> B["AiBillingService.runBilled"]
  E["EmbeddingService<br/>query / document + Redis AiBudgetService"] --> EB["AiBillingService.runBilledEmbedding"]
  EB --> REPLAY
  B --> REPLAY{"SETTLED result สำหรับ operationKey?"}
  REPLAY -->|มี| OLD["replay stored provider result<br/>ไม่มี provider call / debit ใหม่"]
  REPLAY -->|ไม่มี| PRICE["AiPricingService<br/>effective-dated quote + reservedCredit"]
  PRICE --> HOLD["CreditService.reserveAiCredit<br/>atomic wallet + matching budget hold<br/>CreditReservation HELD"]
  HOLD --> CALL["provider call นอก DB transaction<br/>generation: AiProviderService.generateWith<br/>embedding: EMBEDDING_ADAPTER"]
  CALL -->|billable success| NORM["normalized usage + request ID<br/>Decimal pricing calculation"]
  NORM --> SET["CreditService.recordAiUsage · atomic settlement<br/>AiUsageEvent + result + reservation SETTLED<br/>release hold · wallet/budget · at most one DEBIT"]
  CALL -->|provider failure| FAIL["failed usage · RELEASED<br/>release hold · ไม่มี DEBIT"]
  NORM -->|settlement commit failed| UNK["UNKNOWN reservation<br/>PendingAiUsageError · ต้องตรวจ/recover"]
  HOLD -->|HELD / UNKNOWN key ซ้ำ| WAIT["PendingAiUsageError"]
```

- Generation และ embedding มี billing abstraction ร่วม แต่ embedding ใช้ EMBEDDING_ADAPTER ไม่ได้วิ่งผ่าน UsersAiProviderService/AiProviderService
- AiBudgetService เป็น Redis call limit; CreditBudget เป็น Decimal credit hold/used ใน DB เป็นคนละ gate. Call sites ของ generation ตรวจ AiBudgetService และ pinned product ใช้ beforeCall
- scopeKey แยก document indexing กับ query embedding; ledger amount ของ DEBIT เป็นลบ. Provider result ที่ bill แล้วแต่ถูก answer validator ปฏิเสธ ยังมี usage/charge ตาม provider outcome
- Reservation expiry ไม่มี automatic refund: listUnresolvedReservations เปลี่ยน expired HELD เป็น UNKNOWN; releaseUnknownReservation เป็นการแก้โดยผู้มีสิทธิ์
- Sources: src/modules/ai/users-ai-provider.service.ts, ai-provider.service.ts, embeding/embedding.service.ts; src/modules/usage/billing/ai-billing.service.ts, ai-pricing.service.ts; src/modules/usage/credit-point/credit.service.ts

## 06 · Delivery & recovery

```mermaid
flowchart TB
  P["LineDelivery PENDING<br/>key unique · durable text + context"] --> CL["claim → SENDING<br/>lease owner / 120s · attempts +1"]
  CL --> M{"automatic + Redis muted?"}
  M -->|ใช่| FAIL["FAILED · suppressed"]
  M -->|ไม่| R{"REPLY token ยังอยู่ใน window?"}
  R -->|ใช่| RP["LineService.replyText"]
  RP -->|accepted| A["ACCEPTED + acceptedAt"]
  RP -->|definitive invalid token / false| PUSH["transition method PUSH<br/>retryKey เดิม · firstPushAt"]
  RP -->|unknown outcome| U["UNKNOWN · ห้ามเดาว่าส่งไม่สำเร็จ"]
  R -->|ไม่| PUSH
  PUSH --> ADM["admin reply: set Redis mute ก่อน attempt<br/>automatic: recheck mute"]
  ADM --> AP["LineAdminService.pushText<br/>X-Line-Retry-Key<br/>accepted → outbound counter"]
  AP -->|accepted / accepted 409| A
  AP -->|retryable + attempts ต่ำกว่า 8| BACK["PENDING · exponential delay สูงสุด 60s"]
  BACK --> CL
  AP -->|final rejected| FAIL
  AP -->|unknown exhausted / retry key อายุ 23h| U
  A --> F["finalize local writes<br/>history unique deliveryId · append INCLUDE context<br/>set finalizedAt"]
  A -->|local write failed| REC["recovery scan 5s<br/>ACCEPTED + ไม่ finalized"]
  REC --> F
  ST["stale SENDING REPLY"] --> U
  SP["stale SENDING PUSH"] --> CL
```

- ReplyUntil = event.timestamp + 50 วินาที; event เก่าไม่ได้ drop เพราะอายุ แต่เลือก PUSH ใน delivery
- Accepted กับ finalizedAt แยกกัน; repair หลัง acceptance ไม่ resend LINE และไม่ generate AI ใหม่
- LineAdminService.pushText ปัจจุบันส่ง HTTP แล้วบันทึก outbound counter; path นี้ไม่มี CreditService debit หรือ quota pre-check จึงไม่วาดว่า LINE_PUSH_MESSAGE ถูก bill อัตโนมัติ
- Sources: src/modules/line/line-delivery.service.ts, line-channel.adapter.ts, line-reply.service.ts, admin/line-admin.service.ts

## 07 · Registration & handoff

```mermaid
flowchart TB
  R["ChatbotService START / CONTINUE_REGISTER<br/>registration feature gate"] --> F["RegistrationFlowService<br/>parser → merge session data → validator"]
  F -->|fields ยังไม่ครบ / invalid| SS["UserSessionService.set<br/>Redis chat:session · TTL ต่ออายุเมื่อ get"]
  SS --> F
  F -->|ครบ| RS["RegistrationService.registerForLine"]
  RS -->|PRODUCT_ENABLED false| MB["Member create"]
  RS -->|PRODUCT_ENABLED true| ID["transaction: Member create<br/>CustomerIdentityService.linkRegisteredLine<br/>Customer + ChannelIdentity + LineMember linkage"]
  MB --> END["clear registration session<br/>template response · context CLEAR"]
  ID --> END
  RS -->|error| SS
  H["contact-admin / AI fallback"] --> REQ["UserSessionService.requestAdmin<br/>LineConversation.status = waiting_admin"]
  REQ --> N["NotificationService.notifyAdminRequired<br/>AdminNotification → NotificationGateway /admin"]
  REQ --> ACTIVE["AI ยังตอบได้ · registration ไม่ถูกทับ"]
  ADMIN["authenticated admin reply<br/>LineWebhookService.sendAdminMessage<br/>clientRequestId → durable PUSH"] --> D["LineDeliveryService<br/>Redis ADMIN mute ก่อน actual send"]
  D -->|LINE accepts| OPEN["transaction: ACCEPTED<br/>waiting_admin → open"]
  OPEN --> HIST["ADMIN history · mute ยังอยู่ตาม TTL"]
  HIST -->|TTL expires| BOT["AI ตอบได้อีกครั้ง"]
  RES["resume-bot endpoint"] --> CLEAR["sessions.resume → conversation open<br/>LoadContextService.clear"]
  CLEAR --> BOT
```

- waiting_admin คือ durable request queue ไม่ใช่ mute. Admin send ที่ไม่ accepted ยังไม่เปิด conversation
- Registration gate และ Product flags เป็นคนละเงื่อนไข; registration PII ไม่ใช้เป็น AI context
- Notification metadata.conversationId เป็น JSON linkage ไม่ใช่ foreign key. Notification failure ถูก catch และไม่มี durable notification outbox ใน path นี้
- Sources: src/modules/registration/registration-flow.service.ts, registration.service.ts; src/modules/users/customers/customer-identity.service.ts; src/modules/chatbot/user-session.service.ts; src/modules/line/line-webhook.service.ts; src/modules/admin/notification/notification.service.ts

## 08 · Product indexing event

```mermaid
flowchart TB
  C["catalog searchable content change<br/>ProductService"] --> TX["catalog mutation transaction<br/>searchRevision + enqueueProductIndex"]
  AT["ProductAttributeService<br/>definition change → searchRevision +1"] --> POLL["ProductIndexService.tick<br/>discover missing current-revision jobs"]
  POLL --> J
  TX --> J["ProductIndexJob<br/>unique productId + searchRevision + model<br/>document + contentHash snapshot"]
  J --> WK["ProductIndexService.tick / process<br/>semantic flag · scoped DB claim + lease"]
  WK --> CK{"revision / model ยังตรง?"}
  CK -->|ไม่| SUPER["SUPERSEDED"]
  CK -->|ตรง| EM["EmbeddingService.embedDocument<br/>billing document scope · นอก transaction"]
  EM --> RE["transaction: lock + recheck freshness"]
  RE -->|fresh| V["ProductVectorRepository.upsert<br/>model / revision / contentHash → DONE"]
  RE -->|stale| SUPER
  EM -->|error| RET["job retry / FAILED ตาม policy"]
  V --> READ["ProductSearchService<br/>vector candidate + authoritative DB facts"]
  INV["InventoryService adjustment<br/>command + InventoryMovement + InventoryBalance"] --> READ
```

- Indexing เป็น derived-data workflow จึงรวมไว้แม้ไม่แสดง CRUD endpoint. Price/stock ไม่ใช้ vector เป็นแหล่งข้อเท็จจริง; document builder คุม content สำหรับ semantic identity
- ProductCatalogCommand และ InventoryMovement เก็บ originating command/idempotency ของ stock adjustment. แผนภาพนี้ไม่ได้สื่อว่ามี customer checkout/reservation
- Sources: src/modules/products/search/product-index-outbox.ts, product-index.service.ts, product-vector.repository.ts, product-document.ts; src/modules/products/product.service.ts, inventory.service.ts, attributes/product-attribute.service.ts

## 09 · Admin AI turn

```mermaid
flowchart TB
  HTTP["AdminChatController<br/>AdminGuard · JWT admin id · DTO validation"] --> S["AdminChatService.sendMessage"]
  S --> REQ["ensureRequest + assertSameRequest<br/>owner / text / room match<br/>AdminChatRequest.clientRequestId unique"]
  REQ --> R{"assistantMessageId มีแล้ว?"}
  R -->|มี| OLD["return existing messages"]
  R -->|ไม่มี| HIST["loadContext<br/>ล่าสุดไม่เกิน 20 messages จาก DB"]
  HIST --> P["AdminAiProviderService.generate"]
  P --> G["AdminAiProviderSettingsService<br/>AdminMember.aiEnabled + provider/model<br/>AiModelCatalogService.assertSelectable"]
  G --> B["AiBillingService.runBilled<br/>ADMIN_AI_QUERY · scopeKey = adminMemberId<br/>key = admin-chat:request.id"]
  B --> CALL["reserve / replay → AiProviderService.generateWith<br/>shared company wallet · scoped admin budget"]
  CALL --> FIN["transaction: assistant message upsert by request.id<br/>request COMPLETED + assistantMessageId<br/>room lastMessageAt"]
  FIN --> OUT["return room + userMessage + assistantMessage"]
```

- Admin role ต้องมี budget limit ตาม requireBudgetLimit; owner/dev ใช้เงื่อนไข setting.role ตามโค้ด. Admin AI query ไม่ส่ง LINE และไม่ได้เข้าลูกค้า IntentRouterService
- clientRequestId ที่ไม่ส่งมาจะสร้าง UUID ใหม่; client ต้อง reuse ID เดิมเพื่อ retry เป็น turn เดิม. Provider success ที่ billing settle แล้วแต่ local persist ล้มสามารถ replay ด้วย request เดิม
- Sources: src/modules/admin/ai-chat/admin-chat.controller.ts, admin-chat.service.ts; src/modules/ai/admin-ai-provider.service.ts, ai-setting/admin-ai-provider-settings.service.ts

## 10 · Credit top-up event

```mermaid
flowchart TB
  H["AdminBillController.createTopup<br/>AdminGuard · multipart validation"] --> S["AdminBillService.createTopup<br/>active exchange rate + package/amount<br/>Decimal credit calculation"]
  S --> UP["FileStorage upload<br/>private slip"]
  UP --> P["CreditTopupHistory PENDING<br/>store package / exchange-rate references"]
  UP -->|DB persist error| CLEAN["remove uploaded slip"]
  P --> D{"dev approval decision<br/>AdminGuard dev"}
  D -->|confirm| TX["AdminBillService.confirmTopup<br/>serializable transaction"]
  TX --> CL{"claim PENDING → APPROVED<br/>approver + approvedAt"}
  CL -->|already processed| CON["Conflict / NotFound<br/>ไม่เพิ่ม wallet ซ้ำ"]
  CL -->|claimed| W["CreditWallet upsert<br/>balanceCredit + lifetimeTopupCredit"]
  W --> L["CreditLedger TOPUP<br/>positive credit · balanceAfterCredit<br/>unique topup:topup.id"]
  L --> COM["commit ทั้งชุด<br/>signed slip URL นอก transaction"]
  D -->|reject| REJ["AdminBillService.rejectTopup<br/>conditional PENDING → REJECTED<br/>rejector + rejectedAt · ไม่เปลี่ยน wallet/ledger"]
```

- Top-up เป็น internal credit workflow แยกจาก product/order payment; approval ต้อง dev ตาม controller ปัจจุบัน ไม่ใช่ OCR หรือ AI ตรวจสลิป
- Approval failure rollback ทั้ง status/wallet/ledger; repeated APPROVED request คืน Conflict ตาม implementation ไม่ใช่ success replay
- Sources: src/modules/admin/bill/admin-bill.controller.ts, admin-bill.service.ts; prisma/models/admin/wallet.schema.prisma

## 11 · ERD — Conversation & identity

```mermaid
erDiagram
  Company ||--o{ Customer : companyId
  Member o|--o{ Customer : memberId
  Customer ||--o{ ChannelIdentity : "customerId + companyId"
  Customer o|--o{ LineMember : customerId
  Member o|--o{ LineMember : memberId
  LineMember ||--o| LineConversation : lineMemberId
  LineMember ||--o{ LineChatHistory : lineMemberId
  LineConversation ||--o{ LineChatHistory : conversationId
  AdminMember o|--o{ LineChatHistory : sentByAdminId
  Company ||--o{ CommerceTurn : companyId
  LineMember ||--o{ CommerceTurn : lineMemberId
  LineConversation ||--o{ CommerceTurn : conversationId
  CommerceTurn ||--o{ CommerceLlmCall : turnId
  Company { UUID id PK }
  Member { UUID uuid PK }
  AdminMember { UUID id PK }
  Customer { UUID id PK
    UUID companyId FK
    UUID memberId FK "nullable; companyId+memberId unique"
    UUID tenantId "nullable" }
  ChannelIdentity { UUID id PK
    UUID customerId FK
    UUID companyId FK
    String channel
    String connectionKey
    String externalUserId "namespace composite unique" }
  LineMember { UUID id PK
    String lineUserId UK
    UUID memberId FK "nullable"
    UUID customerId FK "nullable" }
  LineConversation { UUID id PK
    UUID lineMemberId FK,UK
    String status
    Int unreadCount }
  LineChatHistory { UUID id PK
    UUID conversationId FK
    UUID lineMemberId FK
    String lineMessageId UK "nullable"
    UUID deliveryId UK "nullable; NO FK"
    UUID sentByAdminId FK "nullable"
    String sender }
  CommerceTurn { UUID id PK
    UUID companyId FK
    UUID lineMemberId FK
    UUID conversationId FK
    String connectionKey
    String externalEventId "company+connection+event unique"
    Json plan
    Json retrieval
    Json response }
  CommerceLlmCall { UUID id PK
    UUID turnId FK
    String slot "turnId+slot unique"
    Int ordinal "turnId+ordinal unique; 1..3"
    Json result }
```

- Company→LineConversation และ Company→LineMember ไม่มี direct FK; LINE deployment เป็น single Company/OA. Customer/CommerceTurn เพิ่ม company scope ตาม schema จริง
- Sources: prisma/schema.prisma, prisma/member.prisma, prisma/models/customers/customer.prisma, prisma/models/customers/commerce-turn.prisma

## 12 · ERD — Knowledge & delivery records

```mermaid
erDiagram
  AnswerPattern ||--o| AnswerPatternVector : answerPatternId
  MicroKnowledge ||--o| MicroKnowledgeVector : microKnowledgeId
  AnswerPattern { UUID id PK
    UUID tenantId "nullable; NO FK"
    String language
    Boolean active
    String renderMode
    String answer }
  AnswerPatternVector { UUID id PK
    UUID answerPatternId FK,UK
    vector1536 embedding
    String embeddingModel "nullable"
    Boolean active }
  MicroKnowledge { UUID id PK
    UUID tenantId "nullable; NO FK"
    String entityKey
    String topicKey
    String language
    Boolean active
    String answer }
  MicroKnowledgeVector { UUID id PK
    UUID microKnowledgeId FK,UK
    vector1536 embedding
    String embeddingModel "nullable"
    Boolean active }
  ProcessedLineWebhookEvent { UUID id PK
    String webhookEventId UK
    String status
    DateTime leaseUntil
    Int attempts
    Json event }
  LineDelivery { UUID id PK
    String key UK
    UUID conversationId "NO FK"
    UUID lineMemberId "NO FK"
    UUID adminMemberId "nullable; NO FK"
    String method
    String status
    UUID retryKey
    Json context
    DateTime acceptedAt
    DateTime finalizedAt }
  AdminNotification { UUID id PK
    String userId "LINE user id; NO FK"
    Json metadata "conversationId inside JSON; NO FK"
    Boolean isRead }
  AiSetting { UUID id PK
    UUID tenantId "nullable; NO FK"
    String fallbackMessage
    Boolean active }
  AiProviderSetting { UUID id PK
    String scope UK
    String provider
    String model }
```

- กล่องที่ไม่เชื่อมกันตั้งใจสะท้อนว่าไม่มี FK. เชื่อมเชิง logic: event.webhookEventId = LineDelivery.key; LineChatHistory.deliveryId = LineDelivery.id; notification.metadata.conversationId = conversation.id
- Redis chat:session, chat:control, chat:context และ cache ไม่ใช่ PostgreSQL entities
- Sources: prisma/schema.prisma; migrations ของ webhook/delivery ใน prisma/migrations/20260907000000_fix_mvp_release_blockers/migration.sql

## 13 · ERD — Product & derived index

```mermaid
erDiagram
  Company ||--o{ Product : companyId
  Company ||--o{ ProductAttributeDefinition : companyId
  Product ||--o{ ProductVariant : "productId + companyId"
  Product ||--o| ProductVector : "productId + companyId"
  Product ||--o{ ProductIndexJob : "productId + companyId"
  ProductVariant ||--o| InventoryBalance : "variantId + companyId"
  ProductVariant ||--o{ InventoryMovement : "variantId + companyId"
  Company ||--o{ ProductCatalogCommand : companyId
  ProductCatalogCommand ||--o| InventoryMovement : "commandId + companyId"
  AdminMember ||--o{ ProductCatalogCommand : actorAdminId
  AdminMember ||--o{ InventoryMovement : actorAdminId
  Company { UUID id PK }
  AdminMember { UUID id PK }
  Product { UUID id PK
    UUID companyId FK
    String sku "companyId+sku unique"
    Decimal basePrice "nullable; 12_2"
    Decimal compareAtPrice "nullable; 12_2"
    Boolean active
    Int searchRevision
    Json attributes }
  ProductVariant { UUID id PK
    UUID productId FK
    UUID companyId FK
    String sku "companyId+sku unique"
    Decimal priceOverride "nullable; 12_2"
    Decimal compareAtPrice "nullable; 12_2"
    Json attributes }
  InventoryBalance { UUID id PK
    UUID variantId FK,UK
    UUID companyId FK
    Int onHand
    Int reserved
    Int version }
  ProductVector { UUID productId PK,FK
    UUID companyId FK
    vector1536 embedding
    String embeddingModel
    Int searchRevision
    String contentHash }
  ProductIndexJob { UUID id PK
    UUID productId FK
    UUID companyId FK
    Int searchRevision "product+revision+model unique"
    String embeddingModel
    String state
    DateTime leaseUntil }
  ProductAttributeDefinition { UUID id PK
    UUID companyId FK
    String key "companyId+key unique"
    String scope
    String type
    Boolean searchable
    Boolean aiVisible }
  ProductCatalogCommand { UUID id PK
    UUID companyId FK
    UUID actorAdminId FK
    UUID requestId "companyId+requestId unique"
    String action
    Json result }
  InventoryMovement { UUID id PK
    UUID variantId FK
    UUID companyId FK
    UUID commandId FK,UK
    UUID actorAdminId FK
    String operationKey UK
    Int deltaOnHand
    Int onHandAfter }
```

- ProductAttributeDefinition.key ใช้เป็น key ใน attributes JSON; ไม่มี Product→Definition FK. Composite FK ของ variant/vector/index/inventory ป้องกันการอ้างข้าม company
- Sources: prisma/models/products/product.prisma; migrations 20261005000000_add_customer_product_catalog, 20261006000000_add_product_rag, 20261007000000_add_product_attribute_definitions

## 14 · ERD — Usage & credit

```mermaid
erDiagram
  Company ||--o| CreditWallet : companyId
  Company ||--o{ AiUsageEvent : companyId
  CreditWallet ||--o{ CreditBudget : walletId
  CreditWallet ||--o{ CreditReservation : walletId
  CreditBudget ||--o{ CreditReservation : budgetId
  CreditWallet ||--o{ CreditLedger : walletId
  AiUsageEvent o|--o| CreditLedger : usageEventId
  AiModelPricing o|--o{ AiUsageEvent : pricingId
  AdminMember o|--o{ AiUsageEvent : adminMemberId
  Company ||--o{ CreditTopupHistory : companyId
  CreditExchangeRate o|--o{ CreditTopupHistory : exchangeRateId
  CreditPackagePrice o|--o{ CreditTopupHistory : packagePriceId
  Company { UUID id PK }
  AdminMember { UUID id PK }
  CreditWallet { UUID id PK
    UUID companyId FK,UK
    Decimal balanceCredit "20_6"
    Decimal reservedCredit "20_6"
    Decimal lifetimeSpentCredit "20_6" }
  CreditBudget { UUID id PK
    UUID walletId FK
    String kind
    String scopeKey "wallet+kind+scope unique"
    Decimal usedCredit "20_6"
    Decimal reservedCredit "20_6" }
  CreditReservation { UUID id PK
    String operationKey UK
    UUID companyId "NO FK"
    UUID walletId FK
    UUID budgetId FK
    String status
    Json result
    DateTime expiresAt }
  AiUsageEvent { UUID id PK
    UUID companyId FK
    UUID pricingId FK "nullable"
    UUID adminMemberId FK "nullable"
    UUID conversationId "nullable; NO FK"
    UUID lineMemberId "nullable; NO FK"
    String kind
    String scopeKey
    Decimal chargedCredit "20_6"
    String providerRequestId }
  CreditLedger { UUID id PK
    UUID walletId FK
    UUID usageEventId FK,UK "nullable"
    String idempotencyKey UK
    String type
    Decimal amountCredit "20_6"
    Decimal balanceAfterCredit "20_6" }
  AiModelPricing { UUID id PK
    String provider
    String model
    DateTime effectiveFrom "provider+model+from unique"
    DateTime effectiveTo "nullable" }
  CreditTopupHistory { UUID id PK
    UUID companyId FK
    UUID exchangeRateId FK "nullable"
    UUID packagePriceId FK "nullable"
    String status
    Decimal creditAmount "20_6" }
  CreditExchangeRate { UUID id PK }
  CreditPackagePrice { UUID id PK }
```

- ไม่มี CreditReservation→AiUsageEvent FK และไม่มี CreditTopupHistory→CreditLedger FK; ใช้ operation/idempotency key ใน business logic. Top-up ยังมี requestedBy/approvedBy/rejectedBy AdminMember FKs ที่ไม่ได้วาดใน scoped ERD นี้
- Pricing effective interval: effectiveFrom ≤ requestTime < effectiveTo; null effectiveTo = open-ended. ไม่แสดง provider cost values
- Sources: prisma/models/admin/wallet.schema.prisma, prisma/models/admin/usage.prisma, prisma/models/dev/exchangeRate.schema.prisma, prisma/models/dev/package.schema.prisma

## 15 · ERD — Admin AI requests

```mermaid
erDiagram
  AdminMember ||--o{ AdminChatRoom : adminMemberId
  AdminMember ||--o{ AdminChatRequest : adminMemberId
  AdminChatRoom ||--o{ AdminChatMessage : roomId
  AdminChatRoom ||--o{ AdminChatRequest : roomId
  AdminChatMessage ||--o| AdminChatRequest : userMessageId
  AdminChatMessage o|--o| AdminChatRequest : assistantMessageId
  AdminMember { UUID id PK
    Boolean aiEnabled }
  AdminChatRoom { UUID id PK
    UUID adminMemberId FK
    String title
    DateTime lastMessageAt }
  AdminChatMessage { UUID id PK
    UUID roomId FK
    String role
    String provider "nullable"
    String model "nullable" }
  AdminChatRequest { UUID id PK
    UUID clientRequestId UK
    UUID adminMemberId FK
    UUID roomId FK
    UUID userMessageId FK,UK
    UUID assistantMessageId FK,UK "nullable"
    String status }
```

- AiUsageEvent.adminMemberId เป็น FK ไป AdminMember แต่ไม่มี usage→AdminChatRequest FK; billing เชื่อมเชิง logic ผ่าน idempotency key ของ request
- Sources: prisma/schema.prisma, prisma/models/admin/adminMember.prisma

## Accuracy notes / documentation drift

ยึด current source รวม uncommitted files ไม่ถือว่า roadmap เป็น implemented behavior. ไม่ยืนยันว่า migrations หรือ feature flags เปิดใน production. การเรียงต่อ user ยังใช้ Map ภายใน process; waiting_admin ไม่ใช่ AI mute. ไม่มี runtime changes หรือ live LINE/AI calls จากการสร้างเอกสารนี้

Current-schema update: Product ใช้ companyId+sku unique ไม่มี tenantId และมี active/compareAtPrice; ProductVariant มี compareAtPrice. อ้างอิง migrations 20261011000000_add_product_compare_at_prices, 20261011010000_product_company_sku, 20261011020000_product_business_fields.
