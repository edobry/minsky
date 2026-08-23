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

**Hook:** `block-nested-fork-dispatch.ts` — a thin binding since mt#4374. It reads
`subagent_type` off the payload (`isForkDispatch`), reads the override off the environment
(`isOverrideActive`), and reuses `dispatch-intent-store.ts` plus `isSubagentContext` /
`resolveSessionIdFromInput` from `dispatch-intent-write-gate.ts` for session resolution.

**Decision:** `decideNestedForkDispatchGate` in
`packages/domain/src/detectors/nested-fork-dispatch-gate.ts`. It takes the ANSWERS the binding
established — is this a fork, is it nested, is the override on, which session, which declarations,
what time — rather than a hook payload and a defaulted `env`. The old signature ended
`env: NodeJS.ProcessEnv = process.env`, a dependency parameter with a default value, which
ADR-026 rule 2 forbids; the repair was to remove the parameter, not to make it required, because
reading an override is fact-gathering and fact-gathering belongs to the binding.

**Override:** `MINSKY_ALLOW_NESTED_FORK=1` (launch-time-only).

**Fail posture:** fail-open on store-read errors only.

## Cross-references

- mt#3045 — this guard's tracking task
- mt#2865 / mem#665 — the originating incident (fork bypassed the write gate)
- `dispatch-intent-write-gate.md` — the sibling opt-in gate this guard closes a bypass of
