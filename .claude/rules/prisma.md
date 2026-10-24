---
paths:
  - "prisma/**"
---

# Prisma changes

1. Read the relevant schema files and recent migrations; find affected services, DTOs, seeds, tests.
2. `bunx prisma migrate dev --create-only --name <name>` against the local docker DB; review the SQL.
3. Plan backfill for existing rows; check FKs, onDelete, uniques, indexes, enums, Decimal precision.
4. `bun run db:generate`, then typecheck and tests.

Never use `prisma db push` or run `db:deploy` against non-local DBs. Never
rename/delete production data, change Decimal precision, or change vector
dimensions without an explicit migration plus rollback/backfill plan.
Remember: merging to main applies migrations to production.
