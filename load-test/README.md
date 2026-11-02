# Load test (k6)

สคริปต์: [`load.js`](./load.js) ใช้ [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) ยิงโหลดใส่ API จริงของระบบ

## ทดสอบอะไร

| Scenario | Endpoint | ทำอะไร |
|---|---|---|
| `chat` (หลัก) | `POST /api/app/v1/sessions` → `POST /api/app/v1/messages` (+ `GET /api/app/v1/messages` บางครั้ง) | 1 VU = ลูกค้า 1 คน สร้าง guest session ครั้งเดียว แล้วถามคำถามวนไปเรื่อย ๆ พร้อม think time 3–10 วินาที ทุกข้อความวิ่งผ่าน pipeline จริง (intent → RAG → AI) แบบเดียวกับ LINE |
| `admin` (เลือกได้) | `GET` หน้า dashboard เช่น notifications, wallet, conversations, knowledge count | จำลองแอดมินเปิด dashboard ค้างไว้ ไม่มี AI จำนวน VU = 5% ของ chat |

**ไม่ทดสอบ LINE webhook** เพราะ worker จะตอบกลับผ่าน LINE API จริง = ส่งข้อความหาลูกค้าจริง และกินโควตา push

## ⚠️ ก่อนรัน

1. **รันกับ staging ไม่ใช่ production** ทุกข้อความเรียก AI จริงและหักเครดิตจาก wallet ของบริษัท
   ประมาณค่าใช้จ่าย: profile `load` รวม ≈ 4,450 VU-นาที × ~6 ข้อความ/นาที ≈ **2.5–3 หมื่นข้อความ** (`stress` มากกว่านี้ราว 2 เท่า)
   ถ้าอยากลดค่าใช้จ่าย ใช้ `SCALE=0.25` หรือชี้ staging ไปที่โมเดลถูก ๆ
2. **เปิด App Message API** บน target: `APP_MESSAGE_ENABLED=true` + `APP_IP_HASH_SALT` (≥16 ตัว) ไม่งั้นได้ 404
3. **Rate limit ต่อ IP** k6 ยิงจากเครื่องเดียว = IP เดียว ระบบจะมองเป็นลูกค้าคนเดียวแล้วตอบ 429 ทันที
   (30 ข้อความ/นาที/IP, 30 session/ชม./IP, session active สูงสุด 50 ต่อ IP ซึ่งตัวสุดท้ายฝังในโค้ด)
   ทางแก้บน staging:
   - ให้ k6 ต่อตรงเข้า app (ไม่ผ่าน nginx) ตั้ง `TRUST_PROXY_HOPS=1` บน app แล้วรัน k6 ด้วย `-e SPOOF_IP=1` สคริปต์จะใส่ `X-Forwarded-For` แยกต่อ VU ทำให้ทุก VU เป็นคนละ IP เหมือนลูกค้าจริง
   - และยกเพดานรวมต่อวัน `APP_MSG_DAILY_TOTAL=0` (ไม่จำกัด) ถ้าจะรัน profile ใหญ่
   - **ห้ามตั้งแบบนี้บน production**
4. เติมเครดิตใน wallet ของ staging ให้พอ ไม่งั้นข้อความจะถูกตอบแบบ budget หมด ผลจะไม่สะท้อนความจริง

## วิธีรัน

```bash
# ติดตั้ง k6: https://grafana.com/docs/k6/latest/set-up/install-k6/
# macOS: brew install k6   |   Windows: winget install k6   |   Docker: grafana/k6

# 1) Smoke: 2 VU 1–2 นาที เช็คว่าทุก endpoint ใช้งานได้ (รันทุกครั้งก่อน profile ใหญ่)
k6 run -e BASE_URL=https://staging.example.com -e PROFILE=smoke load-test/load.js

# 2) Load: ไต่ 50 → 200 → 400 VU ค้างแต่ละขั้น (~21 นาที) = ช่วงพีคที่คาดไว้
k6 run -e BASE_URL=https://staging.example.com -e PROFILE=load -e SPOOF_IP=1 load-test/load.js

# 3) Stress: ไต่ต่อไปถึง 1000 VU (~20 นาที) เพื่อหาจุดที่ระบบเริ่มพัง
k6 run -e BASE_URL=https://staging.example.com -e PROFILE=stress -e SPOOF_IP=1 load-test/load.js

# พร้อม scenario admin (ใช้ token ที่มี หรือให้สคริปต์ login เอง)
k6 run -e BASE_URL=... -e PROFILE=load -e ADMIN_USERNAME=loadtest -e ADMIN_PASSWORD=*** load-test/load.js
k6 run -e BASE_URL=... -e PROFILE=load -e ADMIN_TOKEN=eyJ... load-test/load.js

# เก็บผลเป็นไฟล์ไว้เทียบรอบต่อไป
k6 run -e BASE_URL=... -e PROFILE=load --summary-export=load-test/results/load-$(date +%F).json load-test/load.js
```

Profile อื่น: `spike` (กระโดดจาก 20 → 400 ใน 30 วิ เหมือนหลังส่ง broadcast) และ `soak` (100 VU ค้าง 1 ชม. หา memory leak / connection pool ตัน)

### ตัวแปร `-e`

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `BASE_URL` | `http://localhost:3000` | URL ของ API |
| `PROFILE` | `smoke` | `smoke` / `load` / `stress` / `spike` / `soak` |
| `SCALE` | `1` | คูณจำนวน VU ทุกขั้น เช่น `0.25` = รันแบบย่อส่วน |
| `SPOOF_IP` | ปิด | `1` = ใส่ `X-Forwarded-For` แยกต่อ VU (ดูข้อ 3 ด้านบน) |
| `THINK_MIN` / `THINK_MAX` | `3` / `10` | think time ระหว่างข้อความ (วินาที) |
| `CHAT_P95_MS` | `8000` | เกณฑ์ p95 ของการส่งข้อความ (รอคำตอบ AI) |
| `API_P95_MS` | `500` | เกณฑ์ p95 ของ endpoint ทั่วไป (session, history, dashboard) |
| `MAX_ERROR_RATE` | `0.01` | error rate สูงสุด (1%) |
| `ADMIN_TOKEN` หรือ `ADMIN_USERNAME` + `ADMIN_PASSWORD` | – | เปิด scenario `admin` |
| `ADMIN_RATIO` | `0.05` | จำนวน VU แอดมินเทียบกับ chat |

แก้คำถามตัวอย่างได้ที่ `QUESTIONS` ใน `load.js` ให้ตรงกับร้าน (ควรมีทั้งคำถามที่ตอบจาก knowledge และคำถามที่ต้องให้ AI คิด)

## Thresholds (ผ่าน/ไม่ผ่าน)

| Metric | เกณฑ์ | ทำไม |
|---|---|---|
| `http_req_failed` | `< 1%` | รวมทุก request ที่ได้ 4xx/5xx (รวม 429 ด้วย) |
| `http_req_duration{kind:chat}` | p95 `< 8s`, p99 `< 16s` | การส่งข้อความรอคำตอบ AI ในคำขอเดียว จึงแยกเกณฑ์ |
| `http_req_duration{kind:api}` | p95 `< 500ms` | endpoint ที่ไม่มี AI ต้องเร็ว |
| `checks` | `> 99%` | response ถูกรูปแบบ (status + body) |

k6 จะขึ้น ✓/✗ ข้างแต่ละ threshold ตอนจบ และ exit code ≠ 0 ถ้ามีข้อไหนไม่ผ่าน (ใช้ใน CI ได้)

Metric เพิ่มเติมที่สคริปต์เก็บ:

- `chat_answer_duration` เวลาตั้งแต่ส่งข้อความจนได้คำตอบ (เฉพาะที่สำเร็จ)
- `chat_answered` สัดส่วนข้อความที่บอทตอบ (ที่เหลือคือ NO_REPLY / handoff)
- `rate_limited` จำนวน 429 ถ้าเยอะ = โดน rate limit ของเราเอง ไม่ใช่ server ล่ม (ลืม `SPOOF_IP` หรือยังไม่ยกเพดาน)
- `turn_unavailable` จำนวน 503 = turn ล้ม (AI provider timeout/error, DB)
- `conversation_busy` จำนวน 409 = ข้อความก่อนหน้าของคนเดิมยังตอบไม่เสร็จ

## อ่านผลเป็น "รับผู้ใช้พร้อมกันได้กี่คน"

1. **ดูที่ stage ไหนเริ่มพัง** ใน profile `load`/`stress` จำนวน VU จะไต่เป็นขั้น ดู output ระหว่างรัน (หรือ export ไป Grafana ด้วย `--out`) ว่าที่ VU เท่าไรที่:
   - p95 ของ `kind:chat` เกิน 8s หรือ
   - `http_req_failed` เกิน 1% หรือ `turn_unavailable` เริ่มขึ้น
   ขั้นสุดท้ายที่ยังผ่านทุกเกณฑ์ = **ความจุ (capacity) ที่รับได้**
   เช่น 200 VU ผ่าน แต่ 400 VU p95 = 14s → ความจุอยู่ระหว่าง 200–400 รันซ้ำแบบละเอียดด้วย `SCALE` (เช่น `SCALE=0.75` ให้ peak เป็น 300) เพื่อบีบช่วง
2. **VU ≠ จำนวนคนที่แชทพร้อมกันพอดีเป๊ะ** 1 VU = ลูกค้า 1 คนที่คุยต่อเนื่อง ส่ง 1 ข้อความทุก ~(เวลาตอบ + think time) ถ้าลูกค้าจริงพักนานกว่านี้ ระบบจะรับคนได้มากกว่าตัวเลข VU
   แปลงเป็นข้อความต่อวินาทีด้วยค่า `http_reqs` ของ `POST /api/app/v1/messages` ในรายงาน แล้วเทียบกับ traffic จริง:
   `ผู้ใช้พร้อมกันที่รับได้ ≈ throughput สูงสุดที่ยังผ่านเกณฑ์ (msg/s) × ระยะห่างเฉลี่ยระหว่างข้อความของลูกค้าจริง (s)`
   เช่น รับได้ 25 msg/s และลูกค้าจริงส่งทุก 20 วินาที → ≈ 500 คนพร้อมกัน
3. **คอขวดอยู่ไหน** ระหว่างรันให้ดูฝั่ง server ด้วย: CPU/RAM ของ app, connection ของ Postgres, Redis, และ latency/429 จาก AI provider
   ถ้า `kind:api` ยังเร็วแต่ `kind:chat` ช้า → คอขวดคือ AI provider/RAG (scale app เพิ่มไม่ช่วย ต้องดู rate limit ของ provider หรือ cache คำตอบ)
   ถ้า `kind:api` ช้าด้วย → app/DB เต็ม (เพิ่ม instance, ดู pool, index)
4. **เทียบผลก่อน/หลังแก้** เก็บ `--summary-export` ทุกรอบไว้ใน `load-test/results/` แล้วเทียบ p95 และ throughput ที่ VU เดียวกัน

## ข้อควรรู้

- ทุก VU สร้าง guest session จริงในฐานข้อมูล (`appGuestSessions`, `channelContacts`) ชื่อ `k6-vu-<n>` ห้องและข้อความถูกลบเองตาม `APP_HISTORY_RETENTION_DAYS` ส่วน session หมดอายุตาม `APP_SESSION_TTL_DAYS` ถ้าไม่อยากรอให้เคลียร์ staging หลังทดสอบ
- ข้อความทดสอบจะขึ้นใน inbox ของแอดมิน (App conversations) บน staging
- ความเร็วของ AI provider แปรผันตามเวลา รันซ้ำอย่างน้อย 2 รอบก่อนสรุปตัวเลข

## ทดสอบแบบจำกัดงบ (`budget.js`)

ใช้ตอบคำถามว่า "ผู้ใช้พร้อมกันกี่คนที่ยังได้คำตอบภายใน ~1 วินาที" โดยมีเพดานจำนวนข้อความตายตัว

```bash
k6 run -e BASE_URL=https://api.keela-agent.online load-test/budget.js
```

- smoke 5 ข้อความ แล้วไล่เป็นขั้น 5 → 10 → 15 → 20 VU ขั้นละ 140 วินาที รวมประมาณ 10 นาที
- แต่ละขั้นกำหนดจำนวนข้อความตายตัว ผลรวมไม่มีทางเกิน `MAX_MESSAGES` (ค่าเริ่มต้น 1300) ไม่ว่า server จะตอบเร็วแค่ไหน
- ค่าเริ่มต้น `RATE_PER_MIN=25` จะส่งทั้งหมดไม่เกิน **195 ข้อความ** (ทุกช่วง 60 วินาทีไม่เกิน ~26 ข้อความ) เพื่อไม่ให้เกิน rate limit 30 ข้อความ/นาที/IP ของ production ถ้าอยากใช้งบเต็ม 1300 ข้อความ ต้องยก `APP_MSG_PER_IP_MIN` บน server ขึ้นชั่วคราว (เช่น 250) แล้วรันด้วย `-e RATE_PER_MIN=200`
- ถ้าเจอ 429 แม้แต่ครั้งเดียว สคริปต์จะหยุดทันที เพราะ IP ที่ชน limit ซ้ำ ๆ จะโดน ban strike
- ทุก VU ใช้ guest session เดียวตลอดการรัน รวมไม่เกิน 20 session เพราะ server ยอมให้สร้างได้แค่ 30 session ต่อชั่วโมงต่อ IP (`APP_SESSION_CREATE_PER_IP_HOUR`) ดังนั้นห้ามรันซ้ำภายใน 1 ชั่วโมงจาก IP เดิม
- ตอนจบจะพิมพ์ตารางของแต่ละขั้น (จำนวนข้อความ, ok%, p50, p95, max, ผ่านเป้าหรือไม่) และบันทึกผลเต็มไว้ที่ `budget-summary.json`
- ตัวแปรอื่น: `TARGET_MS` (1000), `STEPS` (`5,10,15,20`), `STEP_SEC` (140)
