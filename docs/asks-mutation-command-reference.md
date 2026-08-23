# Ask Mutation Command Reference

## Overview

An Ask is a structured question routed to a resolver (ADR-008). Four commands mutate one after it
exists, and picking between them is the whole of this document — they are close enough in shape to
be confused, and three of the four are irreversible in a way the fourth is not.

**The discriminating question is what you are changing**, not how much:

| You want to change                                                                 | Command        | Changes `state`?  |
| ---------------------------------------------------------------------------------- | -------------- | ----------------- |
| What the ask SAYS — question, title, options, context refs                         | `asks_edit`    | No                |
| Where the ask POINTS — parent task, or a routing target the router failed to write | `asks_repair`  | No                |
| Answering it — the resolver's decision, recorded                                   | `asks_respond` | Yes → `closed`    |
| Retiring it unanswered, with a record of who retired it                            | `asks_cancel`  | Yes → `cancelled` |

The first two are non-terminal and repeatable; the last two are terminal and are not.

## `asks_repair` — graph and routing fields (mt#4305)

```bash
minsky tools asks repair <id> [--parent-task-id <mt#N>] [--repair-routing-target] [--editor <id>]
```

`id` accepts a full UUID, an unambiguous prefix (≥8 hex chars), or an `ask#N` short id.

### Why this is not part of `asks_edit`

`EditAskFields` (`packages/domain/src/ask/repository.ts`) is deliberately content-only. Its own
docblock states that lifecycle, routing and service-window fields "are owned by their respective
mechanisms (state machine, router, reaper) and are NOT reachable through `updateContent`." That
boundary is about who may REWRITE a field, and it is correct.

What it did not answer is what happens when the owning mechanism gets a field wrong, or never
writes it. `asks_repair` is that answer — a separate verb for correcting a mechanism's output,
rather than a widening of the surface a producer may rewrite.

### `--parent-task-id` — move the ask to a different parent

- The target task must exist. A reparent to a task nothing resolves is **refused**: every consumer
  that walks the graph from the parent side (`listByParentTask`, the cockpit task page, the sweeps)
  would simply never see the ask again.
- A **terminal** target task is **allowed**. Moving an ask onto a task that has since closed is a
  legitimate correction of the historical record, and since mt#3215 the stale-suspended sweep no
  longer closes asks on parent-terminal for the class where that used to matter.
- Reparenting to the parent it already has is refused as a no-op.

### `--repair-routing-target` — fill a target the router never persisted

**This flag takes no value, and that is the security property, not an ergonomic choice.** A verb
that set `routingTarget` from caller input would let an agent address an ask to itself and route
around the operator entirely. So:

1. There is no parameter that can name a target.
2. The value is re-derived by re-running the router (`policyFirstRoute` →
   `routeResultToOutcomeWrite`), so what lands is what the router itself would have chosen —
   including the mt#3491 rule that a creator-specified `"operator"` beats the kind→target default.
3. An ask that **already carries** a target is refused. Filling an absent field is a repair;
   replacing a present one is a re-route, and this verb is not that.

If the router would now resolve the ask by POLICY rather than route it, the command refuses. That
outcome is a _disposition_, not a routing target: stamping `policy` on a suspended row would leave
it exactly as invisible to the operator as the NULL being fixed, while looking repaired. Answer it
or retire it instead.

### When you need it

The originating case (mt#4450): an early return in the elicitation dispatch path skipped
`persistRouteOutcome`, so suspended asks landed carrying no `routingTarget` at all. The cockpit
inbox filters `routingTarget === "operator"` on both its list and resolve paths
(`src/cockpit/routes/asks.ts`), so those asks were invisible AND unresolvable there — while
remaining answerable through `asks_respond`, which accepts any suspended ask regardless of target.
An operator could not find them; an agent that knew the id could still answer them.

That root cause is fixed. This verb exists for the rows minted before the fix, and for the next
mechanism that drops the field.

### Guarantees

- **State is never changed.** A suspended ask stays suspended and stays in the operator queue. This
  is not a disposal route — that is `asks_cancel`, which records who retired the ask and why.
- **Terminal asks are refused** (closed / cancelled / expired), enforced twice: a friendly
  pre-check, and an optimistic-concurrency `WHERE state NOT IN (...)` on the write, so a concurrent
  close between read and write cannot slip a repair onto a terminal row.
- **Provenance lands in the same write as the change.** Every repair appends a note to the
  append-only `metadata.editHistory` — the same array the content edits write — carrying the
  timestamp, the editor, the fields touched, and for a reparent the **prior parent** under
  `previous.parentTaskId`. A routing repair records no `previous`: it only ever fills an absent
  target, so there is no prior value to keep.

## Cross-references

- `docs/architecture/adr-008-attention-allocation-subsystem.md` — the Ask entity and its lifecycle.
- `packages/domain/src/ask/repair.ts` — the domain verb and the authority rule in full.
- `packages/domain/src/ask/edit.ts` — the content surface and its provenance keys.
- `packages/domain/src/ask/close-as-resolved.ts` — the two terminal paths.
- `docs/research/mt1529-inbox-cli-ux-spec.md` — a point-in-time design brief for post-v1 inbox
  verbs. It predates these commands and treats `src/adapters/shared/commands/asks.ts` as a
  read-only anchor; the command registrations there, not that brief, are the current surface.
