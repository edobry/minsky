# ADR-027: Confirm Postgres-only persistence backend (closes the ADR-002 narrative gap)

## Status

**ACCEPTED** — 2026-07-07

## Context

The July 2026 holistic audit (mt#2607, domain-core survey) flagged a "persistence-honesty"
finding (mt#2623): ADR-002 introduced a **capability-based** `PersistenceProvider`
architecture — a type-safe factory that probes runtime capabilities (specifically, whether
`pgvector` is installed) and returns the appropriately-typed provider subclass. Read
uncritically, "capability-based provider architecture" suggests a system built to support
multiple interchangeable backends. In practice, `PersistenceProviderFactory.create()`
(`packages/domain/src/persistence/factory.ts`) is, and has effectively always been in
production, a `switch` statement with exactly **one** case:

```ts
switch (config.backend) {
  case "postgres":
    provider = await PostgresProviderFactory.create(config);
    break;
  default:
    throw new Error(`Unsupported persistence backend: ${config.backend}`);
}
```

The audit's framing (mt#2623 spec) was written against a snapshot of project memory and
docs that still narrated "Postgres+SQLite" as the supported backend set — a narrative that
had already been factually overtaken by events by the time this ADR was drafted (see
"What has already happened" below), but that the docs corpus had not fully caught up with.

### What ADR-002 actually decided (re-read)

ADR-002's capability axis is **intra-Postgres**, not cross-backend: the two provider
subclasses it introduces (`PostgresPersistenceProvider` and
`PostgresVectorPersistenceProvider`) both wrap the same PostgreSQL connection; they differ
only in whether the `pgvector` extension is present. ADR-002 never claimed to support a
second storage engine (SQLite, MongoDB, etc.) — that expectation came from elsewhere: the
`DatabaseStorage` / `getStorage()` layer (a _different_, older abstraction, genesis task
mt#091) that historically had SQLite and JSON-file implementations alongside Postgres for
**session storage specifically**, and from narrative drift in operational docs (e.g.
`docs/README.md`'s "Session Storage Backends: sqlite, postgres" line, corrected in the
docs-correction commit accompanying this ADR).

### What has already happened (2026-06-08, prior to this audit)

ADR-018 (_Canonical Domain-Persistence Pattern_, Accepted 2026-06-08) already made and
recorded this exact decision, a month before this audit ran:

> "SQLite is removed outright and a Postgres connection is required... A bare install with
> no Postgres connection should fail with a clear 'configure Postgres' error, not silently
> fall back to a local SQLite file."

That decision was fully implemented:

- **mt#2339** (DONE) — removed the SQLite persistence backend, provider, and sqlite-core
  schemas.
- **mt#2329** (DONE) — migrated sessions off the old `DatabaseStorage`/`getStorage()` layer
  (the last SQLite-capable code path) onto `DrizzleSessionRepository`, Postgres-only.
- `PersistenceConfig["backend"]` (`packages/domain/src/persistence/types.ts`) is now typed
  as the **literal** `"postgres"` — not a union with `"sqlite"` — so a second backend is not
  merely undocumented, it is not expressible in the type system.
- `packages/domain/src/composition/domain.ts` and `container.ts` carry comments
  confirming "the silent SQLite fallback is gone"; `unconfigured-provider.ts` is the
  boot-tolerant replacement that surfaces a clear "PostgreSQL configuration required"
  error instead.

So the code-level and ADR-level work this task's spec anticipated ("simplify the factory
switch... or file a genuine SQLite-support task") was **already done** by ADR-018/mt#2339/
mt#2329, independently of this audit. What remained, and what this ADR closes, is:

1. A formal cross-reference from ADR-002 (the architecture doc a reader would consult
   first, given its name) to ADR-018's decision, so the two ADRs don't read as
   contradictory or incomplete in isolation.
2. Correcting the residual "Postgres+SQLite" narrative that had not caught up with the
   code across several operational docs (see the accompanying docs-correction commit:
   `docs/README.md`, `docs/repository-configuration.md`,
   `docs/deploy-minsky-railway.md`, `docs/sessiondb-migration-guide.md`,
   `docs/sessiondb-troubleshooting.md`, `docs/github-issues-backend-guide.md`,
   `docs/supabase-pooler-switch.md`).
3. An explicit ratification that no SQLite-support gap exists — i.e., confirming the "or
   file a genuine SQLite-support task" branch of the spec's decision does NOT apply,
   because ADR-018 already evaluated and rejected that path (SQLite was "already broken
   for the modern repos" — ask/pr-watch/attention/tasks' SQL tier are Postgres-only
   Drizzle, incompatible with a `bun-sqlite` handle) in favor of Postgres-only-now,
   PGlite-later-if-ever (mt#434).

## Decision

**Ratify Postgres as the sole supported persistence backend, with `PersistenceProviderFactory`
already correctly reflecting that as a single-case switch.** No further code change to the
factory is required by this ADR — the "simplify the factory" success criterion from mt#2623
was satisfied by mt#2339 before this ADR was drafted. This ADR's job is to:

1. **Formally cross-reference ADR-018** from ADR-002 (edit applied alongside this ADR) so a
   reader of ADR-002 is pointed at the backend-count decision instead of inferring
   multi-backend intent from the capability-detection framing.
2. **Confirm no SQLite-support gap exists.** SQLite is not coming back as a second backend.
   If a zero-dependency **embedded** local-Postgres option is ever wanted (offline dev,
   single-binary distribution), the vehicle is **PGlite** (mt#434) — same `pg-core`
   dialect, pgvector-capable — not SQLite. mt#434 remains deferred/demand-gated; it is not
   authorized by this ADR.
3. **Retire the capability-detection framing's implicit multi-backend reading.** ADR-002's
   "Future Considerations → Capability Evolution" section (runtime capability changes) is
   about pgvector-presence sensing, not backend pluggability — this ADR does not change
   that section, only clarifies (via cross-reference) that it was never a multi-backend
   axis.
4. **Correct the residual doc narrative** — done in the docs-correction commit accompanying
   this ADR (see file list above).

## Consequences

**Easier:**

- New contributors reading ADR-002 are pointed directly at ADR-018 and this ADR for the
  backend-count answer instead of inferring (incorrectly) that SQLite is a supported
  fallback from the capability-factory framing.
- Docs and code now agree: Postgres is the only backend, at both the narrative and the
  type-system level.

**No change required:**

- `PersistenceProviderFactory.create()` — already a single-case switch (mt#2339).
- `PersistenceConfig["backend"]` — already a `"postgres"` literal type (mt#2339).

**Deferred, not authorized here:**

- PGlite as an embedded local-Postgres option (mt#434) — remains demand-gated future work,
  unaffected by this ADR.

**Known residual doc debt (out of scope for this ADR, flagged as a follow-up):**

- `docs/sessiondb-migration-guide.md` and `docs/sessiondb-troubleshooting.md` are ~500-line
  guides built almost entirely around now-nonfunctional SQLite command examples
  (`minsky sessiondb migrate to sqlite`, `sqlite3 ... .recover`, etc.). This ADR's
  accompanying docs commit adds corrective banners to both files but does not purge/rewrite
  them — that is a larger doc-hygiene effort tracked as a follow-up task (see PR body).

## Cross-references

- **Amends/extends:** [ADR-002](adr-002-persistence-provider-architecture.md) — adds a
  cross-reference to ADR-018 and this ADR for the backend-count decision.
- **Ratifies:** [ADR-018](adr-018-domain-persistence-pattern.md) §"SQLite consequence
  (explicit)" — the actual decision record; this ADR is a confirming cross-reference, not a
  new decision.
- **Implemented by:** mt#2339 (SQLite backend removal, DONE), mt#2329 (sessions migration
  off `DatabaseStorage`, DONE).
- **Deferred:** mt#434 (PGlite as future embedded-Postgres option).
- **Originating audit:** mt#2607 (July 2026 holistic audit), mt#2623 (this task).
