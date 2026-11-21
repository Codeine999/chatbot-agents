// Seeds NEW transport products/slots/knowledge through the admin API only.
// Run: node --env-file=.env test/scripts/seed-transport-live.mjs <outDir>
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.AUDIT_BASE ?? 'http://localhost:8080';
const out = process.argv[2];
mkdirSync(out, { recursive: true });

function mint() {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const u = b({ alg: 'HS256', typ: 'JWT' }) + '.' + b({
    sub: process.env.AUDIT_ADMIN_ID, username: 'audit', role: 'dev', companyId: null,
    tokenType: 'admin', iat: now, exp: now + 6 * 3600,
  });
  return u + '.' + createHmac('sha256', process.env.JWT_SECRET).update(u).digest('base64url');
}
const token = mint();
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return json;
}

// Local helper: slot time in Asia/Bangkok. day = 'YYYY-MM-DD', hm = 'HH:mm'
const at = (day, hm) => new Date(`${day}T${hm}:00+07:00`).toISOString();
const plus = (day, hm, minutes) => new Date(Date.parse(`${day}T${hm}:00+07:00`) + minutes * 60000).toISOString();
const slot = (day, hm, dur, capacity, reserved = 0, extra = {}) => ({
  startsAt: at(day, hm), endsAt: plus(day, hm, dur), capacity, reserved, ...extra,
});

const D20 = '2026-11-20', D21 = '2026-11-21', D22 = '2026-11-22', D23 = '2026-11-23',
  D24 = '2026-11-24', D25 = '2026-11-25', D26 = '2026-11-26', D28 = '2026-11-28', D05 = '2026-12-05';

const products = [
  {
    key: 'PTY-BKK', name: 'พัทยา → กรุงเทพฯ',
    aliases: ['พัทยา กรุงเทพ', 'พัทยา กทม', 'pattaya bangkok', 'พัทยาไปกรุงเทพ'],
    description: 'รถตู้/รถประจำทางจากพัทยาไปกรุงเทพฯ (เอกมัย) ใช้เวลาประมาณ 2.5 ชั่วโมง',
    variants: [{
      sku: 'PTY-BKK-STD', price: '316.00',
      meta: { origin: 'พัทยา', destination: 'กรุงเทพฯ', is_regular_bus: true, transfer_points: [] },
      slots: [
        slot(D20, '18:00', 150, 40, 10), slot(D20, '21:00', 150, 40, 40), // 21:00 FULL
        slot(D21, '07:00', 150, 40, 5), slot(D21, '10:00', 150, 40, 0, { status: 'CANCELLED' }),
        slot(D21, '14:00', 150, 40, 12), slot(D21, '17:30', 150, 40, 20, { price: '350.00' }),
        slot(D21, '20:00', 150, 40, 30, { price: '350.00' }),
        slot(D22, '09:00', 150, 40, 8), slot(D22, '13:00', 150, 40, 15),
        slot(D22, '16:00', 150, 40, 38), // 2 left
        slot(D22, '19:00', 150, 40, 22, { price: '350.00' }),
        slot(D25, '08:00', 150, 40, 3),
      ],
    }],
  },
  {
    key: 'BKK-CNX', name: 'กรุงเทพฯ → เชียงใหม่',
    aliases: ['กรุงเทพ เชียงใหม่', 'กทม เชียงใหม่', 'bangkok chiang mai', 'bkk cnx', 'กรุงเทพไปเชียงใหม่', 'เชียงใหม่'],
    description: 'รถทัวร์ข้ามคืนจากกรุงเทพฯ (หมอชิต 2) ไปเชียงใหม่ ใช้เวลาประมาณ 9-10 ชั่วโมง มีชั้น Standard และ VIP',
    variants: [
      {
        sku: 'BKK-CNX-STD', price: '650.00',
        meta: { origin: 'กรุงเทพฯ', destination: 'เชียงใหม่', is_regular_bus: true, transfer_points: [] },
        slots: [
          slot(D20, '20:30', 570, 40, 14), slot(D20, '22:00', 570, 40, 20),
          slot(D21, '20:30', 570, 40, 25), slot(D21, '22:00', 570, 40, 40), // FULL
          slot(D22, '20:30', 570, 40, 9), slot(D25, '22:00', 570, 40, 0),
          slot(D28, '20:30', 570, 40, 2),
        ],
      },
      {
        sku: 'BKK-CNX-VIP', price: '990.00',
        meta: { origin: 'กรุงเทพฯ', destination: 'เชียงใหม่', is_regular_bus: true, transfer_points: [] },
        slots: [
          slot(D20, '21:00', 570, 24, 22), // 2 left
          slot(D21, '21:00', 570, 24, 6), slot(D22, '21:00', 570, 24, 10),
          slot(D23, '21:00', 570, 24, 0, { status: 'CANCELLED' }),
          slot(D28, '21:00', 570, 24, 1, { price: '1090.00' }),
        ],
      },
    ],
  },
  {
    key: 'CNX-BKK', name: 'เชียงใหม่ → กรุงเทพฯ',
    aliases: ['เชียงใหม่ กรุงเทพ', 'เชียงใหม่ กทม', 'chiang mai bangkok', 'cnx bkk'],
    description: 'รถทัวร์ข้ามคืนจากเชียงใหม่ไปกรุงเทพฯ (หมอชิต 2) ใช้เวลาประมาณ 9-10 ชั่วโมง มีชั้น Standard และ VIP',
    variants: [
      {
        sku: 'CNX-BKK-STD', price: '650.00',
        meta: { origin: 'เชียงใหม่', destination: 'กรุงเทพฯ', is_regular_bus: true, transfer_points: [] },
        slots: [
          slot(D20, '19:00', 570, 40, 18), slot(D21, '19:00', 570, 40, 30),
          slot(D21, '21:00', 570, 40, 11), slot(D22, '19:00', 570, 40, 8),
          slot(D24, '19:00', 570, 40, 4),
        ],
      },
      {
        sku: 'CNX-BKK-VIP', price: '990.00',
        meta: { origin: 'เชียงใหม่', destination: 'กรุงเทพฯ', is_regular_bus: true, transfer_points: [] },
        slots: [slot(D21, '20:00', 570, 24, 7), slot(D22, '20:00', 570, 24, 12)],
      },
    ],
  },
  {
    key: 'BKK-RYG', name: 'กรุงเทพฯ → ระยอง',
    aliases: ['กรุงเทพ ระยอง', 'กทม ระยอง', 'bangkok rayong', 'กรุงเทพไประยอง'],
    description: 'รถตู้ประจำทางจากกรุงเทพฯ (เอกมัย) ไประยอง ใช้เวลาประมาณ 3 ชั่วโมง',
    variants: [{
      sku: 'BKK-RYG-STD', price: '280.00',
      meta: { origin: 'กรุงเทพฯ', destination: 'ระยอง', is_regular_bus: true, transfer_points: [] },
      slots: [
        slot(D20, '08:00', 180, 13, 4), slot(D20, '16:00', 180, 13, 10), // 3 left
        slot(D21, '06:30', 180, 13, 2), slot(D21, '09:00', 180, 13, 13), // FULL
        slot(D21, '13:00', 180, 13, 6), slot(D22, '06:30', 180, 13, 0),
        slot(D22, '09:00', 180, 13, 7, { status: 'CLOSED' }),
      ],
    }],
  },
  {
    key: 'BKK-HHN', name: 'กรุงเทพฯ → หัวหิน',
    aliases: ['กรุงเทพ หัวหิน', 'กทม หัวหิน', 'bangkok hua hin', 'กรุงเทพไปหัวหิน'],
    description: 'รถตู้ประจำทางจากกรุงเทพฯ (สายใต้ใหม่) ไปหัวหิน ใช้เวลาประมาณ 3.5 ชั่วโมง',
    variants: [{
      sku: 'BKK-HHN-STD', price: '250.00',
      meta: { origin: 'กรุงเทพฯ', destination: 'หัวหิน', is_regular_bus: true, transfer_points: [] },
      slots: [
        slot(D20, '09:00', 210, 13, 5), slot(D20, '13:00', 210, 13, 9), slot(D20, '17:30', 210, 13, 1),
        slot(D21, '08:00', 210, 13, 3), slot(D21, '12:00', 210, 13, 13),
        slot(D21, '16:00', 210, 13, 8), slot(D22, '08:00', 210, 13, 0),
      ],
    }],
  },
  {
    key: 'BKK-KKC', name: 'กรุงเทพฯ → ขอนแก่น',
    aliases: ['กรุงเทพ ขอนแก่น', 'กทม ขอนแก่น', 'bangkok khon kaen', 'กรุงเทพไปขอนแก่น'],
    description: 'รถทัวร์ข้ามคืนจากกรุงเทพฯ (หมอชิต 2) ไปขอนแก่น ใช้เวลาประมาณ 6-7 ชั่วโมง ยังไม่ระบุจำนวนที่นั่งในระบบ',
    variants: [{
      sku: 'BKK-KKC-STD', price: '480.00', maxPrice: '520.00',
      meta: { origin: 'กรุงเทพฯ', destination: 'ขอนแก่น', is_regular_bus: true, transfer_points: [] },
      slots: [ // capacity unknown (null) on purpose
        slot(D20, '22:00', 400, null, 0), slot(D21, '21:00', 400, null, 0),
        slot(D21, '23:00', 400, null, 0), slot(D22, '21:00', 400, null, 0),
        slot(D26, '21:00', 400, null, 0),
      ],
    }],
  },
  {
    key: 'BKK-KCH', name: 'กรุงเทพฯ → เกาะช้าง',
    aliases: ['กรุงเทพ เกาะช้าง', 'กทม เกาะช้าง', 'bangkok koh chang', 'กรุงเทพไปเกาะช้าง'],
    description: 'รถตู้จากกรุงเทพฯ (เอกมัย) ไปท่าเรือตราด แล้วต่อเรือไปเกาะช้าง ต้องต่อรถ ไม่ใช่รถประจำทาง',
    variants: [{
      sku: 'BKK-KCH-TRN', price: '750.00',
      meta: { origin: 'กรุงเทพฯ', destination: 'เกาะช้าง', is_regular_bus: false, transfer_points: ['ตราด', 'ท่าเรือเลมงอบ'] },
      slots: [
        slot(D21, '06:00', 360, 20, 8), slot(D22, '06:00', 360, 20, 16),
        slot(D23, '06:00', 360, 20, 0, { status: 'CANCELLED' }), slot(D28, '06:00', 360, 20, 3),
      ],
    }],
  },
];

const manifest = { createdAt: new Date().toISOString(), products: [], slots: 0, knowledge: [], note: 'All via admin API' };
for (const p of products) {
  const created = await api('POST', '/api/admin/products', {
    requestId: randomUUID(), name: p.name, aliases: p.aliases, description: p.description,
    category: 'รถโดยสาร', language: 'th', status: 'ACTIVE',
    variants: p.variants.map((v) => ({
      sku: v.sku, price: v.price, maxPrice: v.maxPrice ?? null, meta: v.meta, trackStock: false, currency: 'THB', active: true,
    })),
  });
  const full = created.id ? created : created.data ?? created;
  const detail = await api('GET', `/api/admin/products/${full.id}`);
  const rec = { key: p.key, productId: detail.id, name: p.name, variants: [] };
  for (const v of p.variants) {
    const dv = detail.variants.find((x) => x.sku === v.sku);
    const res = await api('POST', `/api/admin/products/${detail.id}/variants/${dv.id}/slots/bulk`, { requestId: randomUUID(), rows: v.slots });
    manifest.slots += v.slots.length;
    rec.variants.push({ sku: v.sku, variantId: dv.id, price: v.price, slotRows: v.slots.length, bulkResult: typeof res === 'object' ? Object.keys(res) : res });
  }
  manifest.products.push(rec);
  console.log('seeded', p.key, rec.variants.map((v) => v.slotRows));
}

const knowledge = [
  { title: '[TEST] จุดขึ้นรถ', category: 'BOARDING', intentKey: 'boarding_point',
    keywords: ['ขึ้นรถ', 'จุดขึ้นรถ', 'ท่ารถ', 'หมอชิต', 'เอกมัย'],
    questionExamples: ['ขึ้นรถที่ไหน', 'ขึ้นรถตรงไหน', 'จุดขึ้นรถอยู่ที่ไหน', 'ต้องไปรอรถที่ไหน'],
    answer: 'ขึ้นรถได้ที่ท่ารถตามที่ระบุบนตั๋ว เช่น สถานีหมอชิต 2 หรือสถานีเอกมัย กรุณามาถึงก่อนเวลารถออกอย่างน้อย 30 นาทีค่ะ' },
  { title: '[TEST] ช่องทางชำระเงิน', category: 'PAYMENT', intentKey: 'payment_methods',
    keywords: ['ชำระเงิน', 'จ่ายเงิน', 'โอน', 'พร้อมเพย์', 'บัตรเครดิต'],
    questionExamples: ['ชำระเงินยังไง', 'จ่ายเงินช่องทางไหนได้บ้าง', 'จ่ายด้วยบัตรเครดิตได้ไหม', 'โอนเงินได้ไหม'],
    answer: 'ชำระเงินได้ผ่านแอป BKS E-Ticket ด้วยพร้อมเพย์ QR บัตรเครดิต/เดบิต และเคาน์เตอร์เซอร์วิสค่ะ' },
  { title: '[TEST] สัมภาระ', category: 'LUGGAGE', intentKey: 'luggage_policy',
    keywords: ['สัมภาระ', 'กระเป๋า', 'น้ำหนัก', 'ขนของ'],
    questionExamples: ['สัมภาระเอาขึ้นรถได้เท่าไหร่', 'เอากระเป๋าใบใหญ่ขึ้นรถได้ไหม', 'จำกัดน้ำหนักกระเป๋าไหม'],
    answer: 'นำสัมภาระขึ้นรถได้ท่านละไม่เกิน 20 กิโลกรัม และกระเป๋าถือขึ้นรถได้ 1 ใบค่ะ' },
];
for (const k of knowledge) {
  const r = await api('POST', '/api/admin/knowledge-patterns', { ...k, language: 'th', renderMode: 'DIRECT', priority: 0, active: true });
  manifest.knowledge.push({ title: k.title, id: r.id ?? r.data?.id ?? r });
}
writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log('done', manifest.products.length, 'products', manifest.slots, 'slots', manifest.knowledge.length, 'knowledge');
