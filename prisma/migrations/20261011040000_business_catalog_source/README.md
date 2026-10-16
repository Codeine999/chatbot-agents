Physical business fields in search/planner/answer evidence now use code presets and
the selected detail table, independently of ProductAttributeDefinition rows.
Custom JSON fields retain their existing visibility and search policies.

This migration only increments searchRevision to let the index worker rebuild
derived documents. It does not alter source values or schema. Deploy the code
and run the existing indexing worker; embedding calls follow normal usage gates.
Rollback: restore the earlier code and increment searchRevision again for the
same companies to rebuild its document format. Never decrement revisions or
restore stale vectors. Null or invalid legacy JSON no longer substitutes for
missing physical values; the preceding migration preserved that JSON for review.
