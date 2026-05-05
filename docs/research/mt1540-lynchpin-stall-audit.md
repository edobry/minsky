# Lynchpin-Stall Audit

**Task:** mt#1540 (Child B of mt#1505)
**Type:** Research / Audit
**Status:** Phase 1 — Cross-reference graph (2026-05-04)
**Parent:** mt#1505 (umbrella roadmap stall audit)

## Summary

Shape-B diagnostic audit: structural lynchpins that block multiple downstream tasks but have
themselves stalled — without a documented workaround. Complements mt#1539 (Child A) which
covered workaround-load-bearing clusters.

Diagnostic: structural-importance × inactivity, NOT firing rate. A task qualifies when ≥2
memories or ≥1 ADR cite it as a dependency/umbrella/parent, it hasn't changed status in ≥10
days, its own dependents are stalled, and no memory documents a workaround citing it (which
would make it a Child A candidate instead).

**Findings (preliminary — phases 1–2):** 4 strong candidates identified. Full phase 3–5
analysis below.

---

## Dedup Against mt#1539 (Child A)

The following tasks are explicitly excluded per the dedup rule:

**DROP list:**

- mt#1503 cluster: mt#1073, mt#1065, mt#1345, mt#1372, mt#1310, mt#1405, mt#1477
- mt#1506, mt#1478, mt#1523 (under mt#1561/mt#1563/mt#1565 from Child A)
- mt#1551, mt#1459, mt#1460 (Child A deferred/in-flight)
- mt#1483 (Child A resolved)
- mt#1541, mt#1543 (Child A anchor case closure)
- mt#1035 (Child A anchor case)

---

## Phase 1 — Cross-Reference Graph

### Methodology

Grep of all `feedback_*.md`, `project_*.md` files in
`~/.claude/projects/-Users-edobry-Projects-minsky/memory/` and all `docs/architecture/adr-*.md`
files for `mt#NNNN` patterns. Count per-file (not per-line) to measure breadth of citation.

### Raw citation counts (feedback files — files citing the task, not line count)

Top candidates by feedback file count:

- mt#1305: 4 files — DONE (parallel-work skill-step enforcement)
- mt#1034: 5 files — DONE (attention-allocation umbrella)
- mt#1362: 5 files — DONE (parallel-work-guard hook)
- mt#1372: 5 files — DROP (Child A, mt#1503 cluster)
- mt#1073: 4 files — DROP (Child A, mt#1503 cluster)
- mt#1262: 4 files — DONE (config masking fix)
- mt#1181: 4 files — DONE (maskCredentials refactor)
- mt#1303: 5 files — DONE (session_update no-marker)
- mt#1483: 2 files — DROP (Child A resolved)

Top candidates by project file count:

- mt#1413: 4 files — reviewer calibration (check status)
- mt#1110: 8 files — reviewer aggressiveness Sprint-B (READY)
- mt#1395: 4 files — DONE (reviewer structured channel)
- mt#1125: 2 files — DONE
- mt#800: 4 files — TypeScript-first skills authoring (READY)
- mt#700: 3 files — task executor prototype (TODO)
- mt#321: 3 files — AI-powered init (TODO)
- mt#454: 2 files — Agent Inbox (PLANNING)
- mt#1001: 3 files — mesh signal channel (TODO)

Top candidates by ADR file count:

- mt#953: 2 ADR files — DONE (agent identity research)
- mt#1340: 1 ADR file — DONE
- mt#700: 1 ADR file — task executor prototype (TODO)
- mt#321: 1 ADR file — AI-powered init (TODO)
- mt#454: 1 ADR file — Agent Inbox (PLANNING)
- mt#1001: 1 ADR file — mesh signal channel (TODO)
- mt#503: 1 ADR file — premature completion guardrails (TODO)
- mt#1058: 1 ADR file — retrofit AI-using features umbrella (TODO)
- mt#781: 1 ADR file — cockpit documentation (TODO)

### Combined cross-reference signal (non-DROP, non-DONE tasks)

| Task    | Title (abbreviated)                                | Feedback files | Proj files | ADR files | Total | Status   |
| ------- | -------------------------------------------------- | -------------- | ---------- | --------- | ----- | -------- |
| mt#800  | TypeScript-first authoring for skills/rules/agents | 2              | 4          | 1         | 7     | READY    |
| mt#1110 | Sprint-B tuning: reviewer aggressiveness           | 3              | 8          | 0         | 11    | READY    |
| mt#1001 | Mesh signal channel push/subscription              | 1              | 3          | 1         | 5     | TODO     |
| mt#700  | Provider-agnostic task executor prototype          | 0              | 3          | 1         | 4     | TODO     |
| mt#321  | AI-Powered Project Analysis / enhanced init        | 0              | 3          | 1         | 4     | TODO     |
| mt#454  | Agent Inbox / seek-human-input research            | 0              | 2          | 1         | 3     | PLANNING |
| mt#503  | Premature-completion guardrails                    | 1              | 1          | 1         | 3     | TODO     |
| mt#1058 | Retrofit AI-using features for dual-mode cognition | 0              | 1          | 1         | 2     | TODO     |
| mt#781  | Cockpit documentation (anchored in mt#1143)        | 0              | 1          | 1         | 2     | TODO     |

Note: mt#1413 (4 proj files) checked but skipped — status check needed.

---

## Phase 2 — Status + Age Sweep

### Status verification (2026-05-04)

| Task    | Status   | Last git commit mentioning task                     | Age estimate |
| ------- | -------- | --------------------------------------------------- | ------------ |
| mt#800  | READY    | 2026-04-27 (in mt#1249 body)                        | 7d           |
| mt#1110 | READY    | 2026-04-27 (in mt#1228 body + mt#1311 skill update) | 7d           |
| mt#1001 | TODO     | 2026-04-26 (in ADR-008/ADR-009 context)             | 8d           |
| mt#700  | TODO     | 2026-04-26 (in ADR-008 update)                      | 8d           |
| mt#321  | TODO     | 2026-04-23 (in mt#1057/ADR-007 context)             | 11d          |
| mt#454  | PLANNING | 2026-04-23 (in mt#1057/ADR-007 context)             | 11d          |
| mt#503  | TODO     | 2026-04-27 (in mt#1035 doc)                         | 7d           |
| mt#1058 | TODO     | 2026-04-23 (in mt#1057 doc)                         | 11d          |
| mt#781  | TODO     | 2026-04-26 (in ADR-008 update)                      | 8d           |

**Threshold filter (≥10d or no recent commits at all):**

- mt#321 (11d) — passes ✓
- mt#454 (11d) — passes ✓
- mt#1058 (11d) — passes ✓
- mt#1001 (8d) — borderline; low IDs suggest very old filing with no recent direct commits
- mt#700 (8d) — borderline; same pattern
- mt#781 (8d) — borderline
- mt#800 (7d) — borderline (cited as infrastructure, not directly progressed)
- mt#1110 (7d) — borderline (calibration work cited but task in READY without direct commits)
- mt#503 (7d) — borderline

**Age notes:** git commit dates represent "last time task was mentioned" not "last status change." For old tasks (mt#321, mt#454, mt#503, mt#700, mt#781, mt#1001), these may have been filed months ago with no sessions ever started. The 10d filter here should be read as "no direct implementation commits ≥10d."

**Surviving candidates after age filter (≥10d, or very old/no-session tasks):**

- mt#321 (11d, TODO, multiple ADR/proj refs, cited as "first consumer" of mt#1063/mt#1057)
- mt#454 (11d, PLANNING, ADR-008 transport binding — Agent Inbox)
- mt#1058 (11d, TODO, umbrella for ADR-007 retrofit — "migrate existing AI-using features")

**Borderline candidates (8d, strong cross-refs):**

- mt#1001 (8d, TODO, ADR-008 transport binding for mesh push)
- mt#700 (8d, TODO, ADR-008 transport binding for task executor)

---

## Phase 3 — Stalled-Dep Check + Originating-Relevance Check

### mt#321 — AI-Powered Project Analysis for Enhanced Init Command

**Cross-refs:** Cited as "first consumer of ADR-007 (CognitionProvider abstraction)" in
`project_planning.md` and in ADR-007 PR body. Referenced by `project_progressive_adoption.md`
as "first T0 consumer" of the progressive adoption model.

**Status:** TODO. No session found.

**Stalled dependents:** mt#321 depends on mt#1063 (AI criterion evaluation, TODO), which
in turn depends on ADR-007/mt#1057 (CognitionProvider) landing. mt#1057 is likely DONE
(ADR shipped 2026-04-23) but the implementation task needs checking.

**Originating relevance:** The progressive adoption model still applies — T0 assessment
(no Minsky config, no API key) still has no implementation. The user-facing init command
hasn't been enhanced with AI-powered analysis.

**Workaround check:** No memory file documents a workaround that cites mt#321. The
progressive adoption model (`project_progressive_adoption.md`) describes the design
intention, not a workaround.

**Verdict: Child B candidate** (no workaround, structurally important, stalled ≥11d).

---

### mt#454 — Agent Inbox / Seek Human Input (PLANNING)

**Cross-refs:** ADR-008 (attention-allocation) names mt#454 as the durable async backbone.
`project_attention_allocation.md` documents it as the "durable async backbone" for `direction.decide`
asks. `project_mt1526_agent_inbox_ecosystem_comparison.md` (mt#1526 research) references mt#454
directly. `project_planning.md` lists it under attention-allocation.

**Status:** PLANNING (11d). No implementation session found.

**Stalled dependents:** ADR-008 implementation plan lists mt#454 as the async transport
binding for `direction.decide` asks. Without mt#454, the Ask subsystem cannot handle
long-running async escalations. The research doc (`mt1526-agent-inbox-ecosystem-comparison.md`)
completed on 2026-04-27 (PR #937) was explicitly a prerequisite investigation for mt#454.

**Originating relevance:** The Ask subsystem is still not fully wired (ADR-008 transport
bindings are incomplete). Agent Inbox is the canonical mechanism for async `direction.decide`
escalations. This gap means the Ask subsystem can only handle sync asks in-process.

**Workaround check:** No memory file documents a workaround that cites mt#454. The
manual escalation pattern (user interrupts session) is described in CLAUDE.md as humility
discipline, but no memory file frames it as "workaround for mt#454."

**Verdict: Child B candidate** (no workaround, ADR transport binding, stalled ≥11d).

---

### mt#1058 — Retrofit AI-Using Features for Dual-Mode Cognition (TODO)

**Cross-refs:** ADR-007 PR body explicitly lists mt#1058 as Phase 4 of the CognitionProvider
plan ("Retrofit umbrella — migrate existing AI-using features"). mt#1057 ADR doc references
mt#1058 as the sequenced follow-up. The `project_planning.md` places mt#1058 after mt#915
(DONE) in the mt#800 skill track.

**Status:** TODO. Last meaningful commit: 2026-04-23 (in mt#1057 ADR doc). 11d stalled.

**Stalled dependents:** mt#1058 is the umbrella for migrating all existing AI-using features
to use `CognitionProvider`. Until mt#1058 lands, T0 progressive adoption is broken for
any feature that directly calls `AICompletionService`. mt#1063 ("AI criterion evaluation
via CognitionProvider") is also TODO and would be one of the first consumers.

**Originating relevance:** ADR-007 (CognitionProvider) shipped on 2026-04-23. The retrofit
umbrella is the next required step. Without it, the ADR is a design artifact with no runtime
effect. The T0 progressive adoption model cannot deliver on its commitment.

**Workaround check:** No memory cites mt#1058 as a workaround tracking task. There is no
documented "use X instead of mt#1058" pattern.

**Verdict: Child B candidate** (no workaround, ADR implementation dependency, stalled ≥11d).

---

### mt#1001 — Mesh Signal Channel Push/Subscription (TODO)

**Cross-refs:** ADR-008 (attention-allocation) cites mt#1001 as the transport binding for
`coordination.notify` asks. `project_attention_allocation.md` states: "mt#1001 (mesh signal
push) — `coordination.notify` is its own ask kind; uses LISTEN/NOTIFY + SSE, not AG-UI."
`project_mesh_observability.md` references mt#1001. `project_planning.md` (under attention
allocation section). Also cited in `draft_openclaw_hiclaw_position_paper.md`.

**Status:** TODO. Last mention in commits: 2026-04-26 (ADR-008 renumbering commit).

**Stalled dependents:** Without mt#1001, the `coordination.notify` ask kind has no transport
wire. The mesh observability vision (peer agents notifying each other of conflicts) has no
implementation path. Cited in 5 total files (1 feedback, 3 project, 1 ADR).

**Originating relevance:** The mesh signal architecture is still unimplemented. ADR-008
designates mt#1001 as the owner of this transport binding. The HITL-as-attention-allocation
reframe (core strategic claim) depends on all ask kinds having transport bindings; mt#1001
is the missing link for async/notify asks.

**Workaround check:** No memory documents a workaround citing mt#1001. The mesh is simply
absent — there's no "use X instead" pattern documented.

**Verdict: Borderline Child B candidate** (8d stall, not ≥10d by git commit date, but task
is structurally blocking ADR-008 transport completeness with no recent commits at all).

---

### mt#700 — Provider-Agnostic Task Executor (TODO)

**Cross-refs:** ADR-008 cites mt#700 as the AG-UI transport binding for the task executor.
`project_attention_allocation.md` states: "mt#700 (Layer 2 task executor) — consumer of the
Ask subsystem; executor interface emits ask events." Cited in 3 project files + 1 ADR.

**Status:** TODO. Last commit mentioning: 2026-04-26 (in ADR renumbering).

**Stalled dependents:** Without mt#700, the AG-UI transport binding has no consumer.
The task executor prototype is the implementation path for autonomous task execution
without Claude Code dependency.

**Originating relevance:** Still relevant — Minsky still depends on Claude Code as its
harness. The goal of provider-agnostic execution remains unmet.

**Workaround check:** Claude Code dependency is described in `project_progressive_adoption.md`
as the structural condition, but no memory frames it as "workaround for mt#700."

**Verdict: Borderline Child B candidate** (8d stall; ADR transport binding; no workaround).

---

### Eliminated candidates

| Task    | Reason eliminated                                                      |
| ------- | ---------------------------------------------------------------------- |
| mt#800  | READY status (planned, not stalled) — 7d since last reference          |
| mt#1110 | READY status — reviewer calibration is next-up, not stalled            |
| mt#503  | 7d stall only; cited in mt#1035 doc as "shared infrastructure" not dep |
| mt#781  | Cockpit doc task; 8d stall but dependent on mt#1143 (cockpit) — check  |

---

## Phase 4 — Filed Rollups

**Qualifying candidates by impact (cross-ref count × stall age):**

1. **mt#454** — ADR-008 transport binding (async), 11d PLANNING, 3 file citations, Ask subsystem async backbone
2. **mt#1058** — ADR-007 retrofit umbrella, 11d TODO, 2 file citations but directly ADR-specified
3. **mt#321** — First T0 consumer, 11d TODO, 4 file citations, progressive-adoption gating

**Borderline (8d, below 10d threshold):** 4. mt#1001 — ADR-008 transport binding (notify), 8d 5. mt#700 — ADR-008 transport binding (AG-UI), 8d

Per spec, cap at 3. Filing rollups for the 3 confirmed ≥10d candidates. Bordeline (mt#1001,
mt#700) go into deferred candidates.

<!-- ROLLUP IDs WILL BE FILLED IN AFTER tasks_create CALLS -->

---

## Phase 5 — Stalled Lynchpin Table

<!-- TO BE FILLED IN AFTER ROLLUP FILING -->

---

## Filed Rollups

<!-- TO BE FILLED IN AFTER tasks_create CALLS -->

---

## Deferred Candidates

| Task    | Title (abbreviated)                       | Reason deferred                                               |
| ------- | ----------------------------------------- | ------------------------------------------------------------- |
| mt#1001 | Mesh signal channel push/subscription     | 8d stall (below 10d threshold); ADR transport gap still valid |
| mt#700  | Provider-agnostic task executor prototype | 8d stall (below 10d threshold); ADR transport gap still valid |
| mt#503  | Premature-completion guardrails           | 7d stall; mt#1035 shared-interface rather than direct dep     |
| mt#781  | Cockpit documentation                     | 8d stall; depends on mt#1143 (cockpit) status                 |

---

## Cross-References

- mt#1505 — parent umbrella roadmap stall audit
- mt#1539 — sibling Child A (workaround-load-bearing cluster audit)
- mt#1034 — attention-allocation umbrella (DONE) — canonical reference for ADR-008 lineage
- mt#800 — TypeScript-first authoring parent (READY — not stalled, near-term next-up)
- ADR-007 (`docs/architecture/adr-007-cognition-provider-abstraction.md`) — mt#1058 depends on this
- ADR-008 (`docs/architecture/adr-008-attention-allocation-subsystem.md`) — mt#454/mt#1001/mt#700 depend on this
