# RFC: Transitioning Minsky Task System to Backend-SoT + Database Overlay

Status: Draft
Owner: Minsky Team
Reviewers: TBD
Related: md#315, md#429, md#235, md#258
Date: 2025-08-19

## Summary

This RFC proposes making external task backends (e.g., GitHub Issues; current markdown artifacts) the system of record (SoT) for fields those backends natively support, while Minsky’s PostgreSQL database acts as a materialized overlay for advanced capabilities (relationships, provenance/original requirements, embeddings, search). In the near term, we deprecate the monolithic `process/tasks.md`, avoid any markdown parsing/frontmatter, and empower AI agents to edit task specs/metadata via MCP tools writing to the DB. We keep an optional, one-way export for human-readable artifacts.

## Context & Goals

- Minsky’s task domain is evolving from a markdown-first approach to a multi-backend system (medium-term emphasis on GitHub Issues (GI)).
- Recent work (md#315, md#429) introduced a PostgreSQL task DB, separated embeddings (`tasks_embeddings`), and made `tasks migrate` importer-by-default with verification and summary-only modes.
- Pain points with `process/tasks.md`:
  - Drift and fragility; requires parsing; hard to keep authoritative.
  - Poor ergonomics for agents; no structured API for updates.
  - Coupling between metadata, spec, and embeddings in a single place.
- Goals:
  - Eliminate reliance on `process/tasks.md` as SoT.
  - Make agent edits easy via MCP and API, not file parsing.
  - Prepare for GI as primary backend without overcommitting designs.
  - Retain optional, human-friendly artifacts (markdown export) without reintroducing drift.

## Current State (as of md#429)

- DB schema
  - `tasks`: metadata + spec text + `content_hash`; removed legacy `dimension`, `embedding`, `metadata` columns.
  - `tasks_embeddings`: vectors-only table with HNSW index.
- Vector storage
  - `PostgresVectorStorage` is generic and configured for `tasks_embeddings` via a factory; decoupled from tasks metadata.
- CLI
  - `tasks migrate` imports markdown→DB by default (dry-run), `--execute` applies, `--json` returns `{summary, items}`; `--summary-only` returns just `{summary, verification}`.
  - Post-verification compares source vs target with a concise summary and sample diffs.
  - `tasks index-embeddings` handles embeddings population independently.

## Pain Points

- `process/tasks.md` is fragile as a single file; editing and parsing are error-prone.
- Without webhooks, GI changes won’t be seen unless we add pull-based sync.
- Advanced metadata (relationships, provenance/original requirements) don’t fit cleanly into backends like GI and shouldn’t be forced into markdown.

## Intended Future State & Use Cases

- Backend-as-SoT per field
  - GI owns title/status/spec/body/labels; DB owns relationships, provenance/original_requirements (md#235), embeddings/search.
  - Markdown: no longer SoT; any markdown artifacts are generated read-only exports.
- Agent workflows
  - Agent reads/updates DB via MCP tools for DB-owned fields; can route backend-owned edits to backend adapters when enabled.
- Human workflows
  - Optional `tasks export --format markdown` produces readable artifacts for PRs/docs with a “generated; do not edit” header.
- Sync
  - Pull-based GI→DB sync command with dry-run/execute and verification; later, webhooks.
  - Clear conflict policy: owner-precedence by field.

## Field Ownership Policy (Per Backend)

A small, explicit map per backend indicating ownership and sync direction per field. This is a common, simple integration pattern.

```ts
type Ownership = "backend" | "db" | "none";
type SyncDirection = "pull" | "push" | "both";

type Field =
  | "title"
  | "status"
  | "spec"          // GI issue body; markdown export artifact
  | "labels"
  | "provenance"    // md#235 original_requirements
  | "relationships" // md#235 graph
  | "contentHash";

interface BackendPolicy {
  ownership: Record<Field, Ownership>;
  sync: Record<Field, SyncDirection>;
  normalize?: Partial<Record<Field, (v: any) => any>>;
  detect?: Partial<Record<Field, (src: any, tgt: any) => { changed: boolean; etag?: string }>>;
}

export const githubPolicy: BackendPolicy = {
  ownership: {
    title: "backend",
    status: "backend",
    spec: "backend",
    labels: "backend",
    provenance: "db",
    relationships: "db",
    contentHash: "db",
  },
  sync: {
    title: "pull",
    status: "pull",
    spec: "pull",
    labels: "pull",
    provenance: "push",
    relationships: "push",
    contentHash: "push",
  },
};
```

## Architectural Approach

- DB as a materialized overlay
  - Store advanced fields (md#235), search indices, and a normalized copy of backend-owned fields with `last_synced_at` and hashes/etags.
- Sync commands
  - `tasks sync github --pull [--summary-only|--json]` with verification similar to `tasks migrate`.
  - Later: webhooks to push deltas.
- MCP tools
  - `tasks.spec.get/set`, `tasks.meta.get/set` for agent edits without file parsing.
- Export-only artifacts
  - `tasks export --format markdown` generates per-task files for human consumption; never parsed back.

## Immediate Priorities (Transition Period)

1) Deprecate `process/tasks.md` reads entirely (no markdown parsing or YAML frontmatter).
2) Add MCP tools for spec/meta get/set against the DB.
3) Provide `tasks export --format markdown` to generate read-only artifacts if needed.
4) Introduce a minimal policy registry and wire importer/sync to honor field ownership.
5) Add `tasks sync github --pull` skeleton (dry-run/execute; verification; summary-only).

## Tradeoffs & Considerations

- Simplicity vs. fidelity
  - Backend-as-SoT with owner-precedence is simple and robust; dual-write bidirectional mirroring is complex and risky.
- Human editing of specs
  - Not a current requirement; keep export for humans, MCP for agents.
- GI adoption curve
  - Start with pull-only sync; add push and webhooks later.
- Performance
  - Postgres with pgvector and generic vector storage scales independently from task metadata.

## Open Questions

- Exact field list and ownership per backend (finalize when enabling GI writes).
- Provenance/original_requirements (md#235): schema details and tooling UI/CLI.
- Conflict policies beyond owner-precedence (e.g., user overrides).
- How much export formatting is desirable for docs/PRs?

## Rollout Plan

- Phase 1
  - Deprecate `tasks.md` reads; land MCP tools; implement export.
- Phase 2
  - Add GI pull-sync with verification; finalize policy maps.
- Phase 3
  - Optional push, webhook-based sync, and richer DB-owned features (relationships, provenance UI/CLI).

## References

- md#315: External Task Database foundation
- md#429: Markdown → DB migration, embeddings split, generic vector storage, importer defaults
- md#235: Task metadata architecture (provenance, relationships)
- md#258: Multi-agent supervision and provenance implications for task specs
