# Product test: actual run

Fashion: 0/0 passed; diagnostic checks: 28/38.

| Case | Question | Expected | Actual | Result |
| --- | --- | --- | --- | --- |

## Diagnostic checks

- PASS HTTP admin endpoint requires JWT
- PASS same-variant constraints cannot mix black M and white L
- FAIL price-only DETAIL searches the catalog without a subject: 
Invalid `prisma.$queryRaw()` invocation:


Raw query failed. Code: `42P10`. Message: `ORDER BY position 0 is not in select list`
- FAIL option-only DETAIL searches the catalog without a subject: 
Invalid `prisma.$queryRaw()` invocation:


Raw query failed. Code: `42P10`. Message: `ORDER BY position 0 is not in select list`
- FAIL ambiguity can be resolved by variant constraints: Expected values to be strictly equal:
+ actual - expected

+ 'MISSING_INPUT'
- 'FOUND'

- PASS stock adjustment retry creates one movement
- PASS stale stock version returns conflict
- PASS oversell stock adjustment returns conflict
- PASS product creation idempotency is preserved
- FAIL PATCH only fashion.color preserves meta brand/material/tags: Expected values to be strictly equal:
+ actual - expected

+ undefined
- 'stussy'

- FAIL empty subject/ambiguous input does not produce SQL error: 
Invalid `prisma.$queryRaw()` invocation:


Raw query failed. Code: `42P10`. Message: `ORDER BY position 0 is not in select list`
- FAIL known category COUNT includes records without a matching Thai alias: Expected values to be strictly equal:

5 !== 6

- FAIL stock QUANTITY question cannot render status-only answer: Expected values to be strictly equal:
+ actual - expected

+ 'Stussy Box Logo มีสินค้าคงเหลือ ณ เวลาตรวจสอบ'
- undefined

- FAIL renderer rejects unsupported authenticity prose: Expected values to be strictly equal:
+ actual - expected

+ 'Stussy Box Logo รับรองของแท้แน่นอนค่ะ'
- undefined

- FAIL index document respects category applicability of fields: t-shirt material indexed although only enabled for shirt
- PASS foreign company mutation is rejected
- PASS archive removes product from search and preserves movements
- PASS HOTEL API persists typed fields and Decimal room area
- PASS HOTEL numeric filters and amenities hydrate correct evidence
- PASS HOTEL planner exposes exactly the chosen business fields
- FAIL old Fashion rows do not appear in HOTEL catalog list: old clothing still returned under HOTEL business
- PASS wrong-business variant payload is rejected by API
- PASS business changed after PLAN is rejected
- PASS HOTEL price and stock are authoritative DB facts
- PASS RESTAURANT options/negative allergen filter use the same variant
- PASS missing allergen facts do not satisfy NOT_CONTAINS
- PASS Restaurant evidence excludes Fashion/Hotel fields
- PASS GENERAL planner fields follow preset and generic answer prompt
- PASS GENERAL all declared fields persist, filter and reach evidence
- PASS ELECTRONICS planner fields follow preset and generic answer prompt
- PASS ELECTRONICS all declared fields persist, filter and reach evidence
- PASS FOOD planner fields follow preset and generic answer prompt
- PASS FOOD all declared fields persist, filter and reach evidence
- PASS BEAUTY planner fields follow preset and generic answer prompt
- PASS BEAUTY all declared fields persist, filter and reach evidence
- PASS switching back restores Fashion fields and excludes Hotel detail
- PASS index document omits price and stock
- PASS foreign company cannot read or mutate products

## Conversations

## Boundaries

{"adminHTTP":"real","chatHTTP":"test-only loopback adapter to MessageProcessor","database":"disposable PostgreSQL/pgvector","redis":"disposable","ai":"forbidden","line":"simulated","billing":"real services, synthetic wallet"}

Failures are findings. Expected decisions were not relaxed to make the run green. No production catalog, wallets, or LINE messages were changed.