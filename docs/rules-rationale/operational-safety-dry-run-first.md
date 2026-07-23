# Operational Safety: Dry-Run First — extended rationale

> Extracted from `.minsky/rules/operational-safety-dry-run-first.mdc` (mt#3087 corpus trim,
> Phase 4). The compiled rule corpus carries the requirements, the >10-record threshold, and the
> dry-run scope-match STOP rule verbatim; this file holds the originating incident and the fuller
> primitive mechanics. Nothing here changes agent behavior — the directive text in the rule is
> the complete behavioral contract.

## Dry-run scope-match check — originating incident

**Originating incident (2026-07-13):** the kind backfill (`scripts/migrate-task-kinds.ts
--execute`) ran inline with no task wrapper; no gate fired; the governing RFC (Task
classification axes, Notion `363937f0`) had explicitly rejected the heuristic approach —
recorded in both Notion and memory `59d8b62d`, surfaced in-session, unconsulted — and the
dry-run's 136 proposed changes against an approved "~15" was not treated as a stop signal. Cost:
5 wrong demotions hand-reverted, a 116-task remediation cycle, and an operator authorization
round-trip (ask `f63a49d2`).

## Sanctioned primitives — full mechanics

- **`tasks_bulk-edit`** (CLI: `minsky tasks bulk-edit`) — bulk kind/tag edits over an explicit id
  list. The default call is a dry-run returning the full per-record change set plus a **token**
  (sha256 over the canonical change set, persisted in the `task.bulk_edit.dry_run` audit event).
  Execute requires that token and ABORTS when any target's state drifted since the dry-run — the
  scope-match check enforced in code: a diverged change set structurally invalidates the
  approval. Re-execution of a consumed token is an idempotent no-op (`task.bulk_edit.executed`
  event). Raw-SQL bulk updates remain explicitly unsanctioned — this primitive exists so they are
  never necessary.
- **`refs_status`** (CLI: `minsky refs status`) — id-set cross-reference: mixed refs (task ids, PR
  numbers, ask uuids) resolve to their current status in ONE call, not-found explicit per ref. Use
  this for "which of these are still active" set-diffs instead of `jq`/`comm` text pipelines (the
  2026-07-13/14 sweeps' hand-rolled versions contained real bugs: numeric-vs-lexical `comm` sort,
  a jq context-binding error).

mt#2823's approved-Ask bridge binds its grants to the same dry-run token, so an operator-approved
bulk mutation authorizes exactly the approved change set and nothing else.

## Cross-references

mt#2785 (bulk-mutation task wrapper + dry-run scope-match check) · mt#2819 (sanctioned
primitives) · mt#2823 (approved-Ask ↔ harness-permission bridge) · `decision-defaults.mdc
§Thresholds`.
