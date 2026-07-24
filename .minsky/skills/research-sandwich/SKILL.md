---
name: research-sandwich
description: >-
  Run a deep research / investigation pass with the Fable-bookended fan-out
  pattern: a Fable advisor decomposes the question into independent workstreams
  (plan), fresh subagents each research one workstream in parallel (fan-out), and
  a Fable advisor assembles the results into one coherent deliverable
  (synthesize). Use when the principal asks for research, prior-art, a landscape
  survey, "get clarity / perspective," "find the existing language/frameworks
  for X," or explicitly asks for "the Fable sandwich" / "plan, fan out,
  synthesize." NOT for a single-fact lookup or a one-source question — sandwiching
  a one-liner is waste.
user-invocable: true
---

# Research Sandwich

A three-phase orchestration for a research or investigation question too broad for one
context to cover well: **Fable plans -> subagents fan out -> Fable synthesizes.** The Fable
advisor tier is the frontier model (`model: "fable"`); the fan-out tier is Sonnet workers.
The name is the topology: a Fable slice on top and bottom, parallel workers in the middle.

This skill is orchestration only — no scripts. It is the research-shaped sibling of
`/orchestrate` (which coordinates _implementation_ tasks). Validated repeatedly: the
2026-07-22 context-injection audit (four collectors + one synthesis, `mem#682`), the mt#3100
Layer-2 design pass, the rule-corpus surveys (`mem#695` / `mem#693`).

## When to use it

Use it when ALL of these hold:

- The question benefits from **multiple independent angles** (prior art + codebase grounding +
  competitive landscape + theory), not one search.
- **Breadth exceeds one context** — a single agent would either go shallow on each angle or run
  out of budget.
- The output is a **durable artifact** (a decision record, a vocabulary / mental-model doc, an
  RFC input), not a chat answer.

Do NOT use it for: a single-fact lookup, a one-source question, anything a direct
search-and-read answers in a few tool calls. Sandwiching a one-liner burns a Fable planner,
N subagents, and a Fable synthesizer to answer what one `Grep` would. When unsure, do the
cheap direct search first; escalate to the sandwich only if it fans out.

## Phase 1 — Fable plans (the decomposition)

Dispatch ONE Fable advisor (`subagent_type: "Plan"`, `model: "fable"`, background) to produce a
**research plan**, not to do the research. Give it:

- The **question** and _why it matters_ (the muddle to resolve, the decision it feeds).
- The **current state** it must ground against — name the specific artifacts / code / mechanisms
  so the plan maps prior art back to _our_ situation, not generic literature.
- The **downstream pipeline** ("your workstreams go to fan-out subagents, then a Fable
  synthesizer") so it scopes workstreams to be independently farmable and non-overlapping.

Require the plan to return, per workstream: a title, the crisp question, 3-6 concrete search
leads (named literature / systems / terms, curated — not a checklist to accept wholesale), what a
good answer returns (including "map back to our mechanism X"), and the mode (web / codebase /
both). Also require: what each workstream hands the synthesizer, and the cross-cutting
**tensions** the synthesis must resolve. Cap at **4-7 workstreams** so the fan-out stays
manageable.

## Phase 2 — Fan out (one subagent per workstream)

For each workstream, dispatch a fresh subagent (`Explore` or `general-purpose` for
web+read research; `model: "sonnet"`; background). Pass the workstream's brief close to
verbatim from the plan. Hard-won constraints (`mem#274`, `mem#308`):

- **One workstream per subagent.** Do not bundle — each is one fresh attention budget.
- **No cross-dependencies** between workstreams (the plan enforced this; verify before
  dispatch). If two overlap on a source or claim, that is a synthesis job, not a fan-out
  dependency.
- **Ground every finding.** Web research must map back to the named Minsky mechanism the
  workstream illuminates, and cite sources — an ungrounded lit-review is not the deliverable.
- **Wave discipline.** A single wave of 4-7 background subagents is fine from a fresh session;
  a _second_ wave later in a long session risks the per-account rate cap (`mem#274`). If the
  session is already deep, run a smaller wave or space them.
- Give every workstream a **fixed return shape** so the synthesizer merges without re-deriving
  (e.g. vocabulary table / mechanism-mapping / where-a-known-good-design-fits / settled-vs-
  unsettled tag / open-questions). Instruct each to return that **structured memo**, not prose
  narration — its final message IS the return value.

## Phase 3 — Fable synthesizes

Dispatch ONE Fable advisor (`subagent_type: "Plan"`, `model: "fable"`) with ALL workstream
memos. Its job: assemble one coherent deliverable — the vocabulary + mental model, how each of
our mechanisms maps onto the established concept ("X is the crude version of <named thing>"),
where we are reinventing and what the known-good design is — and **resolve the cross-cutting
tensions** the planner named. Require it to:

- **Distinguish the settled layer** (mature, canonical answers exist) from the **unsettled
  layer** (emerging, may have no canonical answer) — treat them differently.
- **Verify, don't inherit.** This is the load-bearing guardrail: the failure family this
  project keeps hitting is _inheriting a framing without checking it_ (`mem#674`). The
  synthesizer must flag any claim it could not ground, not launder a collector's assertion into
  a conclusion.
- **Propose candidate vocabulary as OPTIONS** — naming is principal-reserved
  (`principal-context.mdc`); never lock a name.

## Land the deliverable durably

The synthesis output is durable work — it must land somewhere pull-able, per the communication
contract (chat is not the storage layer). Choose by shape: a **Minsky task** spec / `## Findings`
(feeds implementation), a **memory** (a durable frame / reference), a **doc** under `docs/`, or a
**Notion page** (a strategic artifact — often via `/draft-rfc` or `/draft-adr`). Report the
pointer in chat; do not paste the synthesis into the scroll.

## Guardrails

- **Report the register.** A research sandwich runs several background agents over minutes.
  Emit heartbeats per `user-preferences.mdc §Progress heartbeats`; relay what matters from each
  phase, not raw agent transcripts.
- **The planner is not optional.** Skipping Phase 1 and hand-decomposing forfeits the frontier
  model's decomposition — which is the point. If the question is small enough that you'd skip
  the planner, it is small enough to skip the whole sandwich.
- **Sequence, don't batch, across phases.** Phase 2 needs Phase 1's plan; Phase 3 needs Phase
  2's memos. Within a phase, fan out in parallel.
- **Cost is real.** This spends a Fable planner + N Sonnet workers + a Fable synthesizer. It is
  justified by breadth and a durable deliverable, not by "this would be thorough."

## Composition

Stacks with `/draft-rfc` and `/draft-adr` (the sandwich produces the research input; those
skills author the artifact) and `/orchestrate` (implementation coordination, once the research
names the work). It does not call them — it hands off via the durable deliverable.
