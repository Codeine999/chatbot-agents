Product is the descriptive parent only. Variant owns SKU, price, compareAtPrice,
trackStock, currency and meta. Existing effective prices are materialized with
COALESCE(price, priceOverride, basePrice), preserving zero and Decimal precision.
Former product JSON is merged into each variant meta, with variant values winning.
Former product SKU is retained as an alias, not as a new authoritative SKU.
Inventory/movement records and business detail rows are untouched. The migration
refuses orphan products rather than losing their values. Invalid inherited
discount displays become null, matching the preceding effective display policy.

Before deploy export products, productVariants and typed detail rows to a private
file outside the repository. API clients must move money/tracking/meta to each
variant; obsolete parent fields and priceOverride are rejected. Product POST may
omit variants: the backend creates one with SKU V-{requestId}, null price and
trackStock true. Apply migrations and regenerate the client before starting the
new application. Existing worker rebuilds documents using advanced revisions.

Rollback uses a forward migration restoring former columns from the private
backup and meta -> attributes, then the preceding application. Stop mutations
during restore and reconcile newer variant edits explicitly; never overwrite
inventory or immutable command/movement history. Increment searchRevision again.
