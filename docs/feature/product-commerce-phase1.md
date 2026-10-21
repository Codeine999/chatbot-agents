# Product / Commerce — Phase 1 implementation

อัปเดต 5 ตุลาคม 2026 · เริ่มจาก Phase 0–1 ของ [แผน implementation](impliment-product.md)

## สิ่งที่ใช้งานได้

- Admin catalog: create/list/detail/PATCH/archive, เพิ่มและแก้ variant, stock adjustment พร้อม reason/actor/audit
- Product มีอย่างน้อยหนึ่ง variant; sku/price/compareAtPrice/trackStock/meta อยู่ใน variant เท่านั้น ไม่ส่ง variants มาเมื่อ create จะสร้าง default variant SKU V-{requestId} ราคา null
- ราคาเป็น Decimal(12,2), currency THB, API รับ/คืน decimal strings; ราคาที่ไม่ทราบเป็น null; ใช้ ProductVariant.price โดยไม่มี basePrice/priceOverride
- Product ใช้ companyId เป็น owner และขอบเขต query; SKU unique ต่อ company ในระดับ variant ไม่รับ ownership จาก request body CommerceScope ที่รับเป็น `{companyId}` ส่วน customer/command/turn ใช้ `commerceDbScope()` กำหนด tenantId:null ภายใน DB เพื่อรักษา standalone partition และการ replay เดิม
- Migration `20261011010000_product_company_sku` เปลี่ยนคอลัมน์ code เป็น sku โดยคงค่าเดิม ตรวจไม่ให้มี Product tenantId ที่ไม่ใช่ null ก่อนลบ metadata นี้ และเพิ่ม searchRevision เพื่อ reindex เอกสารใหม่ ต้อง deploy migration กับแอปพร้อมกัน ดูแผน compatibility/rollback ใน README ของ migration
- Catalog mutations มี UUID requestId, stored command outcome และ transaction advisory lock; replay payload เดิมคืน snapshot เดิม แม้ราคาเปลี่ยนภายหลัง; เปลี่ยน payload หรือ action ภายใต้ requestId เดิมคืน 409
- Product PATCH ใช้ expectedVersion=revision; variant commands ใช้ expectedProductVersion และ variant PATCH ใช้ expectedVersion=variant.version เพิ่มด้วย
- Stock command ใช้ expectedVersion=inventory.version; ล็อก parent Product → balance แล้ว update + movement + command outcome ใน transaction เดียว; ห้ามปรับต่ำกว่า reserved/ติดลบ/เกิน Int32; ไม่มี body ที่เขียน reserved โดยตรง
- Price-only/stock-only ไม่เพิ่ม searchRevision; searchable/status/variant identity changes เพิ่ม searchRevision เพื่อเป็น source revision ของ indexing ใน Phase 3
- trackStock=false ไม่สร้าง balance ใหม่และไม่รับ adjustment; ปิด tracking ได้เมื่อ reserved=0 โดยเก็บ balance/movement เดิมเป็น dormant audit และซ่อน inventory ใน response; เปิดใหม่ใช้ balance เดิมหรือสร้างศูนย์ถ้ายังไม่มี
- Customer กลาง, channel namespace, lazy identity resolution, hashed one-time account-link token อายุ 5 นาที; token ผูก company/customer, target identity ต้องมาจาก authenticated adapter
- สมัครผ่าน verified LINE เมื่อเปิด feature: Member + LineMember.memberId/customerId + Customer.memberId + ChannelIdentity commit พร้อมกัน; failure rollback Member ด้วย public register และ credentials response ใช้ contract เดิม

ไม่มี customer HTTP endpoint ที่รับ companyId/customerId/userId จาก body AccountLinkService เป็น internal port สำหรับ trusted adapters; identity ที่เคยอยู่คนละ Customer จะ conflict และต้องมี verified merge workstream ภายหลัง ไม่ย้ายประวัติแบบ silent merge

## Feature structure และ dependencies

```text
src/modules/commerce/             shared scope + feature policy ของ commerce เท่านั้น
  commerce-access.module.ts      ConfigModule + PrismaModule
  commerce-scope.service.ts      trusted admin/deployment company resolution
  commerce-feature.service.ts    catalog opt-in + LINE namespace
  types/ tests/

src/modules/users/customers/      canonical identity และ account-link commands (ย้ายจาก src/modules/customers 7 ต.ค. 2026)
  customers.module.ts            PrismaModule; ไม่ import Chatbot/LINE/Payments
  customer-identity.service.ts
  account-link.service.ts
  types/

src/modules/products/             admin catalog และ inventory mutation owner
  products.module.ts             Prisma/Auth/CommerceAccess; ไม่ import AI/LINE/Payments
  product.controller.ts          JWT/role + Zod DTO + trusted scope → service
  product.service.ts             Product/Variant mutations และ scoped admin query
  inventory.service.ts           adjustment + append-only stock movement
  product-command.service.ts     durable catalog command/replay transaction
  product-lock.ts                parent-first DB lock policy
  dto/ tests/
```

RegistrationModule import CustomersModule + CommerceAccessModule; RegistrationFlowService เรียก registerForLine โดยไม่มี provider call เมื่อปิด feature registerForLine ส่งต่อ register เดิมและไม่ resolve company/customer

## Configuration และ APIs

`PRODUCT_CATALOG_ENABLED=false` เป็นค่าเริ่มต้น เปิดเป็น `true` เมื่อ migration ผ่านและต้องการ admin catalog/LINE registration identity hook; ไม่ได้เปิด RAG/checkout/payment

`COMMERCE_LINE_CONNECTION_KEY` default `standalone-line` เป็น deployment namespace ของ LINE OA ให้กำหนดค่าที่คงที่และไม่เปลี่ยนระหว่าง retries

Admin companyId ที่ authenticate จาก DB เป็น scope หลัก Legacy admin companyId=null ใช้ `COMMERCE_LEGACY_ADMIN_COMPANY_ID` เมื่อ config ชี้ existing company หรือใช้ singleton ที่ตรวจพบเพียงหนึ่ง company เท่านั้น ถ้าไม่พบ/มีหลาย company ให้ fail closed ไม่เลือก findFirst สุ่ม LINE hook ต้องมี singleton company จริง ไม่สร้าง company ใน identity service

ทุก route ด้านล่างอยู่ใต้ `/api/admin/products` และอนุญาต owner/admin/dev ที่ผ่าน JWT เดิม ยกเว้น POST `/bulk` ที่อนุญาตเฉพาะ dev Controller/service สำหรับ admin อยู่ใน `src/modules/admin/product/` และใช้ ProductService เดิมสำหรับ transaction, ownership และ idempotency; DELETE เป็นการ archive ไม่ลบแถวหรือประวัติสต็อก Mutation ใช้ requestId และ expectedVersion ตามตาราง

| Method / suffix                                   | Input หลัก                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| GET `/`                                           | limit=1–100, offset, q?, status?                                                |
| GET `/:id`                                        | UUID product ID                                                                 |
| POST `/`                                          | name; optional requestId/status/variants |
| POST `/bulk` (dev only)                           | array 1–50 รายการ แต่ละรายการเป็น body เดียวกับ POST `/` สร้างทีละรายการตามลำดับ แต่ละรายการเป็นคำสั่งแยกกัน คืน `{ created, failed: [{ index, name, reason }] }` ห้ามส่ง header `Idempotency-Key` ให้ใส่ requestId ในแต่ละรายการแทน |
| PATCH `/:id`                                      | requestId, expectedVersion, fields ที่เปลี่ยน; status=ARCHIVED เพื่อ archive    |
| DELETE `/:id`                                     | body: requestId, expectedVersion; คืน snapshot ที่ status=ARCHIVED และเพิ่ม revision/searchRevision ครั้งเดียว Replay ใช้ผลเดิม |
| POST `/:id/variants`                              | requestId, expectedProductVersion, sku, meta?, price?, compareAtPrice?, trackStock?, active?    |
| PATCH `/:id/variants/:variantId`                  | requestId, expectedProductVersion, expectedVersion, fields ที่เปลี่ยน           |
| POST `/:id/variants/:variantId/stock-adjustments` | requestId, expectedVersion, deltaOnHand integer nonzero, reason                 |

รายการ field ใช้ [business preset ในโค้ด](product-attributes.md) เท่านั้น ไม่มีตารางหรือ API สำหรับ custom definition ต้อง apply preset ECOMMERCE ก่อนสร้างตัวอย่าง (ตัวอย่าง payload ด้านล่างยังใช้ field แฟชั่นเดิม ให้ปรับเป็น key ของ ECOMMERCE) สี/ไซส์บันทึกใน FashionVariant; payload ใหม่ใช้ fashion object ส่วน meta color/size ยัง normalize ไปคอลัมน์จริง DTO ยัง reject money/stock/PII/owner keys PATCH ที่ไม่ส่ง field มาไม่เติม create defaults

POST สินค้าไม่บังคับส่ง sku หรือ requestId แล้ว Backend สร้าง UUID สำหรับคำสั่งและ SKU แบบ `P-<requestId>` ให้ (default variant ใช้ SKU เดียวกัน) หรือส่งค่าเองแบบเดิมได้ รับ UUID ผ่าน header `Idempotency-Key` ได้ด้วย ถ้าส่งทั้ง header/body ต้องตรงกัน การ retry ด้วย key/payload เดิมจะใช้ SKU และผลเดิม ไม่ส่ง key จะถือเป็นคำสั่งใหม่ทุกครั้ง Variant ที่ระบุใน payload ยังต้องส่ง sku; PATCH/DELETE ยังคง contract เดิม ไม่ได้ลบคอลัมน์หรือ accounting/idempotency records

ตัวอย่างสร้างสินค้า จากนั้นใช้ revision และ inventory.version ที่ API คืนให้สำหรับ commands ถัดไป:

```json
{
  "requestId": "11111111-1111-4111-8111-111111111111",
  "name": "เสื้อรุ่น LIN-A",
  "status": "ACTIVE",
  "variants": [
    { "sku": "LIN-A-BK-M", "price": "490.00", "trackStock": true, "meta": { "color": "ดำ", "size": "M" } },
    {
      "sku": "LIN-A-WH-M",
      "meta": { "color": "ขาว", "size": "M" },
      "price": "520.00"
    }
  ]
}
```

Stock เริ่มศูนย์และเพิ่มผ่าน stock-adjustments เท่านั้น Response create/update เป็น Product รวม variants/effectivePrice/inventory ทุกครั้ง สำหรับ retry ให้ใช้ requestId เดิมและ payload เดิม สำหรับ command ใหม่ใช้ UUID ใหม่และ version ล่าสุด

## Migration, compatibility และ backfill

Migration: `20261005000000_add_customer_product_catalog` เพิ่ม customers/channelIdentities/accountLinkChallenges/products/productVariants/inventoryBalances/productCatalogCommands/inventoryMovements, enums และ nullable LineMember.customerId

- Composite FK ตรวจ child company ให้ตรง parent; history references ใช้ RESTRICT; balance/movement CHECKs ป้องกัน counters ที่ผิด; code/SKU/request/operation identities มี unique indexes
- Migration มี BEGIN/COMMIT และไม่มี DROP/rename/เปลี่ยน precision/vector dimension/ledger history
- Schema เดิมมี LineMember.memberId แต่ migrations เก่าไม่มี FK ใหม่จึงเพิ่ม FK แบบ NOT VALID เมื่อยังไม่มี FK นี้: enforce new writes, เก็บ orphan mappings เดิมไว้เพื่อ audit ไม่ null/ลบ/เดาข้อมูลลูกค้า
- ก่อนเปิด LINE hook ให้ audit orphan Member mapping ด้วย count แล้วตรวจ mapping ผ่านระบบที่ได้รับอนุญาต จากนั้นค่อย validate constraint หลังแก้ provenance ถูกต้อง ห้ามใช้ชื่อ/โทรศัพท์เดา owner
- ไม่มี eager Customer backfill ใน migration ใช้ lazy resolve เฉพาะ trusted identity ที่เข้า feature; explicit valid Member FK ใช้รวม verified mappings ได้
- Migration diff เทียบ old migrations กับ schema พบ legacy drift (รวม payment uuid/id, legacy tables/provider enum และ vector index names) ซึ่งไม่ได้รวมใน migration นี้ ห้ามใช้ generated whole-schema diff หรือ db push แทน reviewed migration นี้

ตรวจ orphan count (ไม่แสดง PII):

```sql
SELECT count(*) AS orphan_member_links
FROM "lineMember" l
LEFT JOIN member m ON m.uuid = l."memberId"
WHERE l."memberId" IS NOT NULL AND m.uuid IS NULL;
```

Deploy migration ก่อนแอปที่ใช้ regenerated client แม้ยังปิด feature เพราะ Prisma reads มี customerId เพิ่มแล้ว Generate/build ใช้ scripts เดิม `bun run db:generate` และ `bun run build` ไม่ได้ deploy migration ลงฐานข้อมูลแอปจริงในงานนี้

Rollback ระยะนี้ปิด PRODUCT_CATALOG_ENABLED และ deploy app version เดิมได้ คงตาราง/audit ไว้ ไม่ลบประวัติ ส่วนการเปิด order/payment ในอนาคตต้องใช้ rollback/recovery policy ของ Phase 4–7

## Verification

`bun run test:commerce` สร้าง pgvector/PostgreSQL 16 container ชั่วคราวบน localhost/random port, ใช้ tmpfs แยกจาก DB แอป, regenerate Prisma client, ตรวจ clean install ครบ 39 migrations และ upgrade จาก 38 migrations ที่มี synthetic company/Member/LINE/orphan records แล้วรัน unit + DB integration + isolated Fastify HTTP tests (รวม DI ของ RegistrationModule) ปิด/ลบ container และ temp migration fixtures เมื่อจบ ต้องมี Docker และ image `pgvector/pgvector:pg16` (Docker ดาวน์โหลดถ้ายังไม่มี)

DB suites ไม่ fallback ไป DATABASE_URL ของแอป การเรียก suites โดยตรงต้องระบุ COMMERCE_TEST_DATABASE_URL เป็น disposable local commerce_test database/user และใช้ Node --experimental-vm-modules ตาม Prisma runtime

ผลตรวจ Phase 1:

- Feature tests: **56 ผ่าน** (35 validation/scope + 16 DB/concurrency/identity/registration + 5 HTTP), clean install และ representative upgrade ผ่าน
- `bun run build` ผ่าน; Prisma validate/generate ผ่าน; ESLint แบบไม่ --fix เฉพาะไฟล์ที่เพิ่ม/แก้ใน feature ผ่าน; git diff --check ผ่าน
- `bunx tsc --noEmit --incremental false` ยังติด 4 จุดเดิมใน test fixtures ของ LINE constructor และ prompt composer ตาม baseline ก่อน implementation ไม่มี error จากโค้ด feature ใหม่
- Full unit suite รันโดยถอด DB/live opt-in env: 42 suites ผ่าน / 11 ไม่ผ่าน / 3 skip; 423 tests ผ่าน / 43 ไม่ผ่าน / 21 skip เปรียบกับ source HEAD ที่ export ไป temporary directory แยก (baseline 388 ผ่าน / 43 ไม่ผ่าน / 5 skip) แล้วตรวจ JSON assertion names ยืนยัน **43 failures เป็นเคสเดียวกันทั้งหมด** ไม่แก้ production retrieval/billing policy เพื่อให้ fixtures เดิมผ่าน
- Failures เดิมอยู่ใน retrieval/audit, billing/pricing mocks, embedding default, LINE constructor และ prompt sections ไม่ได้เปลี่ยนไฟล์เหล่านี้ใน Phase 1 ไม่ได้รัน AppModule E2E ที่เชื่อม infra จริง หรือ live LINE/AI/Omise evaluation; feature suites ตรวจว่าไม่มี outbound fetch และไม่มี dependencies ไป provider adapters

## ขอบเขตที่ยังไม่ได้ทำ

สถานะ ณ Phase 1: Product search/replay/vectors/planner ยังไม่มี ต่อมาเพิ่มแล้วใน [Phase 2–3 วันที่ 6 ตุลาคม 2026](product-commerce-phase2-3.md) ส่วน order/hold/checkout/slips/manual payment review/outbox/expiry/fulfillment/mock Omise เป็น Phase 4–7 ที่ทำภายหลัง การค้น q ใน admin catalog ยังคงเป็น catalog editor query แยกจาก Product RAG

ยังไม่มี frontend dashboard editor ใน repo นี้, Facebook/Web ingress/auth/media/delivery adapters หรือ verified Customer merge UI/command ห้ามเปิดรับเงินจริงด้วย Phase 1 นี้

## Discount display (11 October 2026)

Product and ProductVariant have nullable Decimal(12,2) `compareAtPrice` (original price).
`basePrice` / `priceOverride` remain the selling prices used for price filtering and ordering.
POST/PATCH accept decimal strings; omitted PATCH fields stay unchanged, `null` clears an original price.
A variant with null original price inherits Product.compareAtPrice. An inherited original at or below the
variant selling price is hidden (no discount). To remove a product-wide discount, clear the product
original price and any explicit variant original prices. Explicit originals must exceed their selling
prices; product price edits revalidate every variant under the product lock.

Catalog responses return `compareAtPrice`, `effectiveCompareAtPrice` and `discountAmount` (exact decimal
strings or null). Product RAG reads these facts from live DB evidence and exposes grounded
`originalPrice` / `discountAmount` tokens when answering price questions. Money never enters embedding
content; original-price changes do not increase searchRevision. Existing CommerceTurn/command snapshots
replay unchanged. This supports displayed sale prices, not coupons, scheduled promotions or checkout.

Deploy migration `20261011000000_add_product_compare_at_prices` before the new application and regenerate
Prisma. Existing rows receive null without changing selling prices; no backfill is needed. For rollback,
revert the application while retaining nullable columns and discount values (do not drop historical data).
Variant originals against inherited base prices are enforced by the service; SQL CHECKs enforce local
nonnegative/original-above-sale rules only.
