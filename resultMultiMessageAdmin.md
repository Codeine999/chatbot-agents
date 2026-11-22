# Result: Admin Presence (ใครกำลังดู / กำลังพิมพ์ในแชทนี้)

วันที่: 2026-11-22 · Plan: [docs/plan-admin-presence.md](docs/plan-admin-presence.md) · Frontend contract: [docs/admin-presence-socket.md](docs/admin-presence-socket.md)

## Pain point
บขส. (รอบรถ) ใช้ LINE OA ข้อความเยอะมาก แอดมิน 8 คนช่วยกันตอบ ไม่รู้ว่าลูกค้าคนนี้มีคนเปิดดู/กำลังพิมพ์อยู่ → ตอบซ้ำ
ชื่อคนส่งในข้อความ (`lineDelivery.adminMemberId`) บอกได้แค่หลังส่งแล้ว ไม่ช่วยช่วงก่อนส่ง

## สิ่งที่ได้
ระบบ realtime แสดง **ใครกำลังเปิดห้องนี้** และ **ใครกำลังพิมพ์** หลายคนพร้อมกันได้ ทั้งหน้ารายการห้องและในห้อง
display อย่างเดียว: ไม่ lock, ไม่ assign, ไม่ 409, ไม่แตะ pipeline ตอบแชท / delivery / mute บอท / `unreadCount`, **ไม่มี migration**

### Socket events (namespace `admin` เดิม)
| Client → Server | ผล |
|---|---|
| `presence:sync` | ได้สถานะทุกห้องที่มีคนอยู่ (เรียกตอน connect/reconnect และทุก ~30s) |
| `presence:join` / `leave` | เข้า/ออกห้อง (ตรวจว่าห้องมีจริง, สูงสุด 3 ห้องต่อ socket) |
| `presence:heartbeat` | ต่ออายุทุก ~10s; คืนสถานะห้องนั้น |
| `presence:typing` | `{typing:true}` ซ้ำทุก ~3s ขณะพิมพ์, `false` เมื่อหยุด/ส่งแล้ว |

Server → Client: `presence:update` (`{channel, conversationId, viewers:[{adminId,name,typing}]}`; `viewers` ว่าง = ไม่มีใครอยู่)
สถานะอยู่ใน Redis แบบหมดอายุเอง (viewing 25s, typing 6s) ปิดฟีเจอร์ได้ด้วย `ADMIN_PRESENCE_ENABLED=false`

## ไฟล์
สร้างใหม่: `src/modules/admin/presence/` (constants, types, schemas, service, gateway, module + 2 spec), `src/modules/admin/admin-socket.options.ts`, `docs/admin-presence-socket.md`
แก้เดิม 2 ไฟล์:
- `notification/notification.gateway.ts` — ใช้ options ร่วม และเก็บ `client.data.admin`
- `admin.module.ts` — import `PresenceModule`

## กระบวนการ
1. Sonnet ศึกษา inbox/gateway/Redis/auth เดิม → เขียน plan → audit
2. Audit เจอช่องโหว่ 1 จุด **ก่อนลงมือ**: Nest สร้าง socket server จาก gateway ตัวแรกที่ init แล้วใช้ `cors` ของตัวนั้นเท่านั้น ถ้า `PresenceGateway` init ก่อนจะทำให้ CORS ของ notification เดิมหาย → แก้ plan ให้ทั้งสอง gateway ใช้ `ADMIN_SOCKET_GATEWAY_OPTIONS` ตัวเดียวกัน (ค่าเดิมเป๊ะ) + มี test ยืนยัน
3. Haiku implement ตาม plan → Sonnet ตรวจโค้ดจริงเทียบ plan

## ผลการตรวจ (Sonnet รันเอง)
- `jest src/modules/admin/presence src/modules/admin/notification`: **3 suites, 25 tests ผ่าน** (presence.service 7, presence.gateway 17, notification เดิม 1)
- `eslint` ไฟล์ที่เกี่ยวข้อง: ผ่าน · `tsc`: ไม่มี error ในไฟล์ของงานนี้
- `git status`: แตะเฉพาะไฟล์ในรายการ ไม่มี commit/stash/revert (stash 2 รายการที่เห็นเป็นของเดิมของคุณ)

## คำถามจาก Haiku และคำตอบ
1. `scope` ไม่ต้อง `?? 'legacy'` เพราะ `CommerceScopeService.forAdmin` คืน `companyId` เป็น string เสมอ → **ยอมรับ**
2. throttle ของ typing ไม่ถูกเคลียร์ตอน `typing:false` ทำให้ indicator ช้าได้ ~3s → **เป็น bug จริง Sonnet แก้แล้ว** (`presence.gateway.ts` ลบ `typingAt` ตอน false) + เพิ่ม test
3. `tsc` มี 13 error ในโค้ดที่ commit อยู่แล้ว (`ai-setting-prompt.composer.spec.ts`, `line-ingress.audit.spec.ts`, `test/audit/product-ecom.fixture.ts` ขาด `renderMode`) → นอก scope ไม่ได้แก้ ควรแยกเก็บ

ส่วนเบี่ยงจาก plan ที่ยอมรับ (ทั้งหมดพฤติกรรมเท่าเดิม แค่ตาม lint/type): cast ของ `client.data`, init `rooms`/`typingAt` แบบ lazy, `parseRoom` เป็น public, ใช้ `isStoredChannelKind` ที่มีอยู่แล้วตอน narrow channel

## ข้อจำกัด / ยังไม่ได้ทำ
- **ยังไม่ได้ boot แอปจริงกับ Redis/Socket.IO client** (ไม่มี `socket.io-client` ใน repo, test เป็น unit ด้วย fake) → ก่อน merge ควรลอง connect 2 socket จริงหนึ่งรอบ โดยเฉพาะยืนยันว่าสอง gateway บน namespace `admin` ทำงานคู่กันได้
- ไม่มี redis-adapter: event ไม่ข้ามอินสแตนซ์ ใช้ ack ของ heartbeat + `presence:sync` ทุก ~30s ชดเชย (ถ้ารันหลายอินสแตนซ์ UI อาจช้าสูงสุดราว 10–30s)
- เปิดหลายแท็บ: ปิดแท็บหนึ่งทำให้ชื่อหายจนกว่าแท็บที่เหลือ heartbeat (≤10s)
- ห้อง LINE ตรวจแค่ว่ามีอยู่ (ตาราง `lineConversation` ไม่มี `companyId`; deployment บริษัทเดียวตาม CLAUDE.md)
- **Frontend ยังไม่ได้ทำ** ต้องทำตาม [docs/admin-presence-socket.md](docs/admin-presence-socket.md) (หยุด heartbeat เมื่อ tab ซ่อน, กรองชื่อตัวเอง)
- `cors.origin: '*'` ของ admin socket ขัดกับกฎ "approved origins" ใน `.claude/rules/handoff.md` ไม่ได้แก้ในงานนี้ แต่ตอนนี้แก้ที่เดียวได้ที่ `admin-socket.options.ts`
- JWT หมดอายุขณะ socket ยังต่อ เป็นพฤติกรรมเดิมของ gateway ไม่แก้
