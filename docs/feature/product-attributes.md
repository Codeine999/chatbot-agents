# Product fields ตาม business preset

อัปเดต 20 ตุลาคม 2026

รายการฟิลด์และ prompt ของแต่ละธุรกิจอยู่ใน `src/modules/products/attributes/`:

| โฟลเดอร์ | เนื้อหา |
| --- | --- |
| `presets/` | preset หนึ่งไฟล์ต่อธุรกิจ (ตอนนี้มีเฉพาะ `ecommerce.preset.ts`), field ที่ใช้ร่วม (`shared-fields.ts`) และ registry `BUSINESS_PRESETS` (`index.ts`) |
| `prompts/` | ข้อความ planner/answer หนึ่งไฟล์ต่อธุรกิจ (ทุก preset ต้องมี `prompt`) `general.prompt.ts` เป็น fallback ของร้านที่ยังไม่ได้เลือกธุรกิจ (ไม่ใช่ preset ที่เลือกได้) |
| `utils/` | ค่าคงที่ (`*.constants.ts`) และ helper: ตรวจ key (`attribute-key.util.ts`), ตรวจ/จัดรูปค่า (`attribute-value.util.ts`), จับคำตัวเลือก (`option-matcher.util.ts`), กฎของ definition (`definition-rules.util.ts`) |
| `types/`, `dto/` | type `AttributeDefinition`/`BusinessPreset`/`BusinessPrompt` และ zod schema ของ meta/definition |

ไม่มีตาราง `ProductAttributeDefinition` และไม่มี API สร้าง/แก้ custom definition แล้ว โค้ดอื่นอ่าน preset ผ่าน `src/modules/products/search/catalog-fields.ts` เท่านั้น (`loadCatalogFields`, `catalogFields`, `businessPromptRules`, `BUSINESS_TYPES`) จึงเพิ่มธุรกิจใหม่ได้ด้วยการเพิ่มไฟล์ preset + prompt แล้วลงทะเบียนใน `presets/index.ts` ไม่ต้องสร้างตารางหรือแก้ search/index

## เลือกธุรกิจ

`POST /api/admin/products/attributes/presets/ECOMMERCE/apply`

```json
{ "categories": [] }
```

requestId ใน body หรือ Idempotency-Key header เป็น UUID ที่ไม่บังคับส่ง หากไม่ส่งระบบสร้างให้ การ replay ใช้ command เดิมและไม่บันทึกซ้ำ endpoint ใช้ admin JWT/role guard และ company ownership เดิม

apply บันทึก `Company.productBusinessType` และ `Company.productPresetCategories` แล้วคืน `{ type, selectedType, categories, fields }` ไม่สร้างสินค้าและไม่ ALTER TABLE เมื่อเปลี่ยนธุรกิจ ข้อมูลธุรกิจเดิมคงอยู่ ส่วน searchRevision เพิ่มให้ worker สร้างดัชนีใหม่

categories ว่างหมายถึงใช้กับทุกหมวด หากมีค่าจะใช้กับหมวดเหล่านั้นเท่านั้น

## ฟอร์มและข้อมูลจริง

- `GET /api/admin/products/attributes/presets`: preset ทั้งหมดจากโค้ด พร้อม selectedType/storage
- `GET /api/admin/products/attributes`: ฟิลด์ของ preset ที่เลือก รองรับ scope/category/status; ไม่มี definition id หรือ version
- `POST /api/admin/products/attributes` และ `PATCH /api/admin/products/attributes/:id` ถูกลบ

Product เก็บเฉพาะชื่อ รายละเอียด หมวด ภาษา และสถานะ ไม่มี sku/attributes/basePrice/compareAtPrice/trackStock แล้ว ProductVariant เก็บ SKU, price, compareAtPrice, trackStock, currency, meta และสัมพันธ์กับ inventory; **ค่าฟิลด์ของทุกธุรกิจอยู่ใน `ProductVariant.meta`** ตาม key ของ preset ไม่มีตารางรายละเอียดรายธุรกิจแล้ว (FashionVariant/RestaurantVariant/HotelVariant ถูกย้ายค่าเข้า meta และลบใน `20261020000000_merge_business_variants_into_meta`) ราคาและสต็อกยังอยู่ใน column/ตาราง inventory เท่านั้น

| ธุรกิจ | key ใน meta (ตัวอย่าง) |
| --- | --- |
| ECOMMERCE | brand, tags, model, color, size, material, weight_g, dimensions, features, origin, warranty, package_contents (ดู `ecommerce.preset.ts`) |

ECOMMERCE (อีคอมเมิร์ซทั่วไป) เป็นฟิลด์มาตรฐานที่ใช้ได้กับสินค้าส่วนใหญ่ ฟิลด์ที่ไม่เกี่ยวกับสินค้านั้นให้เว้นว่าง

| ชนิด | ฟิลด์ |
| --- | --- |
| TEXT | brand, model, material, dimensions, origin, warranty, package_contents |
| TEXT (ตัวเลือกของ variant) | color, size |
| NUMBER (กรอง EQ/GTE/LTE ได้) | weight_g |
| TAGS | tags, features |

ตัวอย่าง payload 20 รายการสำหรับ `POST /api/admin/products/bulk` อยู่ที่ `src/scripts/text/product.json` ต้อง apply preset ECOMMERCE ก่อนส่ง (ไฟล์ตัวอย่างปัจจุบันยังใช้ key แบบอิเล็กทรอนิกส์ ต้องแปลงเป็น key ของ ECOMMERCE ก่อน)

```json
{
  "name": "เสื้อ stussy",
  "status": "ACTIVE",
  "variants": [{
    "sku": "STUSSY-BK-M",
    "price": "2500.00",
    "trackStock": true,
    "meta": { "brand": "stussy", "material": "cotton 100%", "color": "ดำ", "size": "M", "condition": "new" }
  }]
}
```

payload ของ variant ไม่รับ object `fashion`/`restaurant`/`hotel` แล้ว (ส่งมาจะได้ 400) storage ใน metadata เป็น `{ "object": "meta", "field": <key> }` ทุกฟิลด์ NUMBER เก็บเป็นตัวเลข JSON เช่น `"room_area": 42.5`

PATCH variant ส่ง `meta` เฉพาะช่องที่จะแก้ได้ ระบบรวมกับค่าเดิม ช่องที่ไม่ได้ส่งยังอยู่ และส่ง `null` เพื่อลบช่องนั้น เช่น `"meta": { "color": "เขียว", "size": null }` (POST สร้างสินค้าไม่รับ `null`)

## Retrieval และ AI

Planner/search/index/validation ใช้ metadata จาก preset ในโค้ดเท่านั้น AI ได้ค่าจริงจาก Product และ ProductVariant.meta เฉพาะ key ของ preset ที่เลือก ราคาและสถานะสต็อกอ่านสดจาก DB ไม่ใช้ vector text เป็นข้อเท็จจริง

Search match ใช้ตัวเลือกและ filters ตาม business ที่เลือก เช่น ECOMMERCE color/size เป็นตัวเลือก และสเปกตัวเลข (weight_g) แบบ numeric comparison Evidence มี details ของแต่ละ variant ราคา และจำนวนสต็อกจริง ข้อความ planner/answer รายธุรกิจอยู่ใน `prompt` ของ preset (ECOMMERCE) ร้านที่ยังไม่เลือกธุรกิจใช้กฎ GENERAL และใช้ token renderer เดียวกัน รายละเอียด flow และตำแหน่งโค้ดอยู่ [Product RAG](product-commerce-phase2-3.md#business-search-flow-12-ตุลาคม-2026)

ค่า JSON เดิมนอก preset ย้ายลง variant.meta และยังอยู่ใน DB และคงไว้เมื่อแก้ข้อมูล แต่ไม่ค้นหาหรือแสดงให้ AI และ API ไม่รับการเขียน key ใหม่นอก preset ประวัติ ProductCatalogCommand ยังคงอยู่เพื่อ replay

## Migration

`20261020000000_merge_business_variants_into_meta` ย้ายค่าจาก FashionVariant/RestaurantVariant/HotelVariant เข้า variant.meta (ธุรกิจที่เลือกอยู่ให้ค่าตารางทับ meta; ธุรกิจอื่นไม่ทับ meta แต่เก็บค่าไว้) แล้วลบสามตาราง ต้อง deploy พร้อม application รุ่นนี้ ขั้นตอน backup/rollback อยู่ใน README ของ migration

`20261011060000_variant_catalog_ownership` ย้ายราคาที่มีผลจริงและ stock tracking ลงทุก variant, merge Product.attributes กับ variant.meta, เก็บ SKU เดิมของ Product เป็น alias และลบคอลัมน์ parent เดิม Product POST ไม่ส่ง variants จะสร้างหนึ่ง variant SKU V-{requestId} ราคา null สต็อกศูนย์; ราคาไม่ fallback จาก Product แล้ว


`20261011050000_remove_product_attribute_definitions` ลบตารางและ enums ของ Definition ย้าย category restrictions ไป Company แล้วเพิ่ม searchRevision ทุกสินค้า ก่อน deploy ต้อง backup definition rows ภายนอก repository; รายละเอียด rollback อยู่ใน README ของ migration


## Seed ข้อมูลร้านจาก JSON

`npm run seed:store` (`src/scripts/seed-store-data.ts`) apply preset ECOMMERCE แล้วนำเข้า `src/scripts/text/product.json` (ฟิลด์ธุรกิจอยู่ใน variant `meta`) และ `src/scripts/text/answerParttern.json` ผ่าน service จริง Product replay ด้วย `requestId` คงที่ ส่วน answer pattern จับคู่ด้วย `intentKey`+`language` และ embed ใหม่เฉพาะที่เนื้อหาเปลี่ยน ไม่ลบ pattern ที่ไม่อยู่ในไฟล์ สคริปต์เปิด PRODUCT_ENABLED เฉพาะ process และปิด product embedding จึงไม่แก้ `.env`
