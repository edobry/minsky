## Summary

Adds the `pr_watches` Postgres table and persistence layer for the operator PR-state watcher (parent mt#1234). Sibling table to `asks` (mt#1236).

- `PrWatch` entity type + `PrWatchEvent` union (`merged | review-posted | check-status-changed`)
- Drizzle `prWatchesTable` schema with CHECK constraint on `event`, composite index on `(pr_owner, pr_repo, pr_number)`, and index on `triggered_at`
- Migration `0026_add_pr_watches_table.sql` with backout comment, applied to live Postgres
- `PrWatchRepository` interface (`create`, `getById`, `listActive`, `markTriggered`, `delete`)
- `DrizzlePrWatchRepository` — Postgres implementation via Drizzle, no raw SQL
- `FakePrWatchRepository` — hermetic in-memory double for tests
- `drizzle.pg.config.ts` updated to register the new schema

## Key Changes

- `src/domain/pr-watch/types.ts` — `PrWatch` entity + `PrWatchEvent` union
- `src/domain/storage/schemas/pr-watch-schema.ts` — Drizzle pgTable following asks schema pattern
- `src/domain/storage/migrations/pg/0026_add_pr_watches_table.sql` — numbered migration
- `src/domain/pr-watch/repository.ts` — interface + Drizzle impl + fake
- `src/domain/pr-watch/repository.test.ts` — 21 hermetic tests
- `src/domain/pr-watch/index.ts` — barrel export

## Testing

- `bun test src/domain/pr-watch` — 21/21 pass
- Migration applied to live Postgres: 0 pending

AI-assisted implementation (Claude) per mt#1294.
