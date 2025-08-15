# Plan: Automated Embedding Sync/Update Process

## Context

We now support task embeddings for similarity search using a Postgres (pgvector) or in-memory backend. Today, indexing is manual via `minsky tasks index-embeddings` with a batch limit and, optionally, by task. We need a plan for keeping embeddings fresh as tasks are created or change, and for recovery scenarios (dropped vectors, model changes).

This document explores the problem space, constraints, possible approaches, and principles. It does not commit to a specific implementation.

## Problem Space

- When to (re)generate embeddings:
  - New task creation
  - Task content updates (title, description, spec changes)
  - Bulk changes (model/dimension updates)
  - Recovery (vector store cleared or partially missing)
- Cost management:
  - API costs (per-call) and rate limits
  - CI vs developer machine execution
  - Batching and throttling
- Correctness and freshness:
  - Detecting staleness efficiently (hashes, timestamps)
  - Consistency with task source of truth (Markdown or other backends)
- UX/ergonomics in a CLI:
  - Predictable behavior; avoid surprising background costs
  - Clear commands for status/sync/repair

## Constraints & Considerations

- Vector store is a cache, not the source of truth. Safe to recompute.
- Teams will prefer explicit controls and observability (dry runs, counts, previews).
- Local vs CI contexts differ (credentials, costs, concurrency).
- Models and dimensions can change; old vectors may become incompatible.
- Not all changes require re-embedding (e.g., metadata-only edits).

## Potential Approaches

1) Event-triggered indexing (lightweight)
- On task create: enqueue/perform a single embedding generation.
- On task update: compute content hash; if changed, enqueue/perform re-embedding.
- Pros: Freshness with minimal overhead. Cons: still risks surprise cost unless gated by config.

2) Scheduled/CI sync
- Nightly/CI job runs `minsky tasks embeddings sync --changed-only`.
- Computes staleness via contentHash/model/dimension and updates only needed rows.
- Pros: Cost predictable, auditable. Cons: Staleness window between edits and sync.

3) Hybrid (recommended default posture)
- Auto-index on create (configurable). Updates handled by scheduled `sync`.
- Admin can run `status` to see missing/stale/orphans and take action.

4) Full background daemon
- File watchers or git hooks trigger real-time re-index.
- Pros: Always fresh. Cons: Complex, platform-specific, and cost surprises.

## CLI Surface (Tentative)

- `minsky tasks embeddings status`:
  - Shows counts and lists for: missing, stale (hash/model/dimension mismatch), orphans.
  - Options: `--json`, `--limit`, `--since <git-ref>`

- `minsky tasks embeddings sync`:
  - Flags: `--changed-only` (default), `--all`, `--dry-run`, `--batch-size`, `--sleep-ms`, `--since <git-ref>`
  - Behavior: recompute embeddings where stale/missing; supports resumable batches.

- `minsky tasks index-embeddings`:
  - Existing command; will remain as direct indexing utility.
  - Additions: `--task <id>` supported (single task).

- `minsky tasks embeddings repair`:
  - Deletes orphans, fixes indexes/schemas when possible, with `--dry-run`.

## Data Model Additions

- Metadata to store per vector row:
  - `taskId`
  - `model`, `dimension`
  - `contentHash`
  - `updatedAt`
- Staleness rules:
  - Missing row OR contentHash mismatch OR model/dimension mismatch.

## Configuration Options (Non-binding)

- `embeddings.autoIndex`: `off | onCreate | onUpdate` (default `onCreate` for minimal surprise)
- `embeddings.batch`: `{ size: number, sleepMs: number }`
- `embeddings.provider`: (existing)
- `vectorStorage.backend`: (existing)

## Principles

- Treat vectors as cache; never a single source of truth.
- Be explicit by default; avoid hidden background cost.
- Provide status/sync commands for reconciliation and audits.
- Make operations resumable and cost-aware (batching, throttling, dry-run).
- Keep implementation modular to support PG, SQLite (future), or remote stores.

## Open Questions

- Should sync obey git history (e.g., `--since <ref>`) for scoping work?
- How to surface cost estimates pre-run?
- What’s the right default for auto-index (org culture/cost sensitivity)?
- How to handle multi-backend tasks at scale (md, gh, json)?

## Next Steps (Non-committal)

- Add content hashing and model/dimension metadata (in progress).
- Implement `embeddings status` and `embeddings sync` scaffolding.
- Add config gate for `onCreate` auto-index.
- CI recipe example for nightly sync.
