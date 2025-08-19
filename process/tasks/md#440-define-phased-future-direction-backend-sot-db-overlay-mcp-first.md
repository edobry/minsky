# Define Phased Future Direction: Backend-SoT + DB Overlay, MCP‑First (Minimal Path)

Status: TODO
Priority: HIGH

## Summary

Codify a simple, phased plan for the Minsky task system that:
- Treats external backends as the system of truth (SoT) per field in the future.
- Uses Postgres as a materialized overlay for advanced capabilities.
- Deprecates `process/tasks.md` as an input (export‑only artifacts if needed).
- Enables agents to edit via MCP first, not direct file edits.

This task focuses on the minimal path now and explicitly defers complex pieces as progressive enhancements.

## Context

- Immediate priorities: move fast, reduce scope, avoid fragile markdown parsing/frontmatter.
- Medium‑term: GitHub Issues becomes the primary backend; DB overlay adds relationships, provenance, embeddings, search.
- Feedback highlights: define normalization/hash, conflict semantics, export contract, optional link table for backend sync, and embedding job queue – but do not front‑load them.

## Goals (This Task)

1) Record the minimal target architecture and phased rollout at a high level (operator/developer‑facing plan).
2) Align near‑term work with the minimal DB‑only path and MCP‑first editing.
3) Keep advanced design items out of the critical path (clearly phased follow‑ups).

## Non‑Goals

- Implementing GitHub sync (pull/push/webhooks).
- Implementing per‑field ownership policy mechanics.
- Implementing normalization/hash changes beyond current capabilities.
- Implementing embedding job queues or new DB link tables.

## Phase 1 (Now): Minimal, Fast Path

- Backend: `db` (ID prefix `db#`) – source of truth is Postgres `tasks`.
  - No reads of `process/tasks.md` in runtime.
  - Existing importer writes tasks as `backend = db`.
- MCP editing surface (DB‑owned only):
  - `tasks.spec.get(id)` → { id, spec, contentHash }
  - `tasks.spec.set(id, spec, ifMatchContentHash?)` → { id, newContentHash }
  - Return 409 on stale `ifMatchContentHash`.
- Manual export (optional; not automatic):
  - `minsky tasks export --format markdown --out docs/tasks/`
  - Banner: “GENERATED – DO NOT EDIT. Source of truth is the database.”
  - Export is never parsed by the system.
- Guardrails:
  - Config flag `tasks.strictDbMode` (or equivalent) to error if in‑tree backends are used.

Acceptance (Phase 1):
- All task read/write go to DB for `db` backend.
- MCP spec get/set works with optimistic concurrency and dry‑run.
- Manual export writes stable, readable files with a do‑not‑edit header.
- Strict mode blocks legacy backends when enabled.

## Phase 2 (Follow‑ups; separate tasks)

- Normalization & Hashing (deterministic):
  - Define canonicalization for spec/title/labels; keep current hash impl for now; evaluate BLAKE3 later.
  - Golden test vectors to ensure identical outputs cross‑platform.
- Conflict Semantics (explicit):
  - Document reject‑on‑stale semantics for DB‑owned fields; return fresh hashes.
  - CLI/MCP return structured errors with current vs expected contentHash.
- Export Contract (normative):
  - Stable filenames `{taskId}-{slug}.md`; header/footer markers with contentHash and exportedAt.

## Phase 3 (Future; separate tasks)

- Backend link table (sync anchor) and pull‑only GitHub sync with dry‑run/summary/verification.
- Embedding operations queue to decouple compute from writes; drain via `tasks index-embeddings`.
- Webhooks + push with optimistic concurrency using backend ETags.
- Provenance/original‑requirements schema and UI/CLI.

## Tradeoffs & Rationale

- Reduced scope (Phase 1) lets us ship quickly without complex bidirectional sync or ownership policy engines.
- MCP‑first edits keep agents productive with strong guardrails and minimal surface.
- Export‑only artifacts maintain human readability without reintroducing drift or parsing.
- Advanced items are explicitly phased so each can be delivered and reviewed independently.

## Acceptance Criteria (This Task)

- A clear, concise plan is recorded (this document) that teams can execute immediately.
- Phase 1 scope is unambiguous and maps to existing minimal work streams (db backend, MCP spec edits, manual export, strict mode).
- Phase 2/3 items are called out as future tasks (not blocking Phase 1).
