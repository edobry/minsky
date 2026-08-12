# `inject-memory-capture` — surfacing a resident-memory capture

**Event:** `UserPromptSubmit` · **Posture:** advisory (non-blocking) · **Override:**
`MINSKY_SKIP_MEMORY_CAPTURE_NOTICE=1` · **Task:** mt#3997

## What it does

Reads `${MINSKY_STATE_DIR:-~/.local/state/minsky}/memory-captures/` for capture artifacts written
by mt#3973. For each one not yet surfaced, injects a notice naming the process role, resident MB,
and the MCP tool calls in flight with their elapsed times. Silent when the directory is absent or
holds nothing new — which is the state on essentially every turn.

## Why it exists

mt#3973 shipped the capture that mt#3885 — the leak that kernel-panicked the machine five times in
four days — had been blocked on for four consecutive handoffs. It writes an artifact naming what
the process was doing when it ballooned.

**Nothing read it.** A grep over `src/`, `scripts/`, `.minsky/` and `docs/` an hour after that
merge returned only the three writers, the module itself, the doc page, and the verification
script reading its own temp directory. No sweep, no cockpit surface, no hook.

So the investigation was blocked on a signal that would land silently on disk. The capture fires at
most once per process and the runaway is intermittent — nothing since 2026-08-08 — so the realistic
outcome was that the first real capture would be found weeks later, or never.

This is `work-completion.mdc §Invocation path required for event/poll mechanisms` in a variant that
rule's wording does not quite name: the mechanism has a caller and runs fine. What it lacked was a
**reader**. Worth noting the gate was walked during mt#3973's own planning and did not catch it,
which suggests the rule detects "nothing CALLS it" better than "nothing READS what it produces."

## Why a notice and not an ask

The obvious ADR-008 kind for "tell someone this happened" is `coordination.notify`. Read directly
from `packages/domain/src/ask/router.ts`:

```ts
case "coordination.notify":
  return {
    routingTarget: "peer",
    transport: { kind: "mesh" },
  };
```

`peer` over `mesh` — not the operator, not the inbox. `service-window-defaults.ts` describes the
kind as "fire-and-forget," and `pending-asks-for-window.ts` ranks it last of the seven. Filing a
capture as one would put the signal on a channel the principal does not read, **recreating this
hook's own bug one layer up**.

`severity: "incident"` does force operator+inbox for any kind (mt#3851), but
`communication-contract.mdc` conditions the marker on remediation being **operator-only**, and a
capture's remediation — investigate the named tool — is not; an agent does it. Using the marker
would borrow a paging mechanism for a non-paging signal and spend against its 3-per-24h ceiling.

`direction.decide` routes to operator+inbox correctly but is not a decision; misclassifying to buy
routing is the same borrow in a different coat.

A **cockpit surface** is a genuine option and arguably the best long-term home, given the cockpit's
direction as the principal's primary live point of contact. It was NOT taken here because a new
product surface is a principal-owned call (`principal-context.mdc §Decisions Eugene reserves`) and
should not ride along inside diagnostic plumbing. It is a clean follow-up on top of this reader.

## Known bound

Claude Code only — the same limit `cockpit-deeplinks.mdc` records for the display linkifier.
Acceptable because the notice is a **pointer**; the artifact persists on disk regardless, with a
documented retrieval path in `docs/mcp-memory-forensics.md`.

## Idempotency

Keyed on **filename**, persisted to `memory-capture-notice-state.json` in the state dir. The
filename already carries the capture instant, role and pid (mt#3973 builds it that way), so it is
unique per capture and stable if a file is touched — an mtime watermark would re-fire the whole
directory whenever anything rewrote a file.

The watermark is written **before** the notice is returned. A corrupt or partially-written artifact
is named in the notice rather than skipped, and is still marked seen, so it cannot re-fire every
turn forever.

## See also

mt#3973 (`src/mcp/memory-capture.ts`, the producer) · mt#3885 (the leak) ·
`docs/mcp-memory-forensics.md` (artifact format, retrieval, the ~10x heap-snapshot measurement) ·
ADR-008 (attention-allocation subsystem, the taxonomy this deviates from and why)
