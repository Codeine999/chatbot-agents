# Plan: Admin Presence (ใครกำลังดู / กำลังพิมพ์ในแชทนี้) — realtime

Owner of decisions: Sonnet (planner). Implementer: Haiku. **Haiku must not make core decisions.**
If anything below is unclear, contradicts the code, or you want to deviate: STOP that part,
leave it untouched, and list it under `QUESTIONS` in your final report.

## 0. Pain point (เพื่อให้เข้าใจบริบท)

ลูกค้าคือ บขส. (รอบรถ) ใช้ LINE OA ข้อความเยอะมาก มีแอดมินช่วยกันตอบ 8 คน
ปัญหา: แอดมินหลายคนเปิด/ตอบแชทลูกค้าคนเดียวกันซ้ำ เพราะไม่รู้ว่าตอนนี้มีใครเปิดอยู่หรือกำลังพิมพ์อยู่
ข้อความที่ส่งไปแล้วบอกชื่อคนส่งอยู่แล้ว (`lineDelivery.adminMemberId`) แต่ไม่ช่วยในช่วง **ก่อนส่ง**

เป้าหมาย: แสดง realtime ว่า **ใครกำลังเปิดแชทห้องนี้ (viewing)** และ **ใครกำลังพิมพ์ (typing)**
แสดงได้หลายคนพร้อมกัน ทั้งในหน้ารายการห้อง (inbox list) และในห้องแชท

### Non-goals (ห้ามทำ)
- ไม่มี assign/claim เจ้าของห้อง, ไม่มี 409/takeover, ไม่บล็อกการส่งข้อความ
- ไม่แก้ Prisma schema / ไม่มี migration
- ไม่แตะ pipeline ตอบแชท (`MessageProcessorService`, `ChatbotService`), delivery/outbox, mute/pause ของบอท, `unreadCount`
- ไม่ทำ frontend (ทำเฉพาะ backend + เอกสาร contract ให้ frontend)
- ไม่เพิ่ม dependency ใหม่ (เช่น `@socket.io/redis-adapter`)
- ไม่แก้ `cors.origin: '*'` ของ `NotificationGateway` (นอก scope; ให้รายงานไว้เฉย ๆ)

## 1. โครงสร้างเดิมที่เกี่ยวข้อง (อ่านแล้ว ใช้ตามนี้)

- `src/modules/admin/notification/notification.gateway.ts` — Socket.IO namespace `admin`,
  middleware ใน `afterInit` verify JWT ผ่าน `AdminJwtService.authenticate` แต่ **ยังไม่เก็บ admin ไว้ที่ `client.data`**
  `emitAdminNotification` broadcast ทุก socket
- `src/infra/redis/redis.module.ts` — `@Global()` ให้ token `REDIS_CLIENT` (ioredis) inject ได้ทุกที่
  (ตัวอย่าง: `@Inject(REDIS_CLIENT) private readonly redis: Redis` ใน `load-context.service.ts`)
- `src/modules/commerce/commerce-access.module.ts` export `CommerceScopeService`;
  `forAdmin(admin)` คืน `{ companyId }` (throw Forbidden ถ้า company ใช้ไม่ได้)
- `AuthenticatedAdmin` (`src/shared/guards/admin-auth.types.ts`): `id, username, firstName, lastName, role, companyId|null`
- `CHANNEL_KINDS` / `ChatChannelKind` (`src/shared/channel/channel-kinds.ts`): `'LINE' | 'APP' | 'FACEBOOK'`
- ห้อง LINE = `prisma.lineConversation` (ไม่มี companyId, deployment เดียว); ห้อง App/Facebook = `prisma.channelConversation` (`companyId`, `channel`)
- `AdminModule` (`src/modules/admin/admin.module.ts`) รวม module ฝั่ง admin ไว้ใน `imports`
- Tests: jest + ts-jest, ไฟล์ `*.spec.ts` ข้างโค้ด (ดูแบบ `notification-required.spec.ts`: ใช้ fake object `as unknown as X`)
- **ไม่มี `socket.io-client`** ใน node_modules → test gateway ด้วย fake client/fake server, ห้ามติดตั้งเพิ่ม

## 2. ดีไซน์ (ตัดสินใจแล้ว)

### 2.1 สถานะ presence อยู่ใน Redis (ไม่ลง DB)
หลายอินสแตนซ์ใช้ร่วมกันได้ และหมดอายุเอง ไม่ต้อง migration

`scope` = `admin.companyId ?? 'legacy'` (ผลจาก `CommerceScopeService.forAdmin` → ใช้ `companyId` ที่ได้)
`room` = `${channel}:${conversationId}` เช่น `LINE:3f2c...`

| Key | Type | Field → Value | หมายเหตุ |
|---|---|---|---|
| `presence:{scope}:view:{room}` | HASH | `adminId` → JSON `{"n":"<ชื่อ>","x":<expiresAtMs>}` | viewing |
| `presence:{scope}:type:{room}` | HASH | `adminId` → `<expiresAtMs>` | typing |
| `presence:{scope}:rooms` | SET | `room` | ดัชนีห้องที่มีคนอยู่ ใช้ตอน sync |

ค่าคงที่ (export จาก `presence.constants.ts`):
- `VIEW_TTL_MS = 25_000` (client ส่ง heartbeat ทุก ~10s)
- `TYPING_TTL_MS = 6_000` (client ส่ง typing=true ซ้ำทุก ~3s ระหว่างพิมพ์)
- `KEY_TTL_SEC = 60` (EXPIRE ของ HASH ทุกครั้งที่เขียน) · `ROOMS_SET_TTL_SEC = 86_400`
- `MAX_ROOMS_PER_SOCKET = 3`
- `TYPING_MIN_INTERVAL_MS = 1_000` (กัน spam ต่อห้องต่อ socket)

หมดอายุเป็นรายคน (field) จึงเก็บ `expiresAtMs` ในค่า แล้วกรองตอนอ่าน (HASH field ไม่มี TTL ของตัวเอง)

### 2.2 Socket events (namespace `admin`, ใช้ namespace เดิม)

Client → Server (ทุกตัวมี ack คืน `{ ok: true, ... }` หรือ `{ ok: false, reason }`):

| Event | Payload | ผล | Ack |
|---|---|---|---|
| `presence:sync` | – | อ่านสถานะทุกห้องที่มีคนอยู่ใน scope | `{ ok, rooms: PresenceRoom[] }` |
| `presence:join` | `{ channel, conversationId }` | ตรวจว่าห้องมีจริง → บันทึก viewing → broadcast | `{ ok, room: PresenceRoom }` |
| `presence:leave` | `{ channel, conversationId }` | ลบ viewing + typing → broadcast | `{ ok }` |
| `presence:heartbeat` | `{ channel, conversationId }` | ต่ออายุ viewing (ต้อง join แล้ว) ; broadcast **เฉพาะเมื่อเป็นการเพิ่มใหม่** (เช่น เพิ่งหมดอายุ/เปิดแท็บอื่นอยู่) | `{ ok, room }` |
| `presence:typing` | `{ channel, conversationId, typing: boolean }` | ต้อง join แล้ว; true → บันทึก typing, false → ลบ → broadcast | `{ ok }` |

Server → Client (broadcast ไปยัง socket.io room ของ scope เดียวกันเท่านั้น):
- `presence:update` payload = `PresenceRoom`. ถ้า `viewers` ว่าง = ห้องนั้นไม่มีใครอยู่แล้ว (client ลบออกจาก map)

Types (`presence.types.ts`):
```ts
export type PresenceChannel = ChatChannelKind; // 'LINE' | 'APP' | 'FACEBOOK'
export interface PresenceViewer { adminId: string; name: string; typing: boolean }
export interface PresenceRoom { channel: PresenceChannel; conversationId: string; viewers: PresenceViewer[] }
export type PresenceAck<T = object> = ({ ok: true } & T) | { ok: false; reason: PresenceFailure };
export type PresenceFailure = 'DISABLED' | 'UNAUTHORIZED' | 'INVALID_PAYLOAD' | 'NOT_FOUND' | 'NOT_JOINED' | 'TOO_MANY_ROOMS' | 'UNAVAILABLE';
```
`viewers` เรียงตาม `adminId` (เสถียร). `typing=true` ได้เฉพาะคนที่ยังเป็น viewer อยู่
Client กรองตัวเอง (`adminId === me`) เอง; server ส่งทุกคนรวมตัวเอง

### 2.3 การเข้าถึง / ความปลอดภัย
- ทุก event ต้องมี `client.data.admin` (ตั้งโดย middleware ของ `NotificationGateway`, ดู step 1) ไม่มี → ack `UNAUTHORIZED` และ `client.disconnect(true)` (fail closed)
- scope ของ socket: `ensureScope(client)` เรียก `CommerceScopeService.forAdmin(admin)` ครั้งเดียว cache เป็น Promise ใน `client.data.scopeP`
  แล้ว `client.join('presence:' + scope)`. เรียกจาก `handleConnection` และทุก handler (กัน event มาก่อน join เสร็จ). throw → ack `UNAUTHORIZED` + disconnect
- `presence:join` ตรวจห้องมีจริง: `LINE` → `prisma.lineConversation.findUnique({ where:{id}, select:{id:true} })`;
  `APP`/`FACEBOOK` → `prisma.channelConversation.findFirst({ where:{ id, channel, companyId } , select:{id:true} })`. ไม่เจอ → `NOT_FOUND`
  (`channel` ของ Prisma enum `ChatChannel` มีแค่ `APP | FACEBOOK` — narrow ด้วย `CHANNEL_KINDS[channel].store === 'channel'` ก่อนส่งเข้า query ไม่ใช้ `as any`)
- payload ตรวจด้วย zod `safeParse` (ไม่ใช้ class-validator) ผิด → `INVALID_PAYLOAD`
- ห้าม log ชื่อ/ข้อความลูกค้า; log แค่ adminId + room id ระดับ debug
- เปิด/ปิดฟีเจอร์: env `ADMIN_PRESENCE_ENABLED` (default เปิด; ค่า `'false'` = ปิด) ปิดแล้วทุก handler ack `DISABLED` (ไม่แตะ Redis)

### 2.4 Failure isolation (ต้องไม่กระทบของเดิม)
- Redis/Prisma error ใน handler → catch, `logger.warn` (ไม่ใส่ข้อมูลส่วนตัว), ack `UNAVAILABLE`. ห้าม throw ออกจาก handler
- `PresenceModule` ไม่ถูก import โดย module ใดนอกจาก `AdminModule`; ไม่มี module เดิมพึ่ง presence
- การแก้ `NotificationGateway` มีแค่ 2 จุด: เก็บ `client.data.admin = admin` และเปลี่ยน options ของ `@WebSocketGateway` ไปใช้ค่าร่วม (พฤติกรรมเท่าเดิมทุกประการ ดู Step 1)

### 2.5 ข้อจำกัดที่ยอมรับ (ระบุใน doc)
- Socket.IO emit ไม่ข้ามอินสแตนซ์ (ไม่ใช้ redis-adapter): client บนอินสแตนซ์อื่นจะได้ข้อมูลจาก (a) ack ของ `presence:heartbeat` ทุก ~10s สำหรับห้องที่เปิดอยู่ และ (b) `presence:sync` ที่ client ควรเรียกตอน connect/reconnect และทุก ~30s
- แอดมินเปิดหลายแท็บ: ปิดแท็บหนึ่ง (leave) จะลบ admin ออกจากห้อง จนกว่าแท็บที่เหลือส่ง heartbeat (≤10s) — เพราะ heartbeat broadcast เมื่อเป็นการ "เพิ่มใหม่" จึงกลับมาเอง
- Tab ที่ถูก browser throttle/ซ่อน อาจส่ง heartbeat ไม่ทัน 25s → ไม่ถูกนับเป็นกำลังดู (ยอมรับได้ และเป็นผลดี: นับเฉพาะ tab ที่ใช้งานจริง) frontend ควรหยุด heartbeat เมื่อ tab hidden และเรียก leave
- race เล็กน้อย: `snapshot` ลบ field ที่หมดอายุ (HDEL) ขณะที่อีกคำสั่งเพิ่งต่ออายุ field เดียวกัน → viewer หายไปชั่วคราว ≤10s แล้ว heartbeat เพิ่มกลับ (`added=true` → broadcast) ยอมรับได้ ไม่ต้องทำ Lua/transaction
- JWT หมดอายุขณะ socket ยังต่ออยู่ — เป็นพฤติกรรมเดิมของ gateway ไม่แก้ในงานนี้

## 3. ไฟล์ที่ต้องสร้าง/แก้

สร้างใหม่ใน `src/modules/admin/presence/`:
1. `presence.constants.ts`
2. `presence.types.ts`
3. `presence.schemas.ts` (zod)
4. `presence.service.ts` (Redis เท่านั้น, ไม่มี socket)
5. `presence.gateway.ts` (socket + auth + scope + prisma room check)
6. `presence.module.ts`
7. `presence.service.spec.ts`
8. `presence.gateway.spec.ts`

แก้:
0. สร้าง `src/modules/admin/admin-socket.options.ts` — options ร่วมของ gateway ใน namespace `admin`
9. `src/modules/admin/notification/notification.gateway.ts` — เพิ่ม `client.data.admin = admin;` และใช้ options ร่วม
10. `src/modules/admin/admin.module.ts` — เพิ่ม `PresenceModule` ใน `imports`

เอกสาร:
11. `docs/admin-presence-socket.md` — contract สำหรับ frontend (events, payload, ack, ตัวเลขเวลา, ข้อจำกัด)

## 4. ขั้นตอน (ทำตามลำดับ ห้ามข้าม)

### Step 1 — options ร่วม + `notification.gateway.ts`
เหตุผล: Nest สร้าง socket server ครั้งเดียวจาก gateway ตัวแรกที่ init (`SocketServerProvider.scanForSocketServer`) แล้ว gateway ตัวถัดไป
ที่ใช้ port/path เดียวกันจะ **ไม่ใช้ `cors` ของตัวเอง** ถ้า `PresenceGateway` ถูก init ก่อนและไม่มี `cors` ของเดิมจะเสียหาย
จึงต้องให้ทั้งสอง gateway ใช้ options เดียวกันเป๊ะ ไม่ขึ้นกับลำดับ init

1. สร้าง `src/modules/admin/admin-socket.options.ts`:
```ts
import type { GatewayMetadata } from '@nestjs/websockets';

/** Shared by every gateway on the `admin` namespace: Nest builds the socket
 *  server from whichever gateway initialises first, so options must match. */
export const ADMIN_SOCKET_GATEWAY_OPTIONS: GatewayMetadata = {
  namespace: 'admin',
  cors: { origin: '*' },
};
```
   (ค่า `cors.origin: '*'` คัดลอกจากของเดิมทุกประการ ห้ามเปลี่ยนในงานนี้)
2. `notification.gateway.ts`: เปลี่ยน `@WebSocketGateway({ namespace: 'admin', cors: {...} })` เป็น `@WebSocketGateway(ADMIN_SOCKET_GATEWAY_OPTIONS)`
   และใน `authorizeConnection` หลังได้ `admin` ไม่เป็น null ก่อน `next()` เพิ่ม `client.data.admin = admin;`
   ห้ามเปลี่ยนอย่างอื่นในไฟล์นี้. รัน `notification-required.spec.ts` ต้องผ่านเหมือนเดิม
   ถ้า `GatewayMetadata` import ไม่ได้ตาม path นี้ → `QUESTIONS`

### Step 2 — `presence.constants.ts` และ `presence.types.ts`
ตามตารางใน 2.1 และ type ใน 2.2 ตรง ๆ export constant เป็น `as const` หรือ `export const`.
`PresenceChannel = ChatChannelKind` import จาก `../../../shared/channel/channel-kinds`

### Step 3 — `presence.schemas.ts`
```ts
const channel = z.enum(Object.keys(CHANNEL_KINDS) as [ChatChannelKind, ...ChatChannelKind[]]);
export const roomRefSchema = z.object({ channel, conversationId: z.string().uuid() });
export const typingSchema = roomRefSchema.extend({ typing: z.boolean() });
```
export type ของแต่ละ schema ด้วย `z.infer`

### Step 4 — `presence.service.ts`
`@Injectable()`, inject `@Inject(REDIS_CLIENT) redis: Redis`. ใช้คำสั่ง ioredis ตรง ๆ ทีละคำสั่ง (ไม่ใช้ pipeline/multi/Lua)
ใช้ `Date.now()` ทุกที่ที่ต้องการเวลา (เพื่อให้ test mock ได้)

เมธอด (ทุกตัวรับ `scope: string`):
- `roomKey(channel, conversationId): string` → `${channel}:${conversationId}`
- `touchView(scope, room, admin: {id, name}): Promise<{ added: boolean }>`
  `HSET view {id} JSON.stringify({n:name,x:now+VIEW_TTL_MS})` ; `added = (HSET return === 1)`
  แต่ถ้า field เดิมมีอยู่แต่ `x < now` (หมดอายุแล้วแต่ยังไม่ถูกลบ) ให้นับ `added = true` ด้วย → ให้ `HGET` ก่อนเขียน แล้วคำนวณเอง ไม่ต้องพึ่งค่า return ของ HSET
  จากนั้น `EXPIRE view KEY_TTL_SEC`; `SADD rooms room`; `EXPIRE rooms ROOMS_SET_TTL_SEC`
- `removeAdmin(scope, room, adminId): Promise<void>` → `HDEL view`, `HDEL type`
- `setTyping(scope, room, adminId, typing: boolean): Promise<void>` → true: `HSET type {id} String(now+TYPING_TTL_MS)` + `EXPIRE type KEY_TTL_SEC`; false: `HDEL type {id}`
- `snapshot(scope, channel, conversationId): Promise<PresenceRoom>`
  `HGETALL view` + `HGETALL type`. viewer = field ที่ parse JSON ได้และ `x > now` (parse พัง → ข้ามและ HDEL field นั้น)
  `typing` = มีใน type hash และ `Number(value) > now` และเป็น viewer อยู่
  field หมดอายุ → `HDEL` ทิ้ง (best effort, ใช้ `void ...catch(()=>{})` หรือ await แล้ว swallow error)
  เรียงตาม `adminId` (`localeCompare`)
- `snapshotAll(scope): Promise<PresenceRoom[]>`
  `SMEMBERS rooms` → แต่ละ room แยก `channel`/`conversationId` (split ที่ `:` ตัวแรก) → `snapshot`
  ถ้า `viewers` ว่าง → `SREM rooms room` แล้วไม่ใส่ในผลลัพธ์. room ที่ parse ไม่ได้ → `SREM` ทิ้ง

### Step 5 — `presence.gateway.ts`
`@WebSocketGateway(ADMIN_SOCKET_GATEWAY_OPTIONS)` (ตัวเดียวกับ `NotificationGateway`, ดู Step 1)
implements `OnGatewayConnection`, `OnGatewayDisconnect`. `@WebSocketServer() server!: Server`
Constructor (ลำดับนี้ตรงตัว เพื่อให้ test สร้างด้วย `new PresenceGateway(service, scopes, prisma, config)`):
`(presence: PresenceService, scopes: CommerceScopeService, prisma: PrismaService, config: ConfigService)`

การตอบ ack: **return ค่า ack จาก handler** (Nest ส่งค่าที่ return ให้ ack callback ของ client เอง) ห้ามใช้ `client.emit` ตอบ ack
`private readonly enabled = config.get('ADMIN_PRESENCE_ENABLED') !== 'false'` (อ่านใน constructor)

State ใน `client.data` (ประกาศ interface `PresenceSocketData`):
`admin?: AuthenticatedAdmin`, `scopeP?: Promise<string>`, `rooms?: Set<string>`, `typingAt?: Map<string, number>`

helpers (private):
- `adminOf(client)` → `client.data.admin` หรือ undefined
- `ensureScope(client): Promise<string>` — ถ้า `client.data.scopeP` ไม่มี ให้สร้าง:
  `forAdmin(admin).then(s => { const scope = s.companyId ?? 'legacy'; client.join('presence:'+scope); return scope; })`. cache promise
- `guard(client)`: ถ้าไม่ enabled → `{ok:false, reason:'DISABLED'}`; ไม่มี admin → disconnect + `UNAUTHORIZED`
- `broadcast(scope, room: PresenceRoom)` → `this.server.to('presence:'+scope).emit('presence:update', room)`
- `displayName(admin)` → `` `${firstName} ${lastName}`.trim() || username ``

handlers (`@SubscribeMessage`, ทุกตัว `async`, ครอบ try/catch ทั้งตัว → `UNAVAILABLE`, ใช้ `@ConnectedSocket()` + `@MessageBody()`):
- `handleConnection(client)`: ถ้า enabled และมี admin → `void this.ensureScope(client).catch(() => client.disconnect(true))`; init `rooms`/`typingAt`. ถ้าไม่มี admin → `client.disconnect(true)`
- `presence:sync` → `{ ok:true, rooms: await service.snapshotAll(scope) }`
- `presence:join`: parse `roomRefSchema` → ถ้า `rooms.size >= MAX_ROOMS_PER_SOCKET` และห้องนี้ยังไม่อยู่ใน set → `TOO_MANY_ROOMS`
  → ตรวจห้องมีจริง (2.3) → `NOT_FOUND` ถ้าไม่เจอ
  → `touchView` → `rooms.add(room)`
  → **race guard**: ถ้า `client.disconnected` หลัง await ให้ `removeAdmin` แล้ว return `UNAVAILABLE` (กันค้างจนหมด TTL)
  → `snapshot` → `broadcast` → ack `{ok:true, room}`
- `presence:leave`: parse → ถ้าไม่ได้ join ให้ ack `{ok:true}` (idempotent) → `removeAdmin`, `rooms.delete`, `typingAt.delete` → `snapshot` → `broadcast` → ack `{ok:true}`
- `presence:heartbeat`: parse → ต้อง join แล้ว ไม่งั้น `NOT_JOINED` → `touchView` → `snapshot` → ถ้า `added` ให้ `broadcast` → ack `{ok:true, room}`
- `presence:typing`: parse `typingSchema` → ต้อง join แล้ว ไม่งั้น `NOT_JOINED`
  throttle: ถ้า `typing === true` และ `now - typingAt.get(room) < TYPING_MIN_INTERVAL_MS` → ack `{ok:true}` โดยไม่เขียน/ไม่ broadcast
  → `setTyping` → ถ้า typing=true บันทึก `typingAt` → `snapshot` → `broadcast` → ack `{ok:true}`
- `handleDisconnect(client)`: ถ้าไม่ enabled หรือไม่มี admin/scope ให้ return. วนทุก room ใน `rooms`: `removeAdmin` → `snapshot` → `broadcast` (แต่ละห้อง try/catch แยก) แล้วเคลียร์ `rooms`

ห้ามเรียกใช้ `client.data.scopeP` ที่ยังไม่ถูกสร้างโดยไม่ผ่าน `ensureScope`

### Step 6 — `presence.module.ts`
```ts
@Module({
  imports: [PrismaModule, CommerceAccessModule],
  providers: [PresenceService, PresenceGateway],
})
export class PresenceModule {}
```
(`REDIS_CLIENT` และ `ConfigService` เป็น global อยู่แล้ว; `AuthModule` global) ตรวจ path import ของ `PrismaModule` ให้ตรงกับ module อื่นใน `src/modules/admin`

### Step 7 — `admin.module.ts`
เพิ่ม `PresenceModule` ท้ายรายการ `imports` พร้อม import statement. ห้ามแก้อย่างอื่น

### Step 8 — Tests
`presence.service.spec.ts` — ใช้ fake Redis ในไฟล์ test (class เก็บ Map: hset/hget/hdel/hgetall/expire/sadd/srem/smembers) และ `jest.spyOn(Date, 'now')` คุมเวลา. ครอบคลุม:
1. touchView ครั้งแรก `added=true`, ครั้งที่สองก่อนหมดอายุ `added=false`, หลัง `VIEW_TTL_MS` `added=true`
2. snapshot คืนหลาย viewer เรียงตาม adminId
3. viewer หมดอายุถูกกรองและถูก HDEL
4. typing หมดอายุหลัง `TYPING_TTL_MS`; typing ของคนที่ไม่ใช่ viewer ไม่นับ
5. removeAdmin ลบทั้ง view และ type
6. snapshotAll ข้ามและ SREM ห้องว่าง; scope ต่างกันไม่ปนกัน
7. ค่า JSON เสียใน view hash ไม่ทำให้ throw

`presence.gateway.spec.ts` — fake `PresenceService` (jest.fn), fake `CommerceScopeService.forAdmin`, fake `PrismaService`, fake `ConfigService`, fake `server.to().emit`, fake client (`data`, `join`, `disconnect`, `disconnected`). ครอบคลุม:
0. `ADMIN_SOCKET_GATEWAY_OPTIONS` ถูกใช้ทั้ง `NotificationGateway` และ `PresenceGateway` (อ่าน metadata ด้วย `Reflect.getMetadata('websockets:gateway_options', Class)` เทียบเท่ากัน)
1. ไม่มี `client.data.admin` → ack `UNAUTHORIZED` และ `disconnect(true)`
2. `ADMIN_PRESENCE_ENABLED='false'` → `DISABLED` และไม่เรียก service
3. payload ผิด (channel ไม่รู้จัก / conversationId ไม่ใช่ uuid) → `INVALID_PAYLOAD`
4. join ห้อง LINE ที่ไม่มี → `NOT_FOUND`; join สำเร็จ → เรียก touchView + broadcast `presence:update` ไป `presence:<scope>` + ack มี room
5. join ห้องที่ 4 → `TOO_MANY_ROOMS`
6. heartbeat/typing ก่อน join → `NOT_JOINED`
7. heartbeat ที่ `added=false` ไม่ broadcast; `added=true` broadcast
8. typing=true ซ้ำภายใน 1s ถูก throttle (setTyping เรียกครั้งเดียว)
9. leave idempotent; disconnect เรียก removeAdmin ทุกห้องที่ join และ broadcast
10. service throw → ack `UNAVAILABLE` และ handler ไม่ throw
11. join แล้ว client หลุดระหว่าง await (`disconnected=true`) → removeAdmin ถูกเรียก

### Step 9 — เอกสาร `docs/admin-presence-socket.md`
เขียนสั้น ๆ เป็นภาษาไทยผสมอังกฤษได้: ตาราง event/payload/ack, ตัวเลขเวลาที่ client ควรใช้ (heartbeat 10s, typing resend 3s, sync 30s),
ลำดับเรียกที่แนะนำ (connect → sync → เปิดห้อง join → heartbeat → typing → ปิดห้อง leave), ข้อจำกัดข้อ 2.5, env flag

### Step 10 — ตรวจสอบ (ต้องรันและแนบผลจริง)
```
npx tsc --noEmit -p tsconfig.json
npx jest src/modules/admin/presence src/modules/admin/notification
npx eslint "src/modules/admin/presence/**/*.ts" src/modules/admin/notification/notification.gateway.ts src/modules/admin/admin.module.ts
```
(อย่าใช้ `--fix` กับทั้งโปรเจกต์ — worktree มีไฟล์ที่ยังไม่ commit ของคนอื่นเยอะ ห้ามแตะไฟล์นอกรายการ)
ถ้า `tsc` พังเพราะไฟล์อื่นที่ไม่ใช่ของเรา ให้รายงานว่าพังที่ไฟล์ไหน อย่าแก้

## 5. กฎการทำงานสำหรับ Haiku
- แก้/สร้างเฉพาะไฟล์ในข้อ 3 เท่านั้น. ห้าม `git add/commit/stash/checkout`, ห้ามแตะ `prisma/`, ห้าม `npm install`
- worktree มีการแก้ไขที่ยังไม่ commit ของไฟล์อื่นอยู่มาก — ห้ามแก้หรือ revert
- ห้ามตัดสินใจเรื่อง behavior/ชื่อ event/ค่าคงที่/key ของ Redis เอง ใช้ตามแผน ถ้าไม่ชัด → `QUESTIONS`
- สถานการณ์ที่ต้องหยุดแล้วถาม: (a) สอง gateway บน namespace เดียวกันทำงานไม่ตรงที่คาด / cors ชนกัน (b) `forAdmin` หรือ import ไม่ตรงโครงสร้างจริง (c) test ใดผ่านไม่ได้โดยไม่เปลี่ยน behavior ในแผน (d) อยากเพิ่มอะไรนอก scope
- รายงานสุดท้ายต้องมี: รายการไฟล์ที่เปลี่ยน, ผลคำสั่งใน Step 10 (ตัดมาเฉพาะส่วนสำคัญ), `QUESTIONS`, และ "สิ่งที่ไม่ได้ทำ/ข้าม" พร้อมเหตุผล
