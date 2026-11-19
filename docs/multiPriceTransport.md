# ออกแบบราคาหลายแบบต่อรอบรถ (Transport multi-price)

> 20 พ.ย. 2026 · branch `decisionLog` · สถานะ: **ลงมือแล้ว ยังไม่ commit** (ผลและตัวเลขวัดอยู่ใน §11) · อ่านคู่กับ `CLAUDE.md` §6 (Product RAG) และ preset `products/attributes/presets/transport.preset.ts`
> เป้าหมาย: รอบรถแต่ละรอบมีราคาของตัวเองได้ โดยบางรอบมี **ราคาแน่นอน** (316) และบางรอบมี **ช่วงราคาที่ยังไม่แน่นอน** (316–416) บอทต้องตอบตรงตามนั้น และตัวเลขทุกตัวต้องมาจาก DB ผ่าน token (ไม่ให้ LLM พิมพ์ราคาเอง)

---

## 0. สรุปสั้น

- เพิ่มคอลัมน์ `maxPrice` ที่ `productVariants` และเพิ่ม `price` + `maxPrice` ที่ `productSlots`
- **ราคาของรอบ = ราคาของ slot ถ้ามี ไม่งั้นใช้ของ variant** แบบ all-or-nothing (ไม่ผสม `slot.price` กับ `variant.maxPrice`)
- ความหมายของคู่ค่า: มี `price` อย่างเดียว = **ราคาแน่นอน** · มีทั้ง `price` และ `maxPrice` = **ช่วงราคาที่ยังไม่แน่นอน** · ไม่มีเลย = ยังไม่ได้ระบุราคา
- **ไม่เพิ่ม token ใหม่** ให้ `{{eN.price}}` render เป็น "316.00 บาท" หรือ "316.00–416.00 บาท (ราคาโดยประมาณ …)" ตามชนิดราคาเอง LLM จึงหยิบ token ผิดไม่ได้ และคำเตือนว่าไม่แน่นอนติดไปกับตัวเลขเสมอ
- คำถามราคาที่ไม่ระบุรอบ ("กรุงเทพไปพัทยากี่บาท") ตอบเป็นช่วงรวมของรอบที่ยังเปิดอยู่ในช่วง `horizonDays` แล้วชวนระบุวันและเวลา
- LLM เพิ่ม = 0 call · embedding เพิ่ม = 0 (ราคาไม่เข้า vector อยู่แล้ว) · ไม่ต้อง reindex

---

## 1. กรณีที่ต้องรองรับ

| # | สถานการณ์ | ข้อมูลที่เก็บ | ลูกค้าเห็น |
|---|---|---|---|
| P1 | ทุกรอบของเส้นทางราคาเดียวกัน | `variant.price=180` | 180.00 บาท |
| P2 | ทุกรอบยังไม่แน่นอน | `variant.price=316, variant.maxPrice=416` | 316.00–416.00 บาท (ราคาโดยประมาณ) |
| P3 | รอบนี้รู้ราคาแน่นอน ต่างจากราคาปกติ | `slot.price=350` | รอบ 17:30 · 350.00 บาท |
| P4 | รอบนี้ยังไม่แน่นอน | `slot.price=316, slot.maxPrice=416` | รอบ 09:00 · 316.00–416.00 บาท (ราคาโดยประมาณ) |
| P5 | รอบนี้เคยไม่แน่นอน แล้วยืนยันราคาแล้ว | PATCH `slot.maxPrice=null` | รอบ 09:00 · 316.00 บาท |
| P6 | ไม่ได้ระบุราคาเลย | ทุกช่องเป็น `null` | ยังไม่ได้ระบุราคา (พฤติกรรมเดิม) |
| P7 | ถามราคาโดยไม่ระบุรอบ และแต่ละรอบราคาต่างกัน | ผสม P1–P4 | ราคา 316.00–456.00 บาท ขึ้นกับรอบ (บางรอบเป็นราคาโดยประมาณ) ต้องการเดินทางวันไหนคะ |

---

## 2. สิ่งที่มีอยู่ตอนนี้ และจุดที่ขวางอยู่

| ชิ้น | ที่ | สถานะ |
|---|---|---|
| ราคาอยู่ที่ variant ค่าเดียว | `prisma/models/products/product.prisma` (`ProductVariant.price`) | ✅ ใช้เป็น fallback ต่อได้ |
| slot ไม่มีราคา และ `meta` ห้ามเก็บราคา | `ProductSlot` + `product-slot.service.ts` `checkedMeta` | ⚠️ ต้องเพิ่มเป็น **คอลัมน์** ไม่ใช่ meta (กฎห้ามราคาใน meta ยังคงไว้) |
| evidence ของ slot = evidence ของ variant + `slot` | `slots/slot-search.ts` (`{ ...variant, ref: 'SLOT:<id>', slot }`) | ⚠️ ราคาของรอบจะถูกทับด้วยราคาของ variant เสมอ ต้อง override ตรงนี้ |
| คำถามราคาอย่างเดียวไม่ดึง slot | `slot-search.ts` `wantsSlots()` ("Price-only questions never do") | ⚠️ P7 จะตอบราคาของ variant ซึ่งผิดเมื่อรอบมีราคาของตัวเอง |
| ตัดสินค้าที่ไม่มีราคาทิ้งก่อนดู slot | `product-search.service.ts` (`CHEAPEST && !price`, `minPrice/maxPrice && !price`) | ⚠️ variant ที่ไม่มีราคาแต่ slot มีราคาจะหายก่อนถึง slot |
| `purchasable` ดูราคาของ variant | `product-search.service.ts` (`price !== null && …`) | ⚠️ ต้องใช้ราคาจริงของรอบ |
| ตัวเรนเดอร์ปฏิเสธตัวเลขนอก token | `product-answer.policy.ts` (`/[{}\d๐-๙]/u`) | ✅ ทำให้ LLM พิมพ์ราคาเองไม่ได้ ไม่ต้องแก้ |
| ราคาไม่เข้า embedding | `search/product-document.ts` (ตัดประโยคที่มีราคา/บาท) | ✅ ไม่ต้อง reindex เมื่อแก้ราคา |

---

## 3. Data model

### 3.1 คอลัมน์ที่เพิ่ม

```prisma
model ProductVariant {
  // ...
  price          Decimal? @db.Decimal(12, 2)
  /// ไม่ null = ราคายังไม่แน่นอน อยู่ในช่วง price..maxPrice
  maxPrice       Decimal? @db.Decimal(12, 2)
  compareAtPrice Decimal? @db.Decimal(12, 2)
}

model ProductSlot {
  // ...
  /// null ทั้งคู่ = ใช้ราคาของ variant
  price    Decimal? @db.Decimal(12, 2)
  /// ไม่ null = ราคาของรอบนี้ยังไม่แน่นอน อยู่ในช่วง price..maxPrice
  maxPrice Decimal? @db.Decimal(12, 2)
}
```

Migration เป็น nullable ทั้งหมด ไม่ต้อง backfill ข้อมูลเดิมทำงานเหมือนเดิม (P1/P6)

Prisma ไม่รองรับ CHECK constraint จึงต้องเขียน SQL เพิ่มเองใน migration เพื่อกันข้อมูลผิดจากช่องทางอื่นนอก API:

```sql
ALTER TABLE "productVariants"
  ADD CONSTRAINT "productVariants_maxPrice_check"
  CHECK ("maxPrice" IS NULL OR ("price" IS NOT NULL AND "maxPrice" > "price"));

ALTER TABLE "productSlots"
  ADD CONSTRAINT "productSlots_maxPrice_check"
  CHECK ("maxPrice" IS NULL OR ("price" IS NOT NULL AND "maxPrice" > "price"));
```

### 3.2 กฎการเลือกราคาของรอบ (ฟังก์ชันเดียว ใช้ทุกที่)

สร้าง `products/product-pricing.ts` → `effectivePrice()` เป็นจุดเดียวที่ตัดสินราคา ห้ามที่อื่นคำนวณเอง:

```ts
export type PriceKind = 'EXACT' | 'RANGE' | 'NONE';
export type EffectivePrice = {
  kind: PriceKind;
  low: Prisma.Decimal | null;   // EXACT = ราคา, RANGE = ต่ำสุด
  high: Prisma.Decimal | null;  // RANGE เท่านั้น
  source: 'SLOT' | 'VARIANT';
};

export function effectivePrice(
  variant: { price: Money; maxPrice?: Money },
  slot?: { price: Money; maxPrice?: Money } | null,
): EffectivePrice {
  // all-or-nothing: slot.price ไม่ null = ใช้คู่ของ slot ทั้งคู่
  const pick = slot && slot.price != null ? { ...slot, source: 'SLOT' as const }
                                          : { ...variant, source: 'VARIANT' as const };
  if (pick.price == null) return { kind: 'NONE', low: null, high: null, source: pick.source };
  const low = new Prisma.Decimal(pick.price);
  if (pick.maxPrice == null) return { kind: 'EXACT', low, high: null, source: pick.source };
  return { kind: 'RANGE', low, high: new Prisma.Decimal(pick.maxPrice), source: pick.source };
}
```

เหตุผลที่ไม่ผสม: ถ้า slot ตั้ง `price=350` (ราคาแน่นอน) แต่ variant มี `maxPrice=416` การผสมจะได้ "350–416" ซึ่งไม่มีใครตั้งใจ

### 3.3 การเขียนจาก admin

| endpoint | field ที่เพิ่ม | หมายเหตุ |
|---|---|---|
| `POST /api/admin/products` และ `POST …/variants` | `maxPrice` | ผ่าน `ProductCommandService.execute` เหมือนเดิม |
| `PATCH …/variants/:variantId` | `maxPrice` (nullable) | `null` = ยืนยันว่าราคาแน่นอนแล้ว |
| `POST …/slots/generate` | `price`, `maxPrice` | ทุกรอบที่ generate ได้ราคาเดียวกัน ถ้าต่างกันให้เรียกหลายครั้งหรือใช้ `bulk` |
| `POST …/slots/bulk` | `price`, `maxPrice` ต่อแถว | ใช้ import ตารางรอบที่ราคาต่างกันรายรอบ |
| `PATCH …/slots/:slotId` | `price`, `maxPrice` (nullable) | `price=null` ต้องส่ง `maxPrice=null` ด้วย (กลับไปใช้ราคาของ variant) |

Validation ทุกจุดเรียก `assertProductPricing` ที่ขยายกฎแล้ว:

- `maxPrice` ต้องมี `price` และ `maxPrice > price`
- `maxPrice` กับ `compareAtPrice` ใช้พร้อมกันไม่ได้ (ราคาไม่แน่นอนแล้วบอกส่วนลดไม่ได้)
- PATCH ต้อง validate กับค่าหลัง merge ไม่ใช่เฉพาะค่าที่ส่งมา

---

## 4. Evidence

เพิ่มใน `ProductEvidence` (`search/product-search.types.ts`):

```ts
price: string | null;          // เดิม: EXACT = ราคา, RANGE = ต่ำสุด
maxPrice?: string | null;      // RANGE เท่านั้น
priceKind?: PriceKind;         // ไม่มี = evidence เก่าที่ persist ไว้ ถือเป็น EXACT ถ้ามี price
priceSource?: 'SLOT' | 'VARIANT';
```

- field ใหม่เป็น optional เพราะ `commerceTurns` เก็บ evidence ของ turn เก่าไว้ replay ต้องอ่านของเก่าได้โดยไม่พัง (แนวเดียวกับ `productSku` ที่เป็น legacy)
- `product-search.service.ts`: ใช้ `effectivePrice(variant)` แทน `variant.price` ตรง ๆ
- `slot-search.ts`: เพิ่ม `s."price", s."maxPrice"` ใน SELECT ทั้ง 3 query และ override ราคาตอนสร้าง evidence ของรอบ:

```ts
const priced = effectivePrice(variantRow, row);
return [{ ...variant, ref: `SLOT:${row.id}`, slot,
          price: priced.low?.toFixed(2) ?? null,
          maxPrice: priced.high?.toFixed(2) ?? null,
          priceKind: priced.kind, priceSource: priced.source }];
```

---

## 5. การ render คำตอบ

### 5.1 ใช้ token เดิม `{{eN.price}}`

เพิ่ม `formatPrice(e, lexicon)` จุดเดียวใน `product-answer.policy.ts` แล้วใช้ทุกที่ที่เคยเขียน `${e.price} บาท`:

| priceKind | ผลลัพธ์ |
|---|---|
| `EXACT` | `316.00 บาท` |
| `RANGE` | `316.00–416.00 บาท (ราคาโดยประมาณ ยืนยันอีกครั้งก่อนเดินทาง)` |
| `NONE` | `ยังไม่ได้ระบุราคา` |

ข้อความในวงเล็บมาจาก lexicon (`TRANSPORT_LEXICON.price.rangeNote`) ไม่ฝังใน core เพื่อให้แต่ละธุรกิจตั้งเองได้ ถ้า preset ไม่มีให้ใช้ค่ากลาง "(ราคาโดยประมาณ)"

เหตุผลที่ไม่เพิ่ม token `{{eN.maxPrice}}` หรือ `{{eN.priceText}}`:

- ถ้ามีหลาย token LLM อาจใช้ `{{eN.price}}` กับรอบที่เป็นช่วง แล้วลูกค้าเห็น "316 บาท" เหมือนราคาแน่นอน
- token เดียวที่ render ตามชนิดราคาทำให้คำเตือนติดไปกับตัวเลขเสมอ ไม่ขึ้นกับว่า LLM เขียนอะไร
- `coversAskedFacts` และ allowlist ไม่ต้องรู้จัก field ใหม่

### 5.2 จุดที่ต้องเปลี่ยนเป็น `formatPrice`

- `product-answer.policy.ts` `productFactTokens` (ค่า `price` ของ token) ทั้ง 2 จุด
- `product-answer.policy.ts` safe answer (`ราคา ${e.price} บาท`)
- `slots/slot-answer.ts` `scheduleAnswer` (`${e.price} บาท`) ซึ่งเป็นคำตอบไม่ใช้ LLM ของตารางรอบ

### 5.3 `priceRange` (ระดับเส้นทาง)

`product-answer.grounding.ts` `productPriceRange` เปลี่ยนเป็น ต่ำสุดของ `low` ถึงสูงสุดของ `high ?? low` และถ้ามี evidence ไหนเป็น `RANGE` ให้ต่อท้ายด้วย `rangeNote`

### 5.4 กันประโยคที่ยืนยันราคา

ถ้า evidence ที่ใช้มี `priceKind=RANGE` แล้ว prose ของ LLM มีคำยืนยัน เช่น "แน่นอน" "ตายตัว" "ราคาเดียว" ให้ reject (ไป `CRITICAL_REPAIR` แล้ว `safeProductAnswer` ตามเส้นทางเดิม) รายการคำอยู่ใน lexicon (`price.certainWords`) ตรวจใน `product-answer.policy.ts` จุดเดียวกับ `proseMakesClaim`

### 5.5 Prompt

`rag/utils/prompt/product-answer-prompt.ts` และ `TRANSPORT_PROMPT.answerTail` เพิ่มหนึ่งข้อ: "`{{eN.price}}` อาจเป็นช่วงราคาที่ยังไม่แน่นอน ห้ามบอกว่าราคาแน่นอน ห้ามเลือกตัวเลขตัวใดตัวหนึ่งในช่วง" (การแก้ prompt ต้องมี test ภาษาไทยตาม `.claude/rules/rag-ai.md`)

---

## 6. การค้นหาและตัวกรองราคา

### 6.1 ตัวกรอง `minPrice` / `maxPrice` ของลูกค้า

ใช้หลัก **ช่วงทับกัน**: ผ่านเมื่อ `[low, high ?? low]` ทับกับ `[plan.minPrice, plan.maxPrice]`

ตัวอย่าง: ลูกค้าถาม "ไม่เกิน 400" รอบ 316–416 ผ่าน (มีโอกาสอยู่ในงบ) และคำตอบแสดงเป็นช่วงพร้อม `rangeNote` จึงไม่หลอกว่าอยู่ในงบแน่นอน

### 6.2 ย้ายตัวกรองราคาไประดับรอบเมื่อธุรกิจเป็น `SLOT_CAPACITY`

`product-search.service.ts` ตอนนี้ตัด variant ที่ไม่มีราคาหรือราคาไม่อยู่ในช่วงทิ้งก่อนถึง slot สำหรับธุรกิจที่ `capabilities.inventory === 'SLOT_CAPACITY'`:

- ระดับ variant: **ไม่ตัด** ด้วยราคา (ราคาจริงยังไม่รู้จนกว่าจะเลือกรอบ)
- ระดับรอบ (`slot-search.ts`): ใช้ `effectivePrice(variant, slot)` กรองตาม 6.1 หลังได้ราคาของแต่ละรอบ
- ธุรกิจอื่น (ECOMMERCE, EDUCATION) ทำงานเหมือนเดิม

### 6.3 `CHEAPEST`

เรียงด้วย `low` แล้วให้ `EXACT` มาก่อน `RANGE` เมื่อ `low` เท่ากัน (ราคาแน่นอนน่าเชื่อถือกว่า) จากนั้นเรียงด้วย sku เหมือนเดิม

### 6.4 คำถามราคาที่ไม่ระบุรอบ (P7)

`wantsSlots()` ตอนนี้คืน `false` สำหรับคำถามราคาอย่างเดียว ไม่ต้องเปลี่ยนเป็นดึงรายการรอบ (จะได้รอบเยอะเกินไป) ให้เพิ่ม **aggregate query เดียว** ใน transaction เดียวกับการค้นหา (RepeatableRead เดิม):

```sql
SELECT s."variantId",
       MIN(COALESCE(s."price", v."price"))                                       AS low,
       MAX(COALESCE(s."maxPrice", s."price", v."maxPrice", v."price"))           AS high,
       BOOL_OR(CASE WHEN s."price" IS NOT NULL THEN s."maxPrice" IS NOT NULL
                    ELSE v."maxPrice" IS NOT NULL END)                           AS "hasRange"
FROM "productSlots" s
JOIN "productVariants" v ON v.id = s."variantId" AND v."companyId" = s."companyId"
WHERE s."companyId" = $1 AND s."variantId" = ANY($2)
  AND s.status = 'OPEN' AND s."startsAt" >= $3 AND s."startsAt" < $4  -- now .. now+horizonDays
GROUP BY s."variantId";
```

> ที่ทำจริง (`slotPriceEnvelopes` ใน `slots/slot-search.ts`): ช่วงเวลาเริ่มที่ `now + cutoffMinutes` (รอบที่ซื้อไม่ทันแล้วไม่นับ) และมี `HAVING BOOL_OR(s.price IS NOT NULL)` คือ variant ที่ไม่มีรอบไหนตั้งราคาเองจะไม่มี envelope และใช้ราคาของ variant ตรง ๆ (ไม่งั้นเส้นทางที่ไม่แน่นอนทั้งเส้นจะได้หมายเหตุ "ขึ้นกับรอบ" ผิด) query นี้ใช้ทั้งคำถามราคาเส้นทางเดียว และ LIST/COUNT/CHEAPEST ทั้ง catalog (ทีละหน้า 100 เส้นทาง)

- ถ้า `low = high` และไม่มีช่วง = ทุกรอบราคาเดียวกัน ตอบเป็นราคาแน่นอนเหมือนเดิม
- ถ้าต่างกัน ใส่เป็น `priceKind=RANGE`, `priceSource=SLOT` ใน evidence ของ variant และให้คำตอบต่อท้ายด้วยคำถาม `TRANSPORT_LEXICON.clarify.when` ("ต้องการเดินทางวันไหนคะ") เพื่อให้รอบถัดไปตอบราคาที่ตรงรอบได้
- ไม่มีรอบที่เปิดอยู่เลย = ใช้ราคาของ variant (พฤติกรรมเดิม)
- query อ่านอย่างเดียว ไม่มี network call ใน tx (ตามกฎข้อ 13.2)

### 6.5 `purchasable`

เปลี่ยนจาก `price !== null` เป็น `effectivePrice(...).kind !== 'NONE'` ส่วนกฎเรื่องที่นั่งเหมือนเดิม

---

## 7. ไฟล์ที่ต้องแก้

| # | ไฟล์ | สิ่งที่ทำ |
|---|---|---|
| 1 | `prisma/models/products/product.prisma` + migration ใหม่ | `maxPrice` ที่ variant, `price`/`maxPrice` ที่ slot, CHECK constraint |
| 2 | `products/product-pricing.ts` | `effectivePrice()`, ขยาย `assertProductPricing` |
| 3 | `products/dto/product.dto.ts` | `maxPrice` ใน create/patch ของ variant |
| 4 | `products/slots/product-slot.dto.ts` | `price`/`maxPrice` ใน `generate`, `bulk` row, `patch` (และเพิ่มใน refine "Nothing to change") |
| 5 | `products/slots/product-slot.service.ts` | เขียนคอลัมน์ใหม่ + validate หลัง merge + คืนค่าใน list |
| 6 | `products/product.service.ts` | คืน `maxPrice` ใน response ของ admin |
| 7 | `products/search/product-search.types.ts` | `maxPrice`, `priceKind`, `priceSource` (optional) |
| 8 | `products/search/product-search.service.ts` | ใช้ `effectivePrice`, เลื่อนตัวกรองราคาสำหรับ `SLOT_CAPACITY`, `CHEAPEST`, `purchasable`, aggregate ของ 6.4 |
| 9 | `products/slots/slot-search.ts` | SELECT คอลัมน์ใหม่, override ราคาต่อรอบ, ตัวกรองราคาระดับรอบ |
| 10 | `products/rag/product-answer.policy.ts` | `formatPrice`, guard คำยืนยันราคา |
| 11 | `products/rag/product-answer.grounding.ts` | `productPriceRange` นับ `maxPrice` |
| 12 | `products/slots/slot-answer.ts` | ใช้ `formatPrice` |
| 13 | `products/attributes/presets/transport.lexicon.ts` + type ใน `attribute-definition.types.ts` | `price.rangeNote`, `price.certainWords` (optional field) |
| 14 | `products/rag/utils/prompt/product-answer-prompt.ts`, `attributes/prompts/transport.prompt.ts` | กฎเรื่องช่วงราคา |

ไม่ต้องแก้: `product-document.ts` / `ProductIndexService` (ราคาไม่เข้า embedding), billing, delivery, decision log

---

## 8. Tests

**Unit (`product-pricing`)**
- `effectivePrice` ครบทุกคู่: slot EXACT, slot RANGE, slot null → variant EXACT/RANGE/NONE
- slot `price=350` + variant `maxPrice=416` ต้องได้ EXACT 350 (ไม่ผสม)
- `assertProductPricing`: `maxPrice <= price` reject, `maxPrice` ไม่มี `price` reject, `maxPrice` + `compareAtPrice` reject, PATCH ที่ทำให้ค่าหลัง merge ผิด reject

**Policy / render (`product-answer.policy.spec.ts`)**
- token `{{e1.price}}` ของรอบ RANGE ได้ "316.00–416.00 บาท (…)" ของรอบ EXACT ได้ "316.00 บาท"
- prose "ราคาแน่นอน {{e1.price}}" กับรอบ RANGE ถูก reject
- evidence เก่าที่ไม่มี `priceKind` ยัง render เป็น EXACT

**Search**
- "ไม่เกิน 400" ได้รอบ 316–416 และไม่ได้รอบ 450
- variant ที่ `price=null` แต่ slot มีราคา ยังเจอใน TRANSPORT
- ECOMMERCE ยังตัดสินค้าที่ไม่มีราคาเหมือนเดิม (regression)
- aggregate 6.4: ทุกรอบราคาเดียวกัน = EXACT, ต่างกัน = RANGE, ไม่มีรอบเปิด = ราคาของ variant

**คำถามภาษาไทยจริง (audit, ตาม `.claude/rules/rag-ai.md`)**
- "กรุงเทพไปพัทยากี่บาท" (P7)
- "รอบ 9 โมงพรุ่งนี้ราคาเท่าไหร่" (P4)
- "รอบ 5 โมงเย็นวันเสาร์กี่บาท" (P3)
- "มีรถไปพัทยาไม่เกิน 400 ไหม" (6.1)
- "รอบไหนถูกสุด" (6.3)

**Replay**: turn ที่ persist evidence ก่อน migration ต้อง replay ได้โดยไม่เรียก LLM ใหม่และคำตอบเหมือนเดิม

---

## 9. ลำดับการทำ

1. **Schema + admin write** (ไฟล์ 1–6) ข้อมูลเก็บได้แต่บอทยังตอบแบบเดิม ปล่อยได้อย่างปลอดภัย
2. **Evidence + render** (ไฟล์ 7, 9 บางส่วน, 10–13) รอบที่ถามตรงรอบตอบราคาของรอบได้ถูกต้อง
3. **ตัวกรอง + คำถามไม่ระบุรอบ** (ไฟล์ 8, 9 ส่วนที่เหลือ) P7 และ 6.1–6.3
4. **Prompt + audit ภาษาไทย** (ไฟล์ 14 + test ชุดสุดท้าย)

แต่ละขั้น backward compatible ข้อมูลที่ไม่มี `maxPrice` และ slot ที่ไม่มีราคาทำงานเหมือนเดิมทุกขั้น

---

## 10. คำถามที่ยังต้องตัดสินใจ

1. **ข้อความ `rangeNote`** ใช้ "(ราคาโดยประมาณ ยืนยันอีกครั้งก่อนเดินทาง)" หรือข้อความอื่น ควรให้ฝั่งธุรกิจตัดสิน
2. **ตัวกรอง "ไม่เกิน X" กับรอบที่เป็นช่วง** แนะนำให้ผ่านแบบช่วงทับกัน (6.1) ถ้าอยากเข้มกว่านี้ให้ใช้ `high <= X` แทน แต่ลูกค้าจะไม่เห็นรอบที่อาจอยู่ในงบ
3. **ต้องมี `variant.maxPrice` จริงไหม** ถ้าเส้นทางที่ไม่แน่นอนทั้งเส้นมีน้อย ตัดออกได้แล้วตั้งที่ slot อย่างเดียว แต่ admin ต้องกรอกทุกรอบ แผนนี้เก็บไว้เพื่อลดงานกรอก (P2)
4. **ราคาที่ยังไม่แน่นอนควรขึ้นเตือนให้แอดมินยืนยันไหม** เช่น รอบที่ยังเป็นช่วงภายใน 24 ชม. ก่อนออก ตอนนี้อยู่นอกขอบเขตของแผนนี้

---

## 11. ผลการลงมือ (20 พ.ย. 2026)

### 11.1 สิ่งที่ทำแล้ว

| ขั้น | สถานะ | ไฟล์ |
|---|---|---|
| Schema + migration | ✅ ใช้กับ DB local แล้ว | `prisma/models/products/product.prisma`, `prisma/migrations/20261120000000_product_price_range/` (มี CHECK 4 ตัว) |
| กฎราคา | ✅ | `products/product-pricing.ts`: `effectivePrice`, `envelopePrice`, `fitsBudget`, `comparePrices`, `formatPrice`, `assertPriceRange` |
| Admin write | ✅ | `dto/product.dto.ts` (`maxPrice`), `slots/product-slot.dto.ts` + `product-slot.service.ts` (`price`/`maxPrice` ใน generate/bulk/patch + คืนค่าใน list), `product.service.ts` (คืน `maxPrice`) |
| Search | ✅ | `search/product-search.service.ts` (envelope, ตัวกรองแบบช่วงทับกัน, CHEAPEST, purchasable), `slots/slot-search.ts` (ราคาต่อรอบ, ตัวกรองงบต่อรอบ, `slotPriceEnvelopes`) |
| Render | ✅ | `rag/product-answer.policy.ts` (token, prompt evidence, safe answer, กันคำว่า "แน่นอน"), `rag/product-answer.grounding.ts` (`priceRange`, coverage), `slots/slot-answer.ts` |
| Wording / prompt | ✅ | `attributes/types/attribute-definition.types.ts` (`lexicon.price`), `presets/transport.lexicon.ts`, `rag/utils/prompt/product-answer-prompt.ts`, `attributes/prompts/transport.prompt.ts` |

### 11.2 การตัดสินใจระหว่างทำ (ต่างจากแผนเดิมหรือแผนไม่ได้ระบุ)

1. **เขียนราคาของรอบเป็นคู่** (bulk / patch): ส่ง `price` โดยไม่ส่ง `maxPrice` = รอบนั้นกลายเป็นราคาแน่นอน, `price: null` = กลับไปใช้ราคาของ variant (ล้าง `maxPrice` ด้วย) ส่ง `maxPrice` อย่างเดียวไม่ได้ ทำให้ไม่มีช่วงราคาค้างจากการแก้ครั้งก่อน ส่วน variant ยังแก้ `maxPrice` แยกได้ (`maxPrice: null` = ยืนยันราคาแล้ว)
2. **`maxPrice` ใช้ร่วมกับ `compareAtPrice` ไม่ได้** ทั้งใน API และ CHECK ของ DB (ราคาประมาณบอกส่วนลดไม่ได้) และส่วนลดจะไม่แสดงเมื่อราคามาจากรอบหรือ envelope
3. **หมายเหตุมี 3 แบบ** (`priceNote`): `ESTIMATE` = ราคานี้ยังไม่แน่นอน, `BY_SLOT` = รอบราคาต่างกัน, `BY_SLOT_ESTIMATE` = ต่างกันและมีรอบประมาณ ข้อความมาจาก `lexicon.price` ธุรกิจที่ไม่ตั้งใช้ค่ากลางใน `DEFAULT_PRICE_WORDING`
4. **ช่วงราคาที่ไม่มีหมายเหตุ** (variant หลายตัวราคาต่างกันแบบ ECOMMERCE เดิม) ยังแสดง "690.00–720.00 บาท" เหมือนเดิม ไม่มีคำว่าประมาณ
5. **ตัวกรองงบในตารางรอบ**: ถ้ากรองแล้วไม่เหลือรอบ ผลเป็น `NO_SLOT_IN_WINDOW` (ข้อความ "ไม่มีรอบในช่วงที่ถาม") ยังไม่มีข้อความเฉพาะว่า "ไม่มีรอบในงบ" ส่วนระดับเส้นทาง ถ้ากรองแล้วไม่เหลือ พฤติกรรมเหมือนเดิมของ ECOMMERCE (ไม่เปลี่ยน)
6. **กันคำยืนยันราคา** (§5.4) ตรวจเฉพาะเมื่อ template ใช้ `{{eN.price}}` / `{{eN.priceRange}}` ของแถวที่มีหมายเหตุ คำว่า "แน่นอน" ในประโยคอื่นของคำตอบเดียวกันจะทำให้ถูก reject ด้วย (ไป `CRITICAL_REPAIR` → safe answer) ยอมรับไว้เพราะปลอดภัยกว่า

### 11.3 ผลทดสอบ

| ชุด | ผล |
|---|---|
| Unit ใหม่ `products/product-pricing.spec.ts` (กฎราคา, format, validation ของ DTO, OpenAPI ของ DTO 6 ตัว) | 15/15 ผ่าน |
| Unit เดิม `rag/product-answer.policy.spec.ts` (ECOMMERCE regression) | 11/11 ผ่าน |
| DB integration `products/tests/multi-price.integration.spec.ts` (search จริง, คำตอบจริง, admin write, CHECK ของ DB) | 11/11 ผ่าน + benchmark 1 ชุด |
| `tsc --noEmit` | ไม่มี error ใหม่ (13 error เดิมอยู่นอกโมดูล product) |
| ESLint ไฟล์ที่แก้ | ผ่าน |
| `jest` ทั้ง repo | 10 suite ที่ fail อยู่แล้วก่อนเริ่ม (ตรวจบน worktree ของ HEAD: embedding, BM25, AI pricing DTO, audit) ไม่มี suite ใหม่ที่ fail |

กรณีที่ integration test ตรวจ (ข้อมูลเส้นทางกรุงเทพฯ → พัทยา/ระยอง/หัวหิน, เวลา 07:00 น. 21 พ.ย.):

- ถามราคาโดยไม่ระบุรอบ → `316.00–456.00 บาท (ราคาขึ้นกับรอบ บางรอบเป็นราคาโดยประมาณ)` และรอบที่ปิดขาย (100 บาท) กับรอบในช่วง cutoff (99 บาท) ไม่ถูกนับ
- เส้นทางที่ไม่มีรอบไหนตั้งราคาเอง → ใช้ราคาของ variant (250 แน่นอน / 300–380 ประมาณ)
- ตารางรอบ 22 พ.ย. (ไม่ใช้ LLM):
  ```
  • 06:30 น. · ถึงประมาณ 09:00 น. · 316.00 บาท
  • 09:00 น. · ถึงประมาณ 11:30 น. · 316.00–416.00 บาท (ราคาโดยประมาณ ยืนยันอีกครั้งก่อนเดินทาง)
  • 17:30 น. · ถึงประมาณ 20:00 น. · 350.00 บาท
  ```
- "ไม่เกิน 340" → เหลือรอบ 06:30 และ 09:00 (ช่วง 316–416 ทับงบ) ตัดรอบ 350
- ทั้ง catalog "ไม่เกิน 260" → เหลือแค่ระยอง, "ถูกสุด" → ระยอง, หัวหิน, พัทยา
- template ของ LLM `{{e1.name}} ค่าโดยสาร {{e1.price}} ค่ะ` render ได้พร้อมหมายเหตุ ถ้าเขียน "ราคาแน่นอน" ถูก reject
- generate รอบพร้อมช่วงราคา → patch `price` อย่างเดียว → กลายเป็นราคาแน่นอน, bulk `price: null` → กลับไปใช้ราคา variant, DB ปฏิเสธ `maxPrice <= price`

### 11.4 ตัวเลขเวลา (benchmark, Postgres local, 63 เส้นทาง / 18,011 รอบ, หลัง ANALYZE)

| สิ่งที่วัด | p50 | p90 |
|---|---|---|
| envelope SQL, 1 เส้นทาง (query ที่เพิ่มมา) | 0.53 ms | 0.57 ms |
| envelope SQL, 63 เส้นทาง | 4.77 ms | 5.08 ms |
| `search()` ราคาเส้นทางเดียว (P7) | 2.54 ms | 3.60 ms |
| `search()` ตารางรอบ 1 วัน | 3.90 ms | 4.65 ms |
| `search()` ตารางรอบ + งบ | 3.87 ms | 4.23 ms |
| `search()` ถูกสุดทั้ง catalog | 12.99 ms | 17.57 ms |

- ส่วนที่เพิ่มต่อคำถามคือ envelope query ประมาณ **0.5 ms** (เส้นทางเดียว) ถึง **5 ms** (ทั้ง catalog) เทียบกับ LLM 1 ครั้งที่ p50 2,640 ms ในข้อมูลจริงของ DB local คือไม่ถึง 0.2%
- LLM call และ embedding เพิ่ม = 0 (ตรวจจากโค้ด: ไม่มีจุดเรียก provider ใหม่)
- ถ้าตารางเพิ่งถูกโหลดข้อมูลจำนวนมากโดยยังไม่ ANALYZE envelope ทั้ง catalog ช้าเป็น ~62 ms (planner เลือกแผนผิด) production ที่ autovacuum ทำงานปกติไม่เจอ แต่ถ้า import รอบหลายพันแถวทีเดียว ควรรัน `ANALYZE "productSlots"` หลัง import

### 11.5 วิธีรันซ้ำ

```bash
# 1. สร้าง DB ทิ้งได้บนเครื่อง (ห้ามชี้ไป DB ที่มีข้อมูลจริง: test สร้างและลบ company ของตัวเอง)
#    CREATE DATABASE app_db_multiprice_test;
DATABASE_URL=postgresql://<user>:<pass>@localhost:5432/app_db_multiprice_test?schema=public npx prisma migrate deploy

# 2. unit (ไม่ต้องใช้ DB)
npm run test:products

# 3. integration + benchmark
MULTIPRICE_DB_URL=postgresql://<user>:<pass>@localhost:5432/app_db_multiprice_test?schema=public \
MULTIPRICE_BENCH=1 \
node --experimental-vm-modules node_modules/jest/bin/jest.js src/modules/products/tests/multi-price.integration.spec.ts
```

### 11.6 ยังไม่ได้ทำ

- **audit กับ LLM จริงด้วยคำถามภาษาไทย** (§8 ชุดสุดท้าย) ยังไม่ได้รัน เพราะเสียเครดิตและยังไม่มี fixture ของ TRANSPORT ใน `test/audit/` (มีแค่ ECOMMERCE) สิ่งที่ยืนยันได้ตอนนี้คือส่วนที่ไม่ใช้ LLM (ตารางรอบ, safe answer) และตัวเรนเดอร์ของ template LLM ส่วนที่ยังไม่รู้คือ planner จะตีความ "ไม่เกิน 400" / "ถูกสุด" ของเส้นทางเป็น `maxPrice` / `CHEAPEST` ถูกหรือไม่ และ LLM จะใช้ token ราคาที่เป็นช่วงตามกฎใหม่ใน prompt หรือไม่
- **ข้อความ "ไม่มีรอบในงบ"** แยกจาก "ไม่มีรอบในช่วงที่ถาม" (11.2 ข้อ 5)
- **หน้า admin (frontend)** สำหรับกรอก `maxPrice` และราคาต่อรอบ อยู่นอก repo นี้
- `migrate dev` บน DB local ใช้ไม่ได้เพราะ DB มี migration 2 ตัวที่ไม่มีในโฟลเดอร์ (`20261013000000_drop_legacy_credit_wallets`, `20261013001000_drop_legacy_admin_ai_provider_settings`) จึงเขียน migration เองจาก `prisma migrate diff` แล้วใช้ `migrate deploy` (ไม่ได้ reset DB)
