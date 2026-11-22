# Admin presence (socket contract)

แสดงว่าใครกำลังเปิดแชทอยู่ (viewing) และใครกำลังพิมพ์ (typing) ในแต่ละห้อง
เป็นการแสดงผลอย่างเดียว ไม่มี assign / lock / บล็อกการส่งข้อความ

## Connection

- Namespace: `admin` (ใช้ socket เดียวกับ `ADMIN_NOTIFICATION`)
- ส่ง JWT ของแอดมินใน `auth.token` หรือ header `Authorization: Bearer ...` (เหมือนเดิม)
- ไม่ผ่าน = socket ถูกตัด. ทุก event ต้องมี admin ที่ผ่านการยืนยันแล้วเท่านั้น

## Events

### Client → Server

ทุก event รับ ack callback และตอบ `{ ok: true, ... }` หรือ `{ ok: false, reason }`

| Event | Payload | Ack |
|---|---|---|
| `presence:sync` | – | `{ ok, rooms: PresenceRoom[] }` ทุกห้องที่มีคนอยู่ใน scope ของแอดมิน |
| `presence:join` | `{ channel, conversationId }` | `{ ok, room: PresenceRoom }` |
| `presence:leave` | `{ channel, conversationId }` | `{ ok }` (เรียกซ้ำได้) |
| `presence:heartbeat` | `{ channel, conversationId }` | `{ ok, room: PresenceRoom }` (ต้อง join ก่อน) |
| `presence:typing` | `{ channel, conversationId, typing: boolean }` | `{ ok }` (ต้อง join ก่อน) |

- `channel`: `LINE` | `APP` | `FACEBOOK`
- `conversationId`: UUID ของห้อง (ห้อง LINE = `lineConversation.id`, ห้อง APP/FACEBOOK = `channelConversation.id`)

### Server → Client

- `presence:update` payload = `PresenceRoom`
  - ถ้า `viewers` ว่าง = ห้องนั้นไม่มีใครเปิดแล้ว ให้ลบออกจากหน้าจอ
  - ส่งไปยังแอดมินทุกคนใน scope เดียวกัน รวมถึงตัวเอง (client กรองตัวเองเอง โดยเทียบ `adminId`)

### Types

```ts
type PresenceChannel = 'LINE' | 'APP' | 'FACEBOOK';

interface PresenceViewer {
  adminId: string;
  name: string;   // ชื่อที่แสดง
  typing: boolean;
}

interface PresenceRoom {
  channel: PresenceChannel;
  conversationId: string;
  viewers: PresenceViewer[]; // เรียงตาม adminId
}

type PresenceFailure =
  | 'DISABLED'        // ปิดฟีเจอร์ด้วย env
  | 'UNAUTHORIZED'    // ไม่มี admin หรือ scope ใช้ไม่ได้ (socket จะถูกตัด)
  | 'INVALID_PAYLOAD' // payload ผิดรูปแบบ
  | 'NOT_FOUND'       // ไม่พบห้องนี้ในบริษัทของแอดมิน
  | 'NOT_JOINED'      // heartbeat/typing ก่อน join
  | 'TOO_MANY_ROOMS'  // เปิดได้สูงสุด 3 ห้องต่อ socket
  | 'UNAVAILABLE';    // ระบบชั่วคราวใช้งานไม่ได้ ลองใหม่ได้
```

## เวลาที่ client ควรใช้

| รายการ | ค่า |
|---|---|
| heartbeat ขณะเปิดห้อง | ทุก ~10 วินาที |
| ส่ง `presence:typing` `typing: true` ซ้ำ | ทุก ~3 วินาที ขณะกำลังพิมพ์ |
| `presence:typing` `typing: false` | ทันทีเมื่อหยุดพิมพ์ / ส่งข้อความแล้ว |
| `presence:sync` | ตอน connect / reconnect และทุก ~30 วินาที |

ค่าที่ server ใช้ (ไม่ต้องส่งเอง):
- ผู้เปิดห้องหมดอายุหลัง 25 วินาทีถ้าไม่มี heartbeat
- สถานะ typing หมดอายุหลัง 6 วินาทีถ้าไม่มีการส่งซ้ำ
- server รับ `typing: true` ได้ไม่เกินหนึ่งครั้งต่อวินาทีต่อห้องต่อ socket (ครั้งที่เกินจะได้ ack `{ ok: true }` แต่ไม่ถูกบันทึก)
- ห้องที่เปิดพร้อมกันได้ต่อ socket สูงสุด 3 ห้อง

## ลำดับการเรียกที่แนะนำ

1. connect
2. `presence:sync` เพื่อแสดงสถานะทุกห้องทันที
3. เปิดแชทห้องใด → `presence:join`
4. ขณะเปิดห้อง: `presence:heartbeat` ทุก ~10 วินาที
5. ขณะพิมพ์: `presence:typing` `{ typing: true }` ทุก ~3 วินาที; หยุดพิมพ์ → `{ typing: false }`
6. ปิดแชท / เปลี่ยนห้อง → `presence:leave`
7. แท็บถูกซ่อน (`document.hidden`) → หยุด heartbeat แล้ว `presence:leave`; กลับมาแสดง → `presence:join` ใหม่

## ข้อจำกัดที่ทราบ

- Socket.IO ไม่ส่งข้ามอินสแตนซ์ (ไม่มี redis-adapter). client ที่ต่อกับอินสแตนซ์อื่นจะเห็นข้อมูลจาก ack ของ heartbeat (ทุก ~10 วินาที สำหรับห้องที่เปิดอยู่) และจาก `presence:sync` (ตอน connect และทุก ~30 วินาที) ไม่ใช่ `presence:update` แบบ realtime
- แอดมินเปิดหลายแท็บ: ปิดแท็บหนึ่ง (`leave`) จะลบแอดมินออกจากห้องนั้น จนกว่าแท็บที่เหลือส่ง heartbeat (ภายใน ~10 วินาที) ซึ่งจะส่ง `presence:update` กลับมาเอง
- แท็บที่ถูก browser หยุดการทำงาน (throttle/ซ่อน) อาจไม่ส่ง heartbeat ทันภายใน 25 วินาที ทำให้ไม่ถูกนับว่ากำลังดู (ตั้งใจ: นับเฉพาะแท็บที่ใช้งานจริง)
- JWT ที่หมดอายุขณะ socket ยังเชื่อมต่ออยู่ยังใช้ได้ (พฤติกรรมเดิมของ gateway)

## เปิด/ปิดฟีเจอร์

- env `ADMIN_PRESENCE_ENABLED`: ค่าเริ่มต้นเปิด; ตั้งเป็น `false` เพื่อปิด
- เมื่อปิด ทุก event ตอบ `{ ok: false, reason: 'DISABLED' }` และไม่แตะ Redis
