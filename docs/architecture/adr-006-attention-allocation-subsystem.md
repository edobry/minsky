# ADR-006: Attention-Allocation Subsystem (Ask Entity, Router, Transport Bindings)

## Status

**ACCEPTED** — Documented 2026-04-22. Produced under mt#1034. Companion to the "Attention as the scarce resource" and "Humility as a design property" principles in `docs/theory-of-operation.md` §Companion Principles.

## Context

### The scattered HITL problem

Minsky has several human-in-the-loop mechanisms that grew independently:

- The `BLOCKED` task state and its optional `blocker_reason` field
- PR approval / merge gates (`session_pr_approve`, `session_pr_merge`)
- The 2-strikes escalation rule (CLAUDE.md §Error Investigation)
- The planned Agent Inbox (mt#454) as an async queue
- The planned mesh signal channel (mt#1001) for cross-session notifications
- The Layer 2 task executor's provisional AG-UI interrupt interface (mt#700)
- CLAUDE.md's humility principle (scope escalations, architectural decisions)
- Ad-hoc manual interruption (user interjects mid-session)

Each one routes a decision to a human at some point. None of them share a domain type. Transport choices (blocking modal? async queue? subagent dispatch? policy lookup?) are made case by case, which means:

1. **Routing mistakes compound.** A decision that belongs in policy gets asked every session; a decision that belongs to the operator gets resolved silently by the agent.
2. **Attention cost is invisible.** There is no record of how many interruptions a given task cost, so there is no feedback loop for "this kind of ask is too expensive."
3. **New HITL features re-invent plumbing.** Each addition (inbox, mesh, interrupt) ships its own envelope and its own lifecycle.

### The reframe

From the mt#697 AG-UI investigation: Minsky is, at its core, **an attention-allocation system**. Every mechanism listed above is routing an ask to the cheapest resource that can resolve it, with the operator as the most expensive resource and therefore the one to conserve.

This is not a metaphor. It is the unifying domain concept that the scattered mechanisms are instances of. Without it, AG-UI looks like a protocol decision; with it, AG-UI is a wire format for a subset of sync-client asks, and the rest of the subsystem is unclaimed design space.

The companion principle — **humility as a design property** — is the posture the allocator takes toward the operator: certain classes of decisions (preference-bound direction, architectural precedent, hard-to-reverse authorization) structurally belong to the operator and the system escalates them by construction rather than resolving them under its own authority.

### Related tasks that do not compose without this layer

- **mt#697** — AG-UI evaluation; DONE, findings point to Ask subsystem as the missing layer
- **mt#454** — Agent Inbox; the natural persistence home for async asks
- **mt#1001** — mesh signal channel push; the transport for `coordination.notify`
- **mt#700** — Layer 2 task executor; emits AG-UI-shaped events and must classify asks before emitting
- **mt#781** — Locus / cockpit; the rendering surface for attention debt and open asks
- **mt#503** — premature-completion guardrails; adjacent System 3\* detector pattern (different failure mode, same shape; see mt#1035)
- **mt#953** — agent identity; provides the `{kind}:{scope}:{id}` format used as the Ask's `requestor` and `routingTarget`

Each of these has been updated to reference mt#1034 at the relevant point in its spec. This ADR is the load-bearing synthesis that lets them be implemented as composable pieces of one subsystem rather than five overlapping ones.

### Why a domain primitive is needed

An in-process tool call, a DB row in the inbox, a mesh signal, and a PR approval request are not the same thing at the transport level. But they are all instances of the same domain question: _this decision needs someone; who, under what deadline, with what context, and at what attention cost?_

Answering that question centrally — before dispatching to any specific transport — is what the Ask entity and router do. Once an ask is classified and routed, the transport layer is an implementation detail.

## Decision

We introduce the **Ask subsystem** as a new domain layer at `src/domain/ask/` composed of four elements:

1. An `Ask` entity (typed + persisted) with a classified `kind`
2. A seven-kind taxonomy with per-kind routing, SLA, and sync/async posture
3. An eight-stage lifecycle (detection → accounting) with per-kind state machines
4. A router that consults policy first, then routes by kind to the appropriate transport
5. An attention-accounting model that records cost per kind and per task

### The Ask entity

```typescript
// src/domain/ask/types.ts
export interface Ask {
  // Identity
  id: string; // ulid or uuid
  kind: AskKind; // 7-kind taxonomy (below)
  classifierVersion: string; // which classifier labeled this kind; needed to re-classify
  // when taxonomy evolves

  // Participants (agent identity from mt#953)
  requestor: AgentId; // who is asking (kind:scope:id)
  routingTarget?: AgentId | "operator" | "policy";
  // who the router selected; "operator" and "policy"
  // are first-class pseudo-agents

  // Context & payload
  parentTaskId?: string; // mt#NNN; nullable for non-task-scoped asks
  parentSessionId?: string; // session UUID when applicable
  title: string; // short summary for rendering
  question: string; // the actual ask body
  options?: AskOption[]; // decision frame, if the ask carries one
  contextRefs?: ContextRef[]; // pointers to diffs, files, specs, prior asks

  // Lifecycle
  state: AskState; // below
  deadline?: string; // ISO-8601; optional
  createdAt: string;
  routedAt?: string;
  suspendedAt?: string;
  respondedAt?: string;
  closedAt?: string;

  // Response
  response?: {
    responder: AgentId | "operator" | "policy" | "timeout";
    payload: unknown; // kind-specific; typed via discriminated union in per-kind
    attentionCost?: AttentionCost; // filled on close; see §Attention accounting
  };

  // Extensibility
  metadata: Record<string, unknown>;
}

export type AskKind =
  | "capability.escalate"
  | "information.retrieve"
  | "authorization.approve"
  | "direction.decide"
  | "coordination.notify"
  | "quality.review"
  | "stuck.unblock";

export type AskState =
  | "detected" // classifier produced it, router hasn't run yet
  | "classified" // kind assigned, router picking a target
  | "routed" // target selected; transport dispatch pending
  | "suspended" // waiting for response (sync or async)
  | "responded" // response received, not yet closed (validation/side effects)
  | "closed" // terminal
  | "cancelled" // operator or upstream cancelled before response
  | "expired"; // deadline passed with no response
```

Notes:

- **`classifierVersion`** is carried on each Ask so the taxonomy can evolve without orphaning historical rows. Ask reclassification happens as a background migration, not in the hot path.
- **`routingTarget = "operator"`** and **`"policy"`** are pseudo-agents, not a stringly-typed hack: they represent the two non-agent resolvers and are treated as first-class routing targets with their own SLAs.
- The entity is **generic across transports**. An Ask that ends up routed to AG-UI and one routed to the inbox have the same schema; the difference is a function of `kind` × `routingTarget` × the transport adapter.

### The 7 ask kinds

Naming is `{domain}.{verb}`. The taxonomy is deliberately narrow — each kind is a distinct routing/SLA/posture cluster, not a UX category.

| Kind                    | What it asks                                                                | Sync/Async                   | Default target                                | Cost register                                   |
| ----------------------- | --------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------- | ----------------------------------------------- |
| `capability.escalate`   | Thinker is not smart enough — bigger model, specialist subagent             | Sync, seconds                | Subagent (Opus / specialist)                  | Token; no operator cost unless escalation fails |
| `information.retrieve`  | Missing a fact — docs, search, a prior artifact                             | Mostly sync, seconds–minutes | Retriever (RAG/docs); operator iff uncaptured | Token; operator only on gap                     |
| `authorization.approve` | Can act, shouldn't without permission — policy first; user if policy silent | Sync, seconds–hours          | Policy → operator                             | Operator attention (quick)                      |
| `direction.decide`      | Preference-bound choice — architectural, precedent-setting, scope-level     | Async, hours–days            | Operator (rarely automatable)                 | Operator attention (deep)                       |
| `coordination.notify`   | Peer might be affected — informational, not blocking                        | Fire-and-forget              | Peer agents, mesh broadcast                   | None on operator                                |
| `quality.review`        | Output needs validation — tests, reviewers, taste                           | Async-OK, minutes–hours      | Reviewer agent → operator for taste           | Mixed; operator only for subjective dimensions  |
| `stuck.unblock`         | Multiple attempts failed, fresh eyes needed                                 | Sync if critical-path        | Opus → peer → operator                        | Operator only as last resort                    |

These are **orthogonal routing clusters**, not an exhaustive ontology. A newly discovered ask that doesn't map onto one of the seven is a signal that the taxonomy needs extension, not that the ask has the wrong kind.

### The 8-stage lifecycle

```
Detection → Classification → Routing → Packaging → Suspension → Response → Resumption → Accounting
```

- **Detection** — a callsite emits a raw `AskIntent` (pre-classification). Current detection sites: 2-strikes rule, session commit, PR merge attempt, System 3\* detector (mt#1035, future).
- **Classification** — the classifier assigns `kind` and sets `classifierVersion`. Starting policy: **agent self-declaration with policy override**. The caller emits its best guess; the router verifies it against policy coverage and can overwrite before dispatch. Confidence is not modeled numerically at v1; the router logs disagreements for audit.
- **Routing** — policy is consulted first (see §Router below). If policy covers the decision, the Ask short-circuits to `closed` with `responder = "policy"`. Otherwise the router picks a target by kind and operator preference.
- **Packaging** — the router materializes the options, deadline, fallback, and context snapshot the responder will need. This is where a kind-specific `AskPayload` is built.
- **Suspension** — the caller's execution stalls waiting for the response. Sync asks block the current turn; async asks return control and resume on response.
- **Response** — the responder produces a payload. The router validates the shape against the kind's `AskResponse` discriminated union.
- **Resumption** — for sync asks, execution resumes with the response in context. For async asks, the scheduler re-enters the suspended task.
- **Accounting** — the Ask's `attentionCost` is computed on close and written. See §Attention accounting.

For sync cases with an attached AG-UI client, stages 5 and 7 are carried by `RUN_FINISHED outcome=interrupt` + `resume`. The Ask subsystem owns the other six stages in every case; AG-UI is one transport among several.

### Router: policy-first → escalate-if-uncovered

```typescript
// src/domain/ask/router.ts
export interface AskRouter {
  route(ask: Ask): Promise<RoutedAsk>;
}

export interface RoutedAsk extends Ask {
  state: "routed";
  routingTarget: AgentId | "operator" | "policy";
  transport: TransportBinding;
  packagedPayload: AskPayload;
}
```

The router is a two-phase decision:

1. **Policy consultation** — does existing policy cover the action the Ask is about?

   - Policy sources (in order): CLAUDE.md rules → project rules (`.claude/rules/*`) → task-spec constraints → long-lived memories → `.minsky/policy/*` (future).
   - **Coverage semantics (starting position; revisable):** an action is "covered" if a policy statement _names the action or its category_ AND _names the authority under which it resolves_. Name-match alone is not enough (avoids false green-lights from incidental mentions). Category-match requires the category to be explicitly enumerated.
   - If covered, the router closes the Ask as `responder = "policy"` with the policy citation in the response payload.

2. **Transport dispatch** — for uncovered asks, the router picks a target by kind using the table above, overridable per-Ask via `routingTarget`.

### Transport-binding matrix

| Kind                    | Primary transport                                          | Secondary                                           | Persistence                                              |
| ----------------------- | ---------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------- |
| `capability.escalate`   | Subagent dispatch (via Task tool)                          | —                                                   | Session metadata only                                    |
| `information.retrieve`  | Retriever API (docs, RAG) → AG-UI interrupt iff uncaptured | —                                                   | Session metadata; operator-escalated entries go to Inbox |
| `authorization.approve` | Policy-resolver → AG-UI interrupt (sync) / Inbox (async)   | Mesh notify on resolve                              | Inbox (mt#454)                                           |
| `direction.decide`      | Inbox (mt#454)                                             | AG-UI interrupt if operator has an attached session | Inbox                                                    |
| `coordination.notify`   | Mesh signal (mt#1001, LISTEN/NOTIFY + SSE)                 | —                                                   | Signal log                                               |
| `quality.review`        | Reviewer subagent → Inbox for operator taste pass          | AG-UI interrupt for inline review                   | Inbox for operator entries                               |
| `stuck.unblock`         | Opus subagent → peer agent via mesh → Inbox → operator     | Escalates through chain on timeout                  | Inbox for operator entries                               |

Notes on this matrix:

- **AG-UI is a format, not a kind.** It is the sync wire format when an interactive client is attached; its `RUN_FINISHED outcome=interrupt` event carries asks that a sync-capable client can resolve. This matches the mt#697 recommendation: adopt the interrupt pattern, not the enum.
- **The Inbox is the async backbone** for anything routed to the operator without an attached sync client. The mt#454 schema requires no changes beyond the additions listed in that spec (kind field, classifier version, attention cost).
- **The mesh is exclusively `coordination.notify`** — fire-and-forget peer notification. The mt#1001 decision (Postgres LISTEN/NOTIFY + SSE) stands; no changes.
- **Policy as transport** is a formal target (not a bypass): the router records a policy-resolved Ask with the citation, preserving the attention-cost ledger (cost = 0 but recorded).

### Attention accounting

```typescript
export interface AttentionCost {
  // Primary registers
  tokenCost?: number; // agent/subagent cost (measured)
  operatorCost?: {
    // operator cost (estimated)
    kind: "quick" | "medium" | "deep"; // ordinal, not wall-clock, at v1
    wallClockSec?: number; // measured when available
  };
  // Meta
  transport: TransportKind;
  resolvedIn: "policy" | "subagent" | "inbox" | "mesh" | "agui" | "timeout";
}
```

**v1 accounting is intentionally coarse.** We record an ordinal operator-cost bucket rather than trying to measure cognitive load. The measurement that matters at v1 is **frequency per kind per task**, which surfaces high-cost-per-task patterns (e.g., "this task cost 8 `direction.decide` asks — spec needs sharpening") without false precision.

Budgets (open v1 question — flagged for follow-up): whether to enforce per-task or per-session operator-attention budgets. Default position: no enforcement at v1; accounting is observational. If patterns emerge, a System 3\* detector can flag over-budget tasks.

### Task-lifecycle integration

**Proposal (revisable):** introduce `BLOCKED` subtypes driven by the open Ask, not by free-text `blocker_reason`:

- `BLOCKED(direction)` — open `direction.decide` Ask
- `BLOCKED(review)` — open `quality.review` Ask awaiting operator
- `BLOCKED(authorization)` — open `authorization.approve` Ask
- `BLOCKED(other)` — fallback

The task-state machine does not need new transitions; `BLOCKED` already exists. The enrichment is at render time: when a task is `BLOCKED`, the UI (and `tasks_list`) show the open Ask inline. This gives the operator a direct link from "why is this task blocked" to "what decision does it need."

`direction.decide` asks that are not task-scoped (e.g., session-level scope decisions) are not coupled to task state; they live in the Inbox with a session parent but no task parent.

## Answers to the nine research questions

Each question from the mt#1034 spec, mapped to the decisions above.

**1. Entity model.** Covered in §The Ask entity. Notable refinements against the starting field list: `classifier` split into `classifierVersion` (schema field) and classifier implementation (code); `requestor` and `routingTarget` use the `{kind}:{scope}:{id}` format from mt#953; `response` holds both payload and accounting.

**2. State machine.** Covered in §The 8-stage lifecycle. Sync vs async does not require structurally different state machines; the distinction is in whether `suspension` blocks the caller or returns control. Per-kind specializations are expressed via `AskPayload` and `AskResponse` discriminated unions, not separate state machines.

**3. Classifier.** v1 policy: **agent self-declaration with policy override**. The caller emits a best-guess kind; the router re-checks against policy coverage and can overwrite. Confidence is not modeled numerically at v1 — disagreements are logged for audit. Future: a supervisor-classifier subagent (mt#1035-related) for unasked-direction detection.

**4. Router.** Covered in §Router. Policy-first → escalate-if-uncovered. Policy sources are ordered (CLAUDE.md → project rules → task spec → memories → `.minsky/policy/*`). Priority/escalation chains are kind-specific (e.g., `stuck.unblock`: Opus → peer → Inbox → operator).

**5. Packaging.** Covered in §The 8-stage lifecycle (Packaging stage) and materialized via per-kind `AskPayload` types. Every packaged Ask carries: options (when the kind is decision-like), deadline, fallback, context snapshot (diffs/files/specs). Kind-specific: `authorization.approve` carries the action's diff; `direction.decide` carries alternatives with tradeoffs; `quality.review` carries the artifact under review.

**6. Transport binding.** Covered in §Transport-binding matrix. The mt#697 decision holds: AG-UI for sync-client subset, Inbox for async, mesh for notify, subagent dispatch for escalate/stuck, policy-resolver as a first-class transport.

**7. Attention accounting.** Covered in §Attention accounting. Coarse ordinal + frequency-per-kind-per-task at v1. Budgets are observational, not enforced. System 3\* detector consumes this data.

**8. Task-lifecycle integration.** Covered in §Task-lifecycle integration. `BLOCKED` gains rendering-time subtypes tied to the open Ask. Non-task-scoped asks live in Inbox without a task parent.

**9. Policy-coverage semantics.** Starting position in §Router: explicit action-name AND authority-citation required. Category-match needs explicit enumeration. Name-match alone insufficient. **This is the most contested semantics in the subsystem and is a candidate for refinement after the detector (mt#1035) produces false-positive data.**

## Consequences

### Benefits

- **Scattered HITL unifies.** Inbox, mesh, AG-UI, PR approval, `BLOCKED`, and the 2-strikes rule all become transports for the same Ask entity. Cross-cutting changes (e.g., "add deadline to all HITL asks") become a one-place edit.
- **Routing failures become visible.** The Waste/Usurp failure modes become measurable: Waste = asks that policy covered but were escalated anyway; Usurp = direction decisions that closed without an operator response (auto-classifier drift).
- **Attention debt is first-class.** A task's operator-attention cost is recoverable from the Ask log, not a metric the operator has to reconstruct mentally.
- **New HITL features reuse plumbing.** Adding a new detector (System 3\*, mt#1035) or a new transport (e.g., Slack notify) is a leaf addition, not a new subsystem.
- **Positioning sharpens.** Minsky is publicly "an attention-allocation system with a first-class Ask taxonomy" rather than "an agent platform with HITL somewhere." Humility becomes an advertised property, not an implicit norm.

### Trade-offs

- **New subsystem surface.** Ask entity + router + transport adapters = a nontrivial addition. The risk is over-engineering for v1 before real usage shapes the taxonomy.
  - Mitigation: v1 is scoped to entity + persistence + router skeleton + two transports (policy-resolver and Inbox). Other transports land incrementally.
- **Policy-coverage semantics are fuzzy.** "Explicit action-name + authority citation" excludes a lot of sensible implicit coverage and may over-escalate. Too permissive in the other direction and the router will false-green-light.
  - Mitigation: start strict; the System 3\* detector (mt#1035) generates false-positive data that tunes the semantics.
- **Classifier quality is the long-pole.** Agent self-declaration relies on the agent recognizing its own ask correctly — exactly the failure mode the noticing corollary warns about.
  - Mitigation: mt#1035 exists specifically to detect unasked directions; this ADR depends on that detector for classifier reliability in the `direction.decide` kind.
- **Schema churn risk.** `classifierVersion` helps, but reclassifying a growing Ask log is not free.
  - Mitigation: background migration only; never in the hot path. Old rows stay on their old kind labels.

### Negated alternatives

- **Build each transport independently** — rejected. This is the current state and the problem it produces is the motivation for this ADR. Five transports without a common entity means five places to add deadlines, five places to track attention, five half-typed envelopes.
- **Use AG-UI as the domain primitive** — rejected. AG-UI is a wire format for sync-client runs (mt#697 finding). It does not carry async semantics, does not have policy as a first-class target, and its `reason` enum is draft and framework-specific. The Ask entity owns the lifecycle; AG-UI transports a subset of it.
- **Treat every Ask as an Inbox row** — rejected. The Inbox is right for async asks but is overkill for sync `capability.escalate` and fire-and-forget `coordination.notify`. Making Inbox the universal store would force every ask to hit Postgres on the hot path.
- **Skip the taxonomy; one flat `Ask`** — rejected. The whole routing argument collapses without kinds; every Ask would need an ad-hoc router-per-callsite, which is what we have today.
- **Wait for more evidence before building this layer** — rejected. The downstream tasks (mt#454, mt#1001, mt#700, mt#781) are blocked on routing decisions the ADR answers. Building each independently now generates throwaway plumbing.

## Implementation plan (child-task breakdown)

This ADR is research. The implementation decomposes into the child tasks below. Each child is scoped to a single component and has its own success criteria.

1. **Ask entity + persistence** — DB schema, TypeScript types, CRUD, `classifierVersion` migration path. Scope: ~400 lines domain + 1 migration. Depends on nothing.
2. **Router skeleton + policy-resolver transport** — Router interface, policy consultation, `responder = "policy"` close path. No other transports yet. Depends on child #1.
3. **Inbox transport binding (mt#454 integration)** — adapt the existing Inbox design to be the persistence for `direction.decide` / async `authorization.approve` / async `quality.review`. Depends on child #1 and mt#454 landing.
4. **AG-UI transport binding (mt#700 integration)** — sync interrupt emitter for `authorization.approve` and sync `quality.review`. Depends on child #1 and mt#700 landing.
5. **Mesh transport binding (mt#1001 integration)** — `coordination.notify` routing. Depends on child #1 and mt#1001 landing.
6. **Subagent dispatch binding** — `capability.escalate` and `stuck.unblock` routing via the Task tool. Depends on child #1.
7. **Attention-accounting schema + reporting** — per-task / per-kind rollups; `tasks_list` / `session_status` surfacing. Depends on child #1.
8. **BLOCKED subtype rendering** — `tasks_list` renders `BLOCKED(direction)` etc. with the linked Ask. Depends on children #1 and #3.

Child tasks are created alongside the merge of this ADR.

## Relationship to existing tasks

- **mt#697** — DONE. This ADR is the reification of the findings. The AG-UI adoption recommendation carries through: sync interrupt pattern yes, `reason` enum no, adopt as one of several transports.
- **mt#454** — Inbox spec has been updated in-place to reflect its role as the async-ask backbone. No schema change required beyond `kind` and `classifierVersion` fields on the request row.
- **mt#1001** — mesh push spec has been updated with the mt#697 recommendation (LISTEN/NOTIFY + SSE). This ADR confirms `coordination.notify` as the only kind that routes here.
- **mt#700** — Layer 2 executor spec has been updated with the AG-UI HITL contract. This ADR confirms that contract and names the two kinds that use it.
- **mt#781** — Locus/cockpit spec has been updated to reference AG-UI rendering and the Ask subsystem. This ADR confirms the cockpit as the rendering surface for open asks and attention debt.
- **mt#953** — agent identity format (`{kind}:{scope}:{id}`) is used for `requestor` and `routingTarget`. This ADR does not extend mt#953; it only consumes it.
- **mt#503** — premature-completion guardrails. Empty spec (pre-existing data issue; out of scope here). Adjacent detector pattern; mt#1035 owns the detector design and will evaluate whether mt#503 should share infrastructure.

## References

- `docs/theory-of-operation.md` §Companion Principles (attention, humility, noticing)
- `CLAUDE.md` §Design Principle: Humility
- ADR-002 (persistence-provider architecture) — Ask persistence uses the same provider capability model
- ADR-005 (ForgeBackend sub-interfaces) — precedent for sub-capability decomposition; Ask transports follow the same shape
- mt#697 Findings — AG-UI as wire format for sync subset
- mt#454 — async backbone
- mt#1001 — `coordination.notify` transport
- mt#700 — sync interrupt consumer
- mt#781 — cockpit renderer
- mt#953 — agent identity
- mt#1035 — System 3\* detector (sibling ADR)
- Notion companion essay: `34a937f0-3cb4-814b-adba-f2e5cee38c08`
