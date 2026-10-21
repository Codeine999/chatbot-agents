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
Rows of another business never overwrite meta, so nothing the store sees today
changes; their values are still kept in meta. Product documents are unchanged,
so no searchRevision is bumped and nothing is re-embedded.

Lost with the tables: the database CHECKs `maxGuests > 0` and `roomArea > 0`.
Values are now validated by the HOTEL preset (NUMBER), which accepts any
finite number.

API change: variant payloads no longer accept `fashion`, `restaurant` or
`hotel` objects; send the values in `meta` (e.g. `"meta": {"bed_type":
"King", "max_guests": 2, "room_area": 32}`). Product responses return them in
`meta` and no longer include those objects. Field `storage` in the attribute
APIs is always `{ "object": "meta", "field": <key> }`.

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
