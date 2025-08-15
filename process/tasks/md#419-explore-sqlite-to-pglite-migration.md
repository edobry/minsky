# Plan: Explore Migrating from SQLite to PGlite

## Context

We currently maintain dual Drizzle schemas (sqlite-core and pg-core) and separate migration trees for SQLite and PostgreSQL. This increases boilerplate and drift risk.

PGlite (embedded/Postgres-in-WASM or native-lite variants) could let us consolidate to a single Postgres dialect everywhere (dev/local + production), simplifying schema management and migrations.

## Goals

- Evaluate PGlite as a replacement for SQLite for the session DB.
- Aim to use a single Drizzle pg-core schema and pg migrations across environments.
- Preserve local/offline portability and simple setup.

## Questions / Evaluation Criteria

- Feature parity: JSONB, TIMESTAMPTZ, constraints, indexes.
- Extension support: pgvector (critical for embeddings?) or acceptable workarounds.
- Performance: startup, write throughput, WAL-like behavior, concurrency.
- Persistence model: on-disk persistence, file size limits, backups.
- Drizzle compatibility: postgres-js driver support and migrator support under PGlite.
- Operational concerns: CPU/memory overhead, platform compatibility, CI support.

## Migration Concept

- Keep Postgres migrations as the single source (drop sqlite migrations over time).
- Add a one-time migrator from existing SQLite DB to PGlite (or directly to Postgres if desired).
- Ensure `minsky sessiondb migrate` flow supports PGlite targets if adopted.

## Deliverables

- Prototype using Drizzle pg driver + PGlite for the session DB.
- Report: supported features, limitations, performance snapshots.
- Recommendation: adopt, defer, or reject; outline migration steps if adopted.

## Risks / Unknowns

- pgvector likely unavailable or limited in PGlite; embeddings may still require real Postgres.
- Concurrency semantics may differ from full Postgres.
- Project maturity and support.
