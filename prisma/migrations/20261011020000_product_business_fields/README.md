# Selected product business and managed fields

Apply migration before deploying the regenerated Prisma client/application. No product JSON values, prices, stock, commands or billing history are deleted. Company.productBusinessType starts null; previous additive preset history cannot prove which business the store currently wants.

Only definitions whose IDs appear in a committed APPLY_ATTRIBUTE_PRESET command's `result.created` are backfilled as presetManaged. Other legacy/custom definitions remain unmanaged to avoid archiving custom fields by inference. Selecting a business activates its managed fields and archives managed fields outside that business. Custom fields remain unchanged. An incompatible scope/type or cross-scope definition rejects the whole transaction. Returning to a business restores the existing field rows and stored values.

Company selection, field changes, command outcome and search revision invalidation commit atomically under the existing company attribute lock. Products using changed keys get a new searchRevision once per selection. Stale vectors are excluded; existing index jobs/history remain, and the normal index worker enqueues fresh documents under billing gates. Semantic retrieval may be temporarily limited until reindex completes.

The working schema also contains a draft nullable ProductVariant.price field. Its column is added without replacing priceOverride or changing pricing behavior. Required companyId/productId/attributes and the existing pricing fields have been restored to keep the schema and existing catalog services valid. Moving the authoritative price/trackStock into variants is a separate migration and API change.

Rollback with a compensating migration and the old application/client: preserve a backup of selected business/managed-field metadata and restore desired ACTIVE statuses explicitly; do not infer the old field set or delete stored attributes. Keep the added nullable columns if rollback would discard newly written metadata. Never reduce search revisions or delete command/usage history. Reindex after any restored field-status changes.
