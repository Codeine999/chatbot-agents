# LINE inbox — แสดงรูปที่ลูกค้าส่งมา (API spec สำหรับ Frontend)

เขียนให้: Frontend ที่เชื่อมหน้าแชทแอดมิน (LINE)

## สรุปสั้น

- ใช้ endpoint เดิม `GET /api/line/conversations/:conversationId/messages` **ไม่มี endpoint ใหม่**
- ข้อความรูปมี `messageType: "IMAGE"` และ `text: null` ห้ามเอา `text` มาแสดง
- รูปอยู่ที่ `mediaUrl` (signed URL เปิดได้ทันทีใน `<img src>`) หรือ `null` ถ้ารูปยังไม่พร้อม
- `mediaUrl` หมดอายุใน **15 นาที** อย่าเก็บไว้ข้ามเซสชันหรือใน localStorage

ที่เห็นเป็นข้อความ `[image]` มาจากสองที่ ไม่ใช่จาก `text` ของข้อความ:

1. `lastMessage` ของรายการห้อง (`GET /api/line/conversations`) ค่าเป็น `"[image]"` เสมอเมื่อ `lastMessageType === "IMAGE"` ให้แสดงเป็นไอคอน/คำว่า "รูปภาพ" แทน
2. หน้าบ้านเช็ก `messageType` ไม่ตรงค่า (ต้องเป็นตัวพิมพ์ใหญ่ `"IMAGE"`)

## Request

```
GET /api/line/conversations/{conversationId}/messages
Authorization: Bearer <admin token>   (เหมือน endpoint แอดมินอื่น)
```

| Query | Type | หมายเหตุ |
|---|---|---|
| `limit` | int 1–100 | ค่าเริ่มต้น 30 (100 ถ้าใช้ `after`) |
| `before` | ISO datetime | โหลดข้อความที่เก่ากว่า (เลื่อนขึ้น) ใช้คู่ `beforeId` |
| `beforeId` | uuid | id ของข้อความที่ `before` ชี้ ป้องกันข้อความเวลาเดียวกันตกหล่น |
| `after` | ISO datetime | โหลดข้อความที่ใหม่กว่า (poll/ต่อท้าย) ใช้คู่ `afterId` |
| `afterId` | uuid | เหมือนข้างบน |

ห้ามส่ง `before` กับ `after` พร้อมกัน (400) ไม่มี body

## Response — 200

เป็น **array** ของข้อความ เรียงเก่า → ใหม่ (ไม่มี wrapper)

### ข้อความรูป (มีรูปพร้อมแล้ว)

```json
{
  "id": "0b6f1c9e-6a53-4f4c-9d3c-0a1f4f1f2a11",
  "conversationId": "95ab26a9-647f-410b-a42b-552c60b11814",
  "lineMemberId": "23347431-870c-47e6-bd6b-ec7ca2de1062",
  "sender": "USER",
  "messageType": "IMAGE",
  "text": null,
  "lineMessageId": "595959595959",
  "mediaUrl": "https://<bucket>.r2.cloudflarestorage.com/line/images/44ed19b0-....png?X-Amz-Algorithm=...&X-Amz-Signature=...",
  "sentStatus": "received",
  "sentByAdminId": null,
  "createdAt": "2026-11-17T02:41:09.000Z"
}
```

(ฟิลด์อื่นเหมือนข้อความปกติ เช่น `replyToken`, `rawEvent`, `deliveryId`)

### ข้อความรูป (ยังไม่มีรูป)

เหมือนข้างบน แต่ `"mediaUrl": null`

### ฟิลด์ที่ใช้แสดงผล

| ฟิลด์ | ค่า | ใช้ทำอะไร |
|---|---|---|
| `sender` | `USER` \| `ADMIN` \| `AI` \| `SYSTEM` | ฝั่งซ้าย/ขวาของบับเบิล |
| `messageType` | `TEXT` \| `IMAGE` \| `STICKER` \| `POSTBACK` | เลือกวิธีแสดงผล (ตัวพิมพ์ใหญ่) |
| `text` | string \| null | ใช้กับ `TEXT` เท่านั้น `IMAGE` เป็น `null` |
| `mediaUrl` | string \| null | URL ของรูป เฉพาะ `IMAGE` |
| `sentByAdminId` | string \| null | **username** ของแอดมิน (ไม่ใช่ uuid) `null` = ลูกค้า/บอท |

## วิธีแสดงผล

```ts
function renderMessage(m: LineMessage) {
  if (m.messageType === 'IMAGE') {
    return m.mediaUrl
      ? <img src={m.mediaUrl} loading="lazy" onError={() => refetchMessages()} />
      : <ImagePlaceholder />;          // ห้ามแสดง m.text / "[image]"
  }
  // TEXT / STICKER / POSTBACK เหมือนเดิม
}
```

### กรณี `mediaUrl = null`

| สาเหตุ | อาการ | วิธีรับมือ |
|---|---|---|
| รูปเพิ่งมาถึง ระบบกำลังดาวน์โหลดจาก LINE (ไม่ได้วัดเวลาจริง คาดว่าไม่กี่วินาที) | หายเองเมื่อโหลดข้อความใหม่ | แสดง "กำลังโหลดรูป…" แล้ว refetch ทุก 2 วินาที สูงสุด ~5 ครั้ง |
| ดาวน์โหลดล้มเหลว, รูปมาจากผู้ให้บริการภายนอก, หรือเป็นรูปก่อนเปิดฟีเจอร์นี้ | ไม่มีรูปถาวร | หลัง retry ครบแล้วยัง `null` ให้แสดง "ไม่สามารถแสดงรูปได้" |

ถ้ามีการรับข้อความใหม่แบบ realtime (socket/poll ด้วย `after`) ข้อความรูปอาจมาก่อนที่ `mediaUrl` พร้อม ให้ถือว่า `null` = ยังไม่พร้อม แล้ว refetch ข้อความนั้นตามตารางข้างบน

### URL หมดอายุ (15 นาที)

- ถ้าเปิดแชทค้างไว้นานกว่า 15 นาที รูปเก่าจะโหลดไม่ได้ (`onError`) ให้ refetch หน้าข้อความปัจจุบันเพื่อรับ URL ใหม่
- อย่าเก็บ `mediaUrl` ใน localStorage/cache ถาวร ให้ถือเป็นค่าชั่วคราวที่มากับ response
- เปิดรูปใน tab ใหม่/ดาวน์โหลดได้ตามปกติ ภายใน 15 นาที

### ข้อควรระวัง

- **อย่าแนบ `Authorization` header** ตอนโหลดรูป (`fetch`/axios ไปที่ `mediaUrl`) URL ลงลายเซ็นไว้แล้ว การแนบ header เพิ่มจะทำให้ R2 ปฏิเสธ ใช้ `<img src>` ตรงๆ ได้เลย
- ถ้าต้องใช้ `fetch` แล้วโหลดเป็น blob ต้องให้ทีม infra เปิด CORS ที่ R2 bucket ให้ origin ของหน้าแอดมิน (ถ้าใช้ `<img>` ไม่ต้อง)
- ลูกค้าส่งหลายรูปติดกันได้ แต่ละรูปเป็นข้อความแยกกัน

## ความต่างจากรายการห้อง

`GET /api/line/conversations` (รูปแบบ `{ items, nextCursor }`) ไม่มี `mediaUrl` ใช้แค่ `lastMessageType` กับ `lastMessage`:

```json
{ "lastMessageType": "IMAGE", "lastMessage": "[image]" }
```

ให้แสดงเป็น "📷 รูปภาพ" เมื่อ `lastMessageType === "IMAGE"`

## พฤติกรรมของบอทเมื่อลูกค้าส่งรูป

- บอท **ไม่ตอบ** และไม่ค้น RAG ห้องเปลี่ยนเป็น `waiting_admin` เพื่อเรียกแอดมิน
- ถ้าห้องรออยู่แล้วหรือแอดมินดูแลอยู่ จะไม่แจ้งเตือนซ้ำ
