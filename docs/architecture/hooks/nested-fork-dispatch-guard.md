# Nested-Fork Dispatch Guard

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620 doc-index convention; back-filled
> mt#3052). The compiled rule corpus carries only a terse index entry; this file is the durable
> detail, matching the sibling pattern used by every other guard hook.

PreToolUse on `Agent` (mt#3045). The `dispatch-intent-write-gate.ts` guard (see
`dispatch-intent-write-gate.md`) is **opt-in**: an undeclared nested fork bypassed it entirely
(mem#665, an R2 recurrence of mt#2865). This guard closes the gap one layer earlier: it denies a
NESTED `fork` dispatch — the caller's `agent_id` is itself set, meaning a subagent (not the main
thread) is doing the dispatching — unless a live dispatch-intent declaration (read-only OR
implementation) already covers the calling subagent's session.

Top-level fork dispatch from the main agent is unaffected. Non-fork nested dispatch (`Explore`,
`general-purpose`, ...) is unaffected — only nested `fork` dispatch carries the full-context risk
mt#2865/mem#665 identified.

**Hook:** `block-nested-fork-dispatch.ts` (reuses `dispatch-intent-store.ts` +
`isSubagentContext` / `resolveSessionIdFromInput` from `dispatch-intent-write-gate.ts`).

**Override:** `MINSKY_ALLOW_NESTED_FORK=1` (launch-time-only).

**Fail posture:** fail-open on store-read errors only.

## Cross-references

- mt#3045 — this guard's tracking task
- mt#2865 / mem#665 — the originating incident (fork bypassed the write gate)
- `dispatch-intent-write-gate.md` — the sibling opt-in gate this guard closes a bypass of
