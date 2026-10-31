# Admin inbox API (current)

ใช้ร่วมกันทั้ง LINE และ App · ทุก endpoint ต้องใช้ admin JWT (ทุก role) · App ถูกจำกัดตามบริษัทของแอดมิน
โค้ดร่วมอยู่ที่ `src/shared/inbox/inbox-page.ts`

| | LINE | App |
|---|---|---|
| prefix | `/api/line/conversations` (alias `/api/conversations`) | `/api/admin/app-conversations` |
| item ในรายการ | `LineConversation` + `lineMember` + `botMode` + `botMuteUntil` | `{ id, channel, status, lastMessage, lastMessageAt, unreadCount, createdAt, contact }` |
| ค้นหา `q` | `lineMember.displayName` | `contact.displayName` |

## รายการห้อง — `GET {prefix}`

ลำดับ: ห้อง `waiting_admin` ทั้งหมดก่อน แล้วห้องอื่น · ในแต่ละกลุ่มเรียง `lastMessageAt desc, id desc`

| query | ค่า | หมายเหตุ |
|---|---|---|
| `limit` | 1–100 (default 30) | |
| `cursor` | string | ค่า `nextCursor` จากหน้าก่อน · ห้ามสร้างเอง · ผิดรูปแบบ → 400 |
| `status` | `waiting_admin` \| `open` | |
| `unread` | `true` | เฉพาะห้องที่ `unreadCount > 0` |
| `q` | 1–100 ตัว | ชื่อลูกค้า แบบ contains ไม่สนตัวพิมพ์ |

- **ส่ง query ตัวใดตัวหนึ่ง** → `{ items, nextCursor }` · `nextCursor: null` = หมดแล้ว
- **ไม่ส่ง query เลย** → array แบบเดิม (LINE = ทุกห้อง, App = 200 ห้องล่าสุด) **เลิกใช้ได้เมื่อ dashboard ย้ายครบ แล้วจะลบออก**
- เปลี่ยน filter หรือคำค้น = เริ่มใหม่โดยไม่ส่ง `cursor`
- รายการเปลี่ยนตลอด (ข้อความใหม่ทำให้ห้องเด้งขึ้นบนสุด, status เปลี่ยน) ระหว่างเลื่อนหน้า ห้องอาจซ้ำหรือหลุด
  ให้ dashboard **รวมรายการด้วย `id`** และรีเฟรชหน้าแรกเมื่อมีข้อความใหม่

## ตัวเลขบน tab — `GET {prefix}/counts`

`{ all, unread, waitingAdmin }` · `unread` = จำนวนห้องที่ยังมีข้อความไม่ได้อ่าน (ไม่ใช่จำนวนข้อความ) · ไม่ขึ้นกับ `q`

## อ่านแล้ว — `POST {prefix}/:id/read`

ตั้ง `unreadCount = 0` → `{ id, unreadCount: 0 }` · เรียกซ้ำได้ · ไม่พบห้อง (หรือห้องของบริษัทอื่น) → 404

dashboard ต้องเรียกเอง: **ตอนเปิดห้อง** และ **ตอนมีข้อความใหม่เข้าห้องที่เปิดอยู่** · ไม่แตะ `AdminNotification`
(ถ้าต้องการให้ notification หายด้วย ยังต้องเรียก `PATCH /api/admin/notifications/conversation/:id/read` แยก)

## ประวัติข้อความ — `GET {prefix}/:id/messages`

คืน array เรียงเก่า→ใหม่เหมือนเดิม · `limit` 1–100 (default 30, หรือ 100 เมื่อมี `after`) · ใช้ `before` กับ `after` พร้อมกันไม่ได้

| ใช้ทำ | query |
|---|---|
| โหลดครั้งแรก | (ไม่ส่ง) → ข้อความล่าสุด |
| เลื่อนขึ้นโหลดเก่ากว่า | `before=<createdAt ของข้อความเก่าสุดที่มี>&beforeId=<id ของข้อความนั้น>` |
| poll ข้อความใหม่ | `after=<createdAt ของข้อความใหม่สุดที่มี>&afterId=<id ของข้อความนั้น>` |

- ได้น้อยกว่า `limit` ตอนเลื่อนขึ้น = ไม่มีข้อความเก่ากว่าแล้ว
- **ต้องส่ง `beforeId`/`afterId` ด้วย** · ถ้าส่งแค่วันที่ ข้อความที่บันทึกในมิลลิวินาทีเดียวกันตรงรอยต่อหน้าจะหาย (ทดสอบแล้วว่าเกิดจริง) ·
  แบบวันที่อย่างเดียวยังรับอยู่เพื่อไม่ให้ dashboard เดิมพัง
- `beforeId` ต้องมาคู่กับ `before`, `afterId` คู่กับ `after` → ไม่งั้น 400
