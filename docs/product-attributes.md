# Product fields ตาม business preset

อัปเดต 11 ตุลาคม 2026

รายการฟิลด์กำหนดใน `BUSINESS_PRESETS` ที่ `src/modules/products/attributes/attribute-definition.ts` ไม่มีตาราง `ProductAttributeDefinition` และไม่มี API สร้าง/แก้ custom definition แล้ว

## เลือกธุรกิจ

`POST /api/admin/products/attributes/presets/FASHION/apply`

```json
{ "categories": [] }
```

requestId ใน body หรือ Idempotency-Key header เป็น UUID ที่ไม่บังคับส่ง หากไม่ส่งระบบสร้างให้ การ replay ใช้ command เดิมและไม่บันทึกซ้ำ endpoint ใช้ admin JWT/role guard และ company ownership เดิม

apply บันทึก `Company.productBusinessType` และ `Company.productPresetCategories` แล้วคืน `{ type, selectedType, categories, fields }` ไม่สร้างสินค้าและไม่ ALTER TABLE เมื่อเปลี่ยนธุรกิจ ข้อมูลธุรกิจเดิมคงอยู่ ส่วน searchRevision เพิ่มให้ worker สร้างดัชนีใหม่

categories ว่างหมายถึงใช้กับทุกหมวด หากมีค่าจะใช้กับหมวดเหล่านั้นเท่านั้น

## ฟอร์มและข้อมูลจริง

- `GET /api/admin/products/attributes/presets`: preset ทั้งหมดจากโค้ด พร้อม selectedType/coreFields/storage
- `GET /api/admin/products/attributes`: ฟิลด์ของ preset ที่เลือก รองรับ scope/category/status; ไม่มี definition id หรือ version
- `POST /api/admin/products/attributes` และ `PATCH /api/admin/products/attributes/:id` ถูกลบ

Product เก็บเฉพาะชื่อ รายละเอียด หมวด ภาษา และสถานะ ไม่มี sku/attributes/basePrice/compareAtPrice/trackStock แล้ว ProductVariant เก็บ SKU, price, compareAtPrice, trackStock, currency, meta และสัมพันธ์กับ inventory; meta เก็บ brand/material และฟิลด์ preset ที่ไม่มีคอลัมน์รายละเอียด

| ธุรกิจ | ตารางรายละเอียด | ฟิลด์จริง |
| --- | --- | --- |
| FASHION | FashionVariant | color, size, condition |
| RESTAURANT | RestaurantVariant | portion, spiceLevel |
| HOTEL | HotelVariant | bedType, maxGuests, roomArea |

```json
{
  "name": "เสื้อ stussy",
  "status": "ACTIVE",
  "variants": [{
    "sku": "STUSSY-BK-M",
    "price": "2500.00",
    "trackStock": true,
    "meta": { "brand": "stussy", "material": "cotton 100%" },
    "fashion": { "color": "ดำ", "size": "M", "condition": "new" }
  }]
}
```

storage ใน metadata เช่น `{ "object": "fashion", "field": "color" }` บอก frontend ว่าต้องส่งฟิลด์ใน object ใด ไม่มี frontend implementation ใน backend นี้ Preset อื่นใช้ variant.meta สำหรับฟิลด์ที่ไม่มีตารางรายละเอียด

## Retrieval และ AI

Planner/search/index/validation ใช้ metadata จาก preset ในโค้ดเท่านั้น AI ได้ค่าจริงจาก Product, ProductVariant และรายละเอียดของธุรกิจที่เลือก คอลัมน์ธุรกิจไม่มีค่าไม่ fallback JSON เก่า ราคาและสถานะสต็อกอ่านสดจาก DB ไม่ใช้ vector text เป็นข้อเท็จจริง

Search match ใช้ตัวเลือกและ filters ตาม business ที่เลือก เช่น Fashion สี/ไซส์ + brand/material, Restaurant portion/spiceLevel + ingredients/allergens, Hotel bedType + maxGuests/roomArea แบบ numeric comparison Evidence มี details ของแต่ละ variant ราคา และจำนวนสต็อกจริง Prompt planner/answer แยก Fashion/Restaurant/Hotel แต่ใช้ token renderer เดียวกัน รายละเอียด flow และตำแหน่งโค้ดอยู่ [Product RAG](product-commerce-phase2-3.md#business-search-flow-12-ตุลาคม-2026)

ค่า JSON เดิมนอก preset ย้ายลง variant.meta และยังอยู่ใน DB และคงไว้เมื่อแก้ข้อมูล แต่ไม่ค้นหาหรือแสดงให้ AI และ API ไม่รับการเขียน key ใหม่นอก preset ประวัติ ProductCatalogCommand ยังคงอยู่เพื่อ replay

## Migration

`20261011060000_variant_catalog_ownership` ย้ายราคาที่มีผลจริงและ stock tracking ลงทุก variant, merge Product.attributes กับ variant.meta, เก็บ SKU เดิมของ Product เป็น alias และลบคอลัมน์ parent เดิม Product POST ไม่ส่ง variants จะสร้างหนึ่ง variant SKU V-{requestId} ราคา null สต็อกศูนย์; ราคาไม่ fallback จาก Product แล้ว


`20261011050000_remove_product_attribute_definitions` ลบตารางและ enums ของ Definition ย้าย category restrictions ไป Company แล้วเพิ่ม searchRevision ทุกสินค้า ก่อน deploy ต้อง backup definition rows ภายนอก repository; รายละเอียด rollback อยู่ใน README ของ migration
