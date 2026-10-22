# Business field values move into ProductVariant.meta

Apply this migration together with the application that no longer reads
`fashionVariants`, `restaurantVariants` or `hotelVariants`. The old
application fails against the migrated database, and the new application
fails before the migration, so deploy them in one step.

Before dropping the three tables, every typed value is copied into
`productVariants.meta` under the preset field key:

| Table | Column -> meta key |
| --- | --- |
| fashionVariants | color, size, condition |
| restaurantVariants | portion, spiceLevel -> spice_level |
| hotelVariants | bedType -> bed_type, maxGuests -> max_guests, roomArea -> room_area (JSON number) |

For the company's selected `productBusinessType` the typed value overwrites a
same-named meta key, because the typed row was what the catalog and RAG read.
Rows of another business never overwrite meta; their values are still kept in
meta. The migration itself does not bump searchRevision (its SQL comment
predates the preset change below).

## Business presets after this release

The application registers only the `ECOMMERCE` preset
(`src/modules/products/attributes/presets/index.ts`). The previous FASHION,
ELECTRONICS, FOOD, BEAUTY, RESTAURANT, HOTEL and GENERAL presets were removed.
A company whose `productBusinessType` is not a registered preset (including
null) gets no field definitions:

- every meta value stays in the database, but is not validated, searched,
  indexed, offered to the planner or shown to the AI;
- writing any `meta` key on a variant is rejected (`<key>: no such variant
  field`) until a registered preset is applied;
- product prompts fall back to the GENERAL rules.

ECOMMERCE keys: brand, tags, model, color, size, material, weight_g,
dimensions, features, origin, warranty, package_contents. Old keys outside
this list (e.g. condition, portion, spice_level, bed_type, max_guests,
room_area) remain private in meta.

Product documents are built from the selected preset's labels, so they change
for every company once the preset changes. After deploying, apply the preset
(`POST /api/admin/products/attributes/presets/ECOMMERCE/apply`): it stores the
type and bumps searchRevision of every product of the company, and the index
worker then re-embeds them. Until then, existing product vectors describe the
old fields.

Lost with the tables: the database CHECKs `maxGuests > 0` and `roomArea > 0`.
NUMBER fields of a preset accept any finite number.

API change: variant payloads no longer accept `fashion`, `restaurant` or
`hotel` objects; send the values in `meta` under the selected preset's keys
(e.g. `"meta": {"color": "ดำ", "size": "L", "weight_g": 180}` for ECOMMERCE).
PATCH merges `meta` into the stored values and `null` clears a key. Product
responses return the values in `meta` and no longer include those objects.
Field `storage` in the attribute APIs is always
`{ "object": "meta", "field": <key> }`.

Back up `fashionVariants`, `restaurantVariants` and `hotelVariants` before
applying. Rollback, with the previous application/client: recreate the tables
from `20261011030000_variant_business_details` (DDL only) and refill them from
meta for companies of that business, e.g.

```sql
INSERT INTO "hotelVariants" ("variantId", "companyId", "bedType", "maxGuests", "roomArea")
SELECT v.id, v."companyId", v.meta->>'bed_type',
  CASE WHEN jsonb_typeof(v.meta->'max_guests') = 'number' THEN (v.meta->>'max_guests')::int END,
  CASE WHEN jsonb_typeof(v.meta->'room_area') = 'number' THEN round((v.meta->>'room_area')::numeric, 2) END
FROM "productVariants" v JOIN company c ON c.id = v."companyId"
WHERE c."productBusinessType" = 'HOTEL' AND v.meta ?| ARRAY['bed_type','max_guests','room_area'];
```

Keep the meta keys during rollback: the previous application strips them
when it next writes a typed row, and meta is the only copy of values written
after this migration.
