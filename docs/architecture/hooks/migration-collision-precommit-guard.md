# Migration-collision pre-commit guard (mt#2948)

**Trigger.** Pre-commit step in `src/hooks/pre-commit.ts` (`runMigrationCollisionCheck`), a sibling
of the immutable-migration (mt#2268) and migration-journal-consistency (mt#2087) checks.

**What it blocks.** A staged Drizzle migration journal
(`packages/domain/src/storage/migrations/pg/meta/_journal.json`) that drifts from the `origin/main`
baseline in any of three ways:

1. **`when`-mutation** — an entry whose `tag` is already on `origin/main` has a different `when`
   value in the staged tree (a concurrent-migration renumber backdated/advanced an already-shipped
   migration's timestamp).
2. **number-collision** — a new entry (tag not on `origin/main`) reuses a migration NUMBER (the
   `NNNN` prefix) already present on `origin/main`.
3. **non-monotonic** — a new entry's `when` is `<=` the max `when` already on `origin/main`,
   re-introducing the non-monotonic-journal disease.

**Why.** Drizzle applies journal entries whose `when` exceeds the DB high-water-mark (memory
`0c2427e5`). The 2026-07-19 ~5h production outage was caused by exactly (1): two parallel agents
generated migration 0060, and the renumber-resolution rewrote the `when` of already-applied
0061/0062 above the prod ledger watermark, so boot-time auto-migrate re-applied 0061 → crash. This
guard is the collision-_prevention_ complement to mt#2560 (auto-migrate default OFF, the
blast-radius fix).

**Delta over existing guards.** `immutable-migration-detector.ts` (mt#2268) checks `.sql` file
CONTENT only; `migration-journal-check.ts` (mt#2086/2087) checks sql↔journal SET consistency in the
LOCAL tree only. Neither reads the `origin/main` baseline or compares `when` VALUES — which is what
this guard adds (via `git show origin/main:<journal>`).

**Detector.** `src/hooks/migration-collision-detector.ts` — pure functions
(`detectMigrationJournalViolations`, `extractMigrationNumber`, `VIOLATION_KIND`), no I/O; the
pre-commit wiring reads the staged journal + the `origin/main` baseline and passes both in.

**Override.** `MINSKY_SKIP_MIGRATION_COLLISION_CHECK=1` (audit-logged; registered in
`HOOK_ONLY_ENV_VARS` at `packages/domain/src/configuration/sources/environment.ts`, mt#1788). Use
only for a rare sanctioned reconcile.

**Fail posture.** Fails OPEN: skips (permits) when there is no local journal, or no `origin/main`
baseline (fresh clone / detached HEAD / file absent on main), or the baseline read errors — it is a
NEW-drift detector, not a first-commit correctness gate. Blocks only on a confirmed drift against a
readable baseline.

**Remediation the guard prints.** `git fetch origin && git rebase origin/main`, then
`bun run db:generate:pg` — so the migration is numbered after main's latest with a fresh timestamp.

**Tracking:** mt#2948. Siblings: mt#2268, mt#2087, mt#2344 (same pre-commit surface). Blast-radius
sibling: mt#2560.
