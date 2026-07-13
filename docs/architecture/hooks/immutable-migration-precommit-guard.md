# Immutable-Migration Pre-Commit Guard

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A step in the pre-commit pipeline (`src/hooks/pre-commit.ts`,
`runImmutableMigrationCheck`, between the migration-journal check and the
deploy-domain check) that blocks committing a staged **modification or rename**
of a migration `.sql` file whose tag is already listed in that directory's
`meta/_journal.json` (i.e. has been applied). Like the NUL-byte / Workspace-COPY
/ Deploy-Domain guards, this is a true git pre-commit step invoked by the
`PreCommitHook` class from `.husky/pre-commit` — not a Claude Code PreToolUse
hook.

**Hook file (in-pipeline step):** `src/hooks/pre-commit.ts` →
`runImmutableMigrationCheck()`. Pure-function implementation:
`src/hooks/immutable-migration-detector.ts`
(`detectImmutableMigrationViolations`).

**Why this check exists.** Originating incident: mt#1641 / mt#2250
(2026-06-02/03). Three applied migrations (`0002`, `0014`, `0015`) were **edited
after being applied** to the prod database. Drizzle records `sha256(full .sql)`
at apply-time and never re-checks the file against the ledger, so editing an
applied migration makes the file-hash diverge from the recorded hash — and (under
drizzle's timestamp high-water-mark apply logic, see memory `0c2427e5`) silently
drifts the ledger from actual DB state. Reconciling the resulting prod drift
required seven hand-audited prod writes. This guard catches the class at the
commit, the cheapest authoring stage.

**Detection.** Staged files are read via `git diff --cached --name-status
--diff-filter=MR`. A violation is a staged `M` (modification) — or the OLD path
of a staged `R` (rename) — that is a `.sql` file located **directly inside** a
watched migration dir (`packages/domain/src/storage/migrations/pg` or
`packages/domain/src/storage/migrations`; files under `meta/` or other
sub-directories are NOT direct children and are skipped) AND whose `<tag>`
(filename minus `.sql`) appears in that dir's `_journal.json` entries. Dirs are
matched longest-prefix-first so the nested `pg` dir is never swallowed by its
parent regardless of declaration order. Pure **additions** of new migration
files (the correct path) and edits to **unjournaled** (never-applied) tags are
always allowed.

**On hit:** the step blocks, naming each violating file + tag, explaining the
immutability invariant, and instructing the operator to write a NEW migration
(`bun run db:generate:pg`) instead of editing the applied one.

**Override mechanism:** Set `MINSKY_SKIP_IMMUTABLE_MIGRATION_CHECK=1` (or `true`
/ `yes`) before committing — for the rare legitimate case (e.g. fixing a
never-applied migration before its first deploy). The override emits an
audit-log line to stdout (env value + ISO timestamp).

**Env-var registration:** `MINSKY_SKIP_IMMUTABLE_MIGRATION_CHECK` is registered
in `HOOK_ONLY_ENV_VARS` at
`packages/domain/src/configuration/sources/environment.ts` (per mt#1788). The
override env-var name's source of truth lives in
`src/hooks/immutable-migration-detector.ts` as the exported constant
`IMMUTABLE_MIGRATION_CHECK_OVERRIDE_ENV` so the hook, the test, and this rule
cannot drift.

**Relationship to the unmerged-migration guard (mt#2277):** that sibling blocks
_applying_ an unmerged migration to shared prod; this guard blocks _editing_ an
already-applied one. Together they retire the mt#2229 / mt#2250 migration-drift
class.

**Cross-references:**

- mt#2268 — this guard's tracking task
- mt#1641 — runtime schema-drift detector (read-only); mt#2250 — the prod-ledger
  reconciliation; mt#2227 — runner path/journal-monotonicity fix
- memory `0c2427e5` — drizzle's timestamp-high-water-mark apply mechanics
- mt#1824 / mt#1984 / mt#2208 — sibling pre-commit-step guards this one mirrors
- mt#1788 — ESLint rule + `HOOK_ONLY_ENV_VARS` (env-var registration contract)
