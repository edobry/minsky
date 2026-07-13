# ADR-018: Canonical Domain-Persistence Pattern

## Status

Accepted (2026-06-08)

## Context

ADR-002 standardized the **provider** layer — a capability-based `PersistenceProvider`
hierarchy (`BasePersistenceProvider.getStorage()`, `SqlCapablePersistenceProvider.getDatabaseConnection()`,
`VectorCapablePersistenceProvider.getVectorStorage()`). It never standardized the
**domain-repository** layer that sits on top of the provider. As a result the domain layer
has accreted 3+ divergent persistence idioms with no ADR declaring a canonical one:

| Domain                            | Idiom                                                                                    | Provider tier used            |
| --------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------- |
| **sessions**                      | `SessionDbAdapter` -> `getStorage()` -> `DatabaseStorage<SessionRecord, SessionDbState>` | base/portable `getStorage()`  |
| **tasks** (minsky backend)        | inline drizzle behind the `MinskyBackendDb` seam                                         | SQL `getDatabaseConnection()` |
| **ask / pr-watch / wake-pending** | `Drizzle<X>Repository implements <X>Repository` + `Fake<X>Repository`                    | SQL `getDatabaseConnection()` |
| **memory / similarity**           | service + `VectorStorage` interface (`PostgresVectorStorage` / `MemoryVectorStorage`)    | vector `getVectorStorage()`   |
| **transcripts**                   | service holding a raw `PostgresJsDatabase`, pgvector `<=>` / Postgres FTS inlined        | SQL `getDatabaseConnection()` |

### Why the divergence exists (it is drift, not principled need)

The `getStorage()` / `DatabaseStorage` layer was built at genesis (mt#091) to abstract
**three** session-storage backends: JSON-file, SQLite, and Postgres. `SessionDbState = {sessions: []}`
is the JSON-file blob shape. The JSON/file backend was later deleted (#402 "Remove JSON
sessiondb backend entirely" + mt#714), so the portability rationale for the `DatabaseStorage`
abstraction evaporated — yet sessions were never migrated off it. ADR-002 then introduced the
capability-based provider, wrapped the old storage layer as the base `getStorage()` tier, and
new domains (ask, pr-watch) adopted the modern `Drizzle*Repository + Fake` pattern. Sessions
remain on the obsolete mt#091-era layer. mt#1610 began a `sessiondb`->`persistence` rename but
left `session-db-adapter` and a misleading "Session provider unavailable... restart with /mcp"
error in place.

**Conclusion:** the portable `DatabaseStorage` layer guards against a backend (JSON/file) that
was removed years ago. The divergence is drift with an obsolete historical justification.

### Investigation findings (2026-06-08; evidence in `## Cross-references`)

1. **`getStorage()` has exactly one production consumer:** `session/session-db-adapter.ts`.
   No other domain calls it (verified sweep; the only other hits are provider internals, a
   throwing rules stub, and test fakes). Even sessions' own merge/PR operations bypass it
   for `getDatabaseConnection()`.
2. **No non-SQL storage backend exists.** Only `postgres-storage.ts` + `sqlite-storage.ts`
   implement the portable layer.
3. **ask/pr-watch repositories are postgres-only in practice.** Their schemas use
   `drizzle-orm/pg-core` exclusively (`jsonb`, `uuid().defaultRandom()`, `::jsonb` literals,
   partial indexes) and every write uses `.returning()` — a Postgres-only Drizzle feature.
   The sqlite provider returns a `bun-sqlite` handle that is type- and runtime-incompatible
   with the `PostgresJsDatabase` these repositories require. SQLite is the _default_ dev
   backend, but **no path successfully runs a `Drizzle*Repository` against it.** SQLite-as-a-full-backend
   is therefore _already_ non-viable for every modern domain (ask, pr-watch, attention,
   tasks' SQL tier). The portable `DatabaseStorage` layer is an island of SQLite compatibility
   that **sessions alone** still enjoy.
4. **Tasks' multi-backend `TaskBackend` abstraction sits above persistence.** Only
   `MinskyTaskBackend` touches the DB (via the narrow `MinskyBackendDb` seam);
   `GitHubIssuesTaskBackend` is Octokit-only and GitHub is the sole store for GHI tasks
   (the one DB-delete path in `github-issues-api.ts` is dead code — the backend never passes
   the `persistenceProvider` argument that would activate it). External (GHI) tasks are **not**
   mirrored into `tasks` / `task_specs` / `task_relationships`.
5. **The vector domains already have a clean repository-equivalent.** `VectorStorage`
   (`store` / `search` / `delete` / `getMetadata`) with `PostgresVectorStorage` (pgvector) and
   `MemoryVectorStorage` (in-memory L2) is structurally the `Drizzle*Repository + Fake` pattern
   under a different name — the in-memory impl is a faithful-enough fake because `MemoryVectorStorage`'s
   L2 distance matches `PostgresVectorStorage`'s default `<->`. Transcripts are the exception:
   `TranscriptSimilarityService` / `TranscriptFtsService` hold a raw `PostgresJsDatabase` and
   inline pgvector `<=>` / Postgres `plainto_tsquery`, with no swappable abstraction.

## Decision

We will enshrine **one principle with two concrete shapes**, and migrate the laggards toward it.

**The principle.** Every domain's persistence is a domain-owned interface with a real backend
implementation and a fake implementation, both injected via DI (no `deps?.x ?? createReal()`
fallbacks). This is the testability contract ADR-002's provider layer enables but never named at
the domain layer.

**Shape 1 — SQL-CRUD domains (canonical).** A `Drizzle<Domain>Repository implements <Domain>Repository`
paired with a `Fake<Domain>Repository`, constructed from `getDatabaseConnection()`. This is the
ask / pr-watch / wake-pending pattern. It is **Postgres-targeted** by design; SQLite is not a
supported runtime for these repositories and the pattern does not pretend otherwise.

**Shape 2 — vector/similarity domains (canonical).** The `VectorStorage` interface is the
persistence seam, with `PostgresVectorStorage` (real) and `MemoryVectorStorage` (fake) injected via
the domain factory. We recognize `VectorStorage` as the vector-domain instance of the same
principle rather than forcing a `Drizzle*Repository` rename. Ranking fidelity of the fake is
**not** a test contract; tests assert routing, filtering, degradation, and structural behavior.

**Per-domain decisions:**

- **Sessions (migrate):** migrate `SessionDbAdapter` to a `DrizzleSessionRepository implements SessionProviderInterface`
  plus a `FakeSessionProvider`, constructed from `getDatabaseConnection()`, then **delete the
  `DatabaseStorage` storage-backend layer** (~1,834 LOC across `postgres-storage.ts`,
  `sqlite-storage.ts`, `database-storage.ts`, `session-db.ts`, `session-db-adapter.ts`, plus the
  `getStorage()` / `SessionStorage` surface on the provider). Sessions become Postgres-only —
  **consistent with every other modern domain**, which already is.
- **Tasks (in scope, at one layer only):** extract a `DrizzleTaskRepository` behind the existing
  `MinskyBackendDb` seam — the persistence internals of the minsky backend only. The multi-backend
  `TaskBackend` abstraction stays above it unchanged; GHI/markdown backends get no repository
  (GitHub is their store).
- **Memory / similarity (conform-and-rename, lower priority):** these already satisfy the principle
  via `VectorStorage`. Optionally name the CRUD seam (`MemoryServiceDb` -> `MemoryRepository`) for
  consistency; no behavioral change.
- **Transcripts (excluded until an abstraction exists):** adopting the pattern requires first
  introducing a `TranscriptSearchRepository` interface to lift the inlined pgvector/FTS out of the
  service. Tracked separately; out of scope for the initial migration.

### SQLite consequence (explicit)

Deleting `DatabaseStorage` removes the only SQLite-capable session path. This is acceptable because
SQLite-as-a-full-backend is _already_ broken for ask / pr-watch / attention / tasks' SQL tier — the
session island is the lone exception, not a load-bearing capability.

**Decision (2026-06-08):** SQLite is removed outright and a Postgres connection is required —
consistent with Minsky already requiring hosted-service access (AI providers, the forge) and with
`decision-defaults.mdc §Datastores`. A bare install with no Postgres connection should fail with a
clear "configure Postgres" error, not silently fall back to a local SQLite file. The SQLite-backend
removal is tracked in **mt#2339**. If a zero-dependency offline / single-binary local story is ever
wanted, the vehicle is **PGlite** (embedded WASM Postgres — same `pg-core` dialect, pgvector-capable),
tracked in **mt#434** — not SQLite, and not the mt#091-era `DatabaseStorage` abstraction.

## Consequences

**Easier:**

- One canonical pattern per persistence shape; new domains have an unambiguous template.
- ~1,834 LOC of dead-portability scaffolding deleted; the provider's `getStorage()` base tier
  and `SessionStorage` type retire with it.
- Session tests gain a real `FakeSessionProvider` (DI fake) instead of routing through
  `DatabaseStorage` machinery.
- The misleading `createSessionProvider` "restart with /mcp" error is removed in the same migration
  (coordinates with mt#2323).

**Harder / committed:**

- A Postgres connection becomes required (SQLite removed, mt#2339). In practice this removes an
  already-dead path — SQLite was unused (prod + the principal's config + CI all run Postgres or
  in-memory fakes) and already broken for the modern repos. The deferred offline option is PGlite
  (mt#434), not SQLite.
- The migration touches the hot session-CRUD path; it must preserve `SessionProviderInterface`
  behavior exactly and land behind full session-lifecycle tests (complete-alignment-before-deletion
  discipline — align + verify, then delete).
- Transcripts remain non-conforming until their abstraction-extraction task lands; the ADR
  accepts a known, tracked exception rather than forcing a low-fidelity fake.

**Follow-up tasks produced by this ADR** (filed as children of mt#2328):

1. **mt#2329** — Migrate sessions to `DrizzleSessionRepository` + `FakeSessionProvider`; delete the
   `DatabaseStorage` layer (~1,834 LOC); remove the misleading provider error string.
2. **mt#2330** — Extract `DrizzleTaskRepository` behind `MinskyBackendDb` (minsky-backend internals).
3. **mt#2331** — Introduce a `TranscriptSearchRepository` abstraction so transcripts can adopt the
   pattern (owner of the transcripts exclusion).
4. **mt#2332** — (Lower priority) Name the memory/similarity CRUD seam `*Repository` for consistency.
5. **mt#2339** — Remove the SQLite persistence backend; require Postgres (the §SQLite-consequence
   decision; coordinates with mt#2329 — they share `sqlite-storage.ts` + the dual `session-schema.ts`).

## Cross-references

- **Extends:** ADR-002 (persistence-provider architecture — the provider layer this builds on).
- **Related tasks:** mt#2328 (this investigation + ADR); mt#434 (SQLite->PGlite, the separate
  local-backend decision the SQLite consequence defers to); mt#2323 (forge\_\* DI / bare
  `createSessionProvider` + misleading error string); mt#1610 (partial `sessiondb`->`persistence`
  rename); mt#091 (genesis 3-backend storage), #402 / mt#714 (JSON backend removal),
  mt#407 / mt#761 / mt#690 (ADR-002 integration), mt#2108 (domain-package extraction).
- **Memory:** `df19d9e1` (Postgres-via-Supabase default datastore — ADR-002 builds on it);
  `70b595dc` (vector/search index is derived data — informs the transcripts/vector treatment,
  ADR-013); `021b612a` (architecture patterns — "no DI fallbacks", "complete alignment before
  deletion").
- **Key code (evidence):** `packages/domain/src/session/session-db-adapter.ts` (sole `getStorage()`
  consumer); `packages/domain/src/persistence/types.ts` (capability tiers); `.../ask/repository.ts`,
  `.../pr-watch/repository.ts`, `.../ask/wake-pending-repository.ts` (Shape 1 reference);
  `.../storage/vector/{types,postgres-vector-storage,memory-vector-storage,vector-storage-factory}.ts`
  (Shape 2 reference); `.../tasks/{taskService,minskyTaskBackend,githubIssuesTaskBackend}.ts`
  (tasks layering); `.../storage/backends/{postgres,sqlite}-storage.ts`, `.../storage/database-storage.ts`,
  `.../session/session-db.ts` (the deletable `DatabaseStorage` layer).
