# Execution-Evidence Merge Gate

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620 doc-index convention; back-filled
> mt#3052). The compiled rule corpus carries only a terse index entry; this file is the durable
> detail, matching the sibling pattern used by every other guard hook.

PreToolUse on `session_pr_merge`: blocks a merge adding new **test files** or **operational
scripts** (`scripts/*.ts`) without an `Execution evidence:` block; dual-mode scripts need EACH
branch exercised. Hook: `require-execution-evidence-before-merge.ts`. Override:
`[unverified-tests]` title tag + follow-up task. Fail: open on unresolvable repo/PR or `gh`
failure. Siblings: `/prepare-pr` §1b, `/implement-task` §7a.

## AT-cross-reference trigger (mt#3033, calibration-first)

ADDITIVE third path, independent of the file-pattern triggers above (which remain the
unchanged, deterministic BLOCKING floor): resolves the bound task's `## Acceptance Tests` (via
`minsky tasks spec get <task> --json`), classifies each AT executable-vs-findings-shaped (skips
`state-ops`-kind tasks and findings-shaped text like "audit produces…" / "decision recorded…"),
and checks whether the `Execution evidence:` block addresses each executable AT by
number/keyword or an explicit `[atN-deferred: mt#NNNN]` marker.

Per the mt#2263 calibration ladder this ships **LOG-ONLY** (v1): an unaddressed AT appends a
record to `.minsky/execution-evidence-at-coverage-calibration.jsonl` and surfaces a WARN via
`additionalContext` — it never emits `permissionDecision: "deny"`; graduating to blocking is
tracked as mt#3059 (flip WARN -> deny once the calibration FP rate is measured) — mt#3033 ships
Phase 1 (log-only) only.

Override: `MINSKY_SKIP_AT_COVERAGE=1`. Fail: silent (no WARN) on any task-spec fetch/parse
error.

**Root incident:** mt#2542 (PR #2136 merged with proxy evidence while the spec's literal AT —
"services boot on the role" — was silently deferred and crashed production post-merge).

## Cross-references

- mt#1459 — the original execution-evidence gate (test-file / script surface)
- mt#3033 — the AT-cross-reference addition (this doc)
- mt#3059 — tracked graduation from log-only WARN to blocking deny
- mt#2542 — root incident motivating both the original gate and this extension
- `/prepare-pr` §1b, `/implement-task` §7a — the paired preventive-phase skill steps
