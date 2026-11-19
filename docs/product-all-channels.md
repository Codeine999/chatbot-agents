# Product RAG ทุก channel

เดิม Product RAG ทำงานเฉพาะ LINE เพราะ gate ต้องมี `lineMemberId` และตาราง `commerceTurns` ผูกกับ `lineMember`/`lineConversation` ผลคือแชต App (`app:<contactId>`) ที่ถามว่า "รอบรถไปพัทยา" ตกไป legacy RAG เสมอ

## สิ่งที่เปลี่ยน

| จุด | ก่อน | หลัง |
|---|---|---|
| Gate (`product-retrieval.service.ts`) | ต้องมี `lineMemberId` | `commerceOwner(context)` (`products/rag/commerce-owner.ts`) หา owner จาก `lineMemberId` (LINE) หรือ prefix ของ userId (`app:` / `fb:`) ผ่าน `parseChannelUserId` |
| `commerceTurns` | `lineMemberId`, `conversationId` NOT NULL | ทั้งสองเป็น nullable + คอลัมน์ใหม่ `channelConversationId` (FK → `channelConversations`, RESTRICT) + CHECK `commerceTurns_owner_check` ต้องมี owner ชนิดเดียวพอดี |
| `connectionKey` | `standalone-line` | `CommerceFeatureService.connectionKeyFor(owner)`: LINE = ค่าเดิม, ช่องอื่น = `standalone-<channel>` (`standalone-app`, `standalone-facebook`) |
| ตรวจความเป็นเจ้าของ | LINE member ↔ thread | `CommerceTurnService.ownsConversation`: LINE เหมือนเดิม; ห้อง channel ต้องตรง id + company + channel + contact และ contact ที่ผูก customer ต้อง ACTIVE ไม่ผ่าน = `ForbiddenException` = ข้าม product RAG (ใช้ legacy) |
| Billing context | ใช้ `lineMemberId`/`conversationId` ของ turn | ใช้ค่าของ turn ถ้ามี ไม่งั้นใช้ `channelConversationId` เป็น conversationId (ไม่ใช่ FK) `operationKey` = `usage:product:<turn.id>:<slot>` เหมือนเดิม จึงไม่ bill ซ้ำเมื่อ replay |
| Retention | — | `AppMaintenanceService.purgeProductTurns` ลบ turn+call ของห้อง APP ที่เก่ากว่า `APP_HISTORY_RETENTION_DAYS` ก่อน แล้วค่อยลบห้อง (ห้องที่ยังมี turn ถูกเก็บไว้) เพราะ `input` เก็บสำเนา message ที่ redact แล้ว |

Prompt, planner, search, answer renderer ไม่เปลี่ยน ราคา/ที่นั่งยังมาจาก DB token เท่านั้น

## ข้อจำกัดที่ตั้งใจ

- (แก้แล้ว) Preview หลังบ้านเข้า product ได้ ดูหัวข้อ "Preview หลังบ้าน" ด้านล่าง
- Turn ของ Facebook ยังไม่ถูก purge (ไม่มี retention ฝั่ง Facebook ในระบบ)
- ต้องมี company เดียว (`forLineDeployment`) เหมือนเดิม
- การ derive channel จาก prefix ของ userId เชื่อได้เพราะ adapter เป็นคนสร้าง userId และ DB ตรวจ ownership ของห้องอีกชั้น

## Preview หลังบ้าน

Preview (`admin-userview.service.ts`) ไม่มีห้องถาวร userId คือ `preview:<adminMemberId>:<sessionId>` (UUID ทั้งคู่) จึงเพิ่ม owner ชนิดที่ 3 ชื่อ `PREVIEW`:

- `commerceTurns.previewSessionKey` = `<adminMemberId>:<sessionId>` (ไม่มี FK; CHECK ขยายเป็น "owner ชนิดเดียวจาก 3 ชนิด"), `connectionKey` = `standalone-preview`
- ตรวจ ownership: admin ต้องมีจริง และ `companyId` ตรง company ของ scope (หรือเป็น admin แบบ legacy ที่ companyId เป็น null) ไม่ผ่าน = ข้าม product RAG
- billing: ไม่มี lineMemberId/conversationId เหมือนที่ preview ทำอยู่ (usage row เก็บเป็น UUID ของ record LINE จริง) `operationKey` เป็น `usage:product:<turn.id>:<slot>` replay ไม่ bill ซ้ำ
- retention: `AppMaintenanceService.purgePreviewTurns` ลบ turn+call ของ preview ที่เก่ากว่า 1 วัน (session อยู่ 30 นาที)
- context ต่อเนื่อง (`catalogRefs`) ใช้ Redis context ของ preview เดิม ไม่ต้องแก้

## Migration

`20261120010000_commerce_turn_channels` (แถวเดิมทั้งหมดเป็น LINE จึงผ่าน CHECK) และ `20261120020000_commerce_turn_preview` (คอลัมน์ `previewSessionKey` + ขยาย CHECK) เขียนมือจาก `migrate diff`

## ทดสอบ

- `rag/commerce-owner.spec.ts` (unit: owner, prefix parse, connectionKey)
- `rag/commerce-channel.integration.spec.ts` ต้องตั้ง `COMMERCE_CHANNEL_DB_URL` ชี้ DB ชั่วคราวที่ migrate แล้ว: open/replay, ownership mismatch (ห้องคนอื่น/channel ผิด/company อื่น/ไม่มีห้อง), CHECK constraint, LINE ยังทำงาน, billing context, `retrieveProduct` ของ App user แบบ end-to-end (plan rule-based 0 LLM), retention purge
