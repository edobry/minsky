---
name: learn
description: >-
  Route a chunk of task-acquired reusable knowledge to the durable artifact
  that owns it — memory, skill, rule, or doc — via a cited classification
  rubric, then land it through the right channel (memory in-band;
  skill/rule/doc edits via a session-backed task, or a direct edit when
  already inside a suitable session). Invoke explicitly as `/learn <what you
  learned>`, OR
  self-trigger when you notice you just acquired reusable knowledge that
  outlives the current task — after researching a convention, discovering a
  cross-cutting pattern, resolving an ambiguity that will recur, or receiving
  a correction that generalizes beyond the immediate fix — and no capture has
  happened yet this turn. Bounded to fit inside the current turn: classify,
  dedup-check, land or file, one output line. Never blocks or interrupts the
  task in progress.
user-invocable: true
---

# /learn

Routes a chunk of task-acquired knowledge to its correct durable artifact.
This is the **(A) authoring/routing half** of the learn-capture primitive
designed in [RFC: First-class agent-reasoning practices — proactive
learn-capture + explicit epistemic status](https://app.notion.com/p/3a0937f03cb481a68699e419a5ce4da0)
(Notion `3a0937f0-3cb4-81a6-8699-e419a5ce4da0`), Part 1. It answers "given
this knowledge should persist, where does it go and how does it land?" — not
"should this have been captured?" (that's the **(B) proactive-detection**
half, sibling task [mt#2708](minsky://task/mt%232708), not built by this
skill).

Prior art: Hermes Agent's `/learn` (Nous Research, 2026-06-24) — authoring
half only, user-invoked, skills-only destination
([docs](https://hermes-agent.nousresearch.com/docs/)). This skill is
destination-general (memory / skill / rule / doc, not skills-only) and
callable both explicitly and by agent self-trigger.

## Arguments

Optional: the knowledge to capture, in one or two sentences (e.g., `/learn
current AI-writing-tells research says em-dashes and tricolons are the top
two tells`). If omitted on self-trigger, state the captured knowledge inline
as Step 1 below before proceeding.

## When to invoke

**Explicit invocation:** the user types `/learn <knowledge>`.

**Self-trigger** (semantic family — match by meaning, not literal string):
the agent notices it just acquired knowledge that is REUSABLE beyond the
current task and not yet captured anywhere. Concretely:

- A web search or external-doc read surfaces a convention, fact, or pattern
  that updates, contradicts, or extends a skill/rule that is (or should be)
  loaded for this domain.
- The agent resolves an ambiguity mid-task in a way that would recur for any
  future task touching the same area, and no rule/skill/memory currently
  encodes the resolution.
- A user or reviewer correction implies a standing preference or convention,
  not a one-off fix to this one line of code.
- The agent discovers a durable fact about an external system, API, or
  process that isn't derivable from code/git/specs/rules and will matter
  again.

**Does NOT fire on:**

- Knowledge scoped to the current task only (task-spec-worthy, not
  corpus-worthy — record it in the task spec instead, per
  `Work Completion §Document findings in the spec`).
- Knowledge already covered by a loaded artifact — verify with a quick
  read/grep before treating it as new (re-deriving something already encoded
  is not a capture; it's confirmation).
- Routine tool-usage learning that doesn't generalize past this one call.

## Attention posture (non-blocking — RFC Part 1 §Attention-scarcity)

Capture is never a gate. When self-triggered mid-task:

1. Run the procedure below inline. It is bounded to fit inside the current
   turn: classify, dedup-check, land or file — then one output line.
2. If landing requires a session-backed edit task (skill/rule/doc, when not
   already inside a suitable session), **file the task and continue the
   current task** — do not context-switch to work the filed task now unless
   you are already inside a session whose scope covers it.
3. Never pause to ask permission before capturing to memory — it is in-band,
   cheap, and reversible (`memory_update` / `memory_supersede`); the dedup
   search in Step 3 is the confirmation that this isn't stepping on
   in-flight collision, not a request for a go-ahead.
4. When capture is deferred to a filed task, **emit its reference in the
   output line** — never let the capture live only in the fact that you
   noticed it. Mentioning without acting is exactly the anti-pattern this
   skill exists to close (`Work Completion §Never notice an issue without
acting on it`).

## Process

### Step 1: State the knowledge in one sentence

Write the candidate knowledge as a single crisp claim — what was learned, not
where it came from or how it was applied to the current task. Example: "The
current (2026) AI-writing-tells research names em-dashes and rhetorical
tricolons as the two highest-signal AI-prose markers."

### Step 2: Classify the destination (citation required)

No un-cited destination label — same discipline as `/plan-task` gate (j) and
`decision-defaults.mdc §Subsystem-assignment verification`: cite the rule
that defines the destination, map the knowledge's properties to its
criteria, state the verdict. Apply, in this order:

1. **Rule-admission ladder** (mt#2874, encoded in `/create-rule` Step 0) —
   the general first pass across all four destinations:
   - Path-scoped rule (`.claude/rules`, glob-triggered) — file-shaped
     guidance.
   - **Skill** — task-shaped guidance: a procedure invoked for a specific
     workflow, not needed on every turn.
   - **Memory** — incident-shaped guidance: a durable finding from a
     specific incident or fact, not a standing per-turn check.
   - **Docs** (`docs/` or Notion, per the taxonomy) — reference-shaped
     guidance: background an agent looks up on demand, not a behavior it
     must apply unprompted.
   - `alwaysApply: true` rule — LAST rung, reserved for genuinely per-turn
     discipline (mt#1876 criterion: "would removal cause an agent to skip a
     check it runs every turn?").
2. **mt#960 memory rubric** (for memory candidates specifically) — durable
   AND **not derivable from code, git history, specs, or rules** (CLAUDE.md
   `§Memory Usage`). If the knowledge IS derivable from one of those, it is
   not memory-worthy — route it to the artifact it's derivable from, or drop
   it if already encoded there.
3. **Documentation Taxonomy** (`documentation-taxonomy.mdc`, for doc
   candidates) — pick the specific row (ADR / RFC / design doc / position
   paper / architecture reference / engineering guide / incident memo /
   vision-insight / landscape analysis / audit) via its "Triggers — which
   type to produce" table.
4. **Skill-vs-rule boundary** (`create-rule.mdc` "Key distinction") —
   procedural, step-by-step, workflow-invoked knowledge is a skill;
   declarative, always-or-glob-relevant constraint is a rule.

Output the citation inline before proceeding: `Destination: <X> — <ladder
rung / taxonomy row / rubric criterion>, because <one-line justification>.`

### Step 3: Dedup check (mandatory, explicit — do not skip)

Before creating or filing anything, search for an existing home:

- **Memory destination** → `memory_search` for the topic. If a matching
  entry exists, `memory_update` it (or `memory_supersede` if the new finding
  materially changes prior guidance) instead of creating a duplicate. This
  is the search-before-create discipline for durable artifacts (memory
  `23771583`), itself an extension of `humility.mdc` / CLAUDE.md `§Probe
before claiming a shared resource` (mt#1965 → mt#1990) from
  work-in-flight resources to artifact duplication.
- **Skill / rule / doc destination** → search for an existing OPEN edit task
  before filing a new one: `tasks_search` for the target artifact's name or
  path plus "update"/"refresh"/"amend" keywords, and check
  `tasks_children`/`tasks_list` for a sibling in PLANNING/READY/IN-PROGRESS
  that already touches the same file. If found, do not file a duplicate —
  either fold the captured knowledge into that task's spec
  (`tasks_spec_patch`, carrying the knowledge verbatim) or, if you're about
  to act on it yourself inside that task's session, just land the edit
  there. This cites the parallel-work discipline (CLAUDE.md `§Probe before
claiming a shared resource`, mt#1965 → mt#1990;
  `feedback_check_parallel_work_before_decomposing`).

### Step 4: Land the edit, per destination class

See the routing table below. The two landing mechanics are:

- **In-band** (memory; Notion-tracked doc rows) — the artifact isn't a
  guarded generated-file surface, so land it directly with the appropriate
  MCP tool, no session required.
- **Session-backed task** (skill; rule; repo-tracked doc rows) — these are
  generated or version-controlled files under guard (`check-generated-file-
edit.ts` blocks direct `.claude/skills/*` edits; `.minsky/rules/*.mdc`
  requires the compile step; `docs/**` goes through review like any other
  source change). Two sub-cases:
  - **Already inside a suitable session** — a session bound to a task whose
    scope already covers editing this file (e.g., this `/learn` invocation
    fired while implementing a task that already touches the target
    skill/rule/doc) — make the edit there, following that artifact's own
    authoring rule (`skill-authoring.mdc` for skills; the rules-compile
    pipeline for rules; the relevant `docs/` convention).
  - **Not inside a suitable session** — file a session-backed edit task via
    `tasks_create`, carrying the captured knowledge **verbatim** in the
    spec's `## Summary` or `## Context` (not paraphrased — the next agent
    to pick up the task should see exactly what was learned, not a lossy
    restatement). This is the resolved answer to the session/PR constraint
    identified in mt#2548's investigation.

### Step 5: Surface (one output line, non-blocking)

Emit exactly one line naming the destination and the landing action —
whether that's a memory ID, a task ID, or "edited directly in session
`<id>`." Per the attention posture above, this line is informational, not a
request for confirmation.

## Routing table

| Destination | Classification citation                                                                                                                                                                                                                                  | Landing mechanics                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Dedup step                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Memory**  | mt#960 rubric: durable + not derivable from code/git/specs/rules (CLAUDE.md `§Memory Usage`)                                                                                                                                                             | In-band: `memory_create` directly, no session needed                                                                                                                                                                                                                                                                                                                                                                                                                              | `memory_search` first; `memory_update`/`memory_supersede` an existing match instead of duplicating                                                                           |
| **Skill**   | Rule-admission ladder rung 2 (mt#2874): task-shaped, procedure invoked for a workflow (`create-rule.mdc` "Key distinction")                                                                                                                              | Session-backed: edit `.minsky/skills/<name>/SKILL.md`, compile (`compile --target claude-skills`), commit both trees per `skill-authoring.mdc` — via a filed edit task, or directly if already in a suitable session                                                                                                                                                                                                                                                              | `tasks_search`/`tasks_children` for an existing open edit task touching the same skill before filing                                                                         |
| **Rule**    | Rule-admission ladder rung 1 or 5 (mt#2874): file-shaped (`globs`) or genuinely per-turn (`alwaysApply: true`, mt#1876 criterion)                                                                                                                        | Session-backed: edit the `.minsky/rules/<name>.mdc` source, `rules compile` (verify each target regenerated — `implement-task §7` step 4), commit both — via a filed edit task, or directly if already in a suitable session                                                                                                                                                                                                                                                      | Same as skill: search for an existing open edit task on the same rule file first                                                                                             |
| **Doc**     | Documentation Taxonomy row (`documentation-taxonomy.mdc` "Triggers" table) — pick the specific type (ADR / RFC / design doc / position paper / architecture reference / engineering guide / incident memo / vision-insight / landscape analysis / audit) | **Repo-tracked** rows (ADR, architecture reference, engineering guide, incident memo) → session-backed edit task, same guard as skill/rule. **Notion-tracked** rows (RFC, design doc, position paper, vision/insight, landscape analysis, audit) → in-band via the Notion MCP tools (`notion-create-pages`/`notion-update-page`) directly — not a guarded generated-file surface — but still follow the taxonomy's title pattern, status header, and cross-link-by-ID conventions | Repo docs: search for an existing open edit task on the file. Notion docs: `notion-search` for an existing page on the subject before creating a new one (memory `23771583`) |

## Worked examples

One example per destination class. Example 1 is the spec's acceptance-test
walkthrough (the originating incident); Examples 2–4 are illustrative.

### Example 1 (skill) — the originating incident

**Trigger:** While revising an essay, the agent web-searches current (2026)
AI-writing-tells conventions and applies the findings to the one essay in
front of it. The `engineering-writing` skill — the durable home for exactly
that knowledge — is loaded in context the whole time.

**Step 1:** "Current (2026) AI-writing-tells research names em-dashes and
rhetorical tricolons as the two highest-signal AI-prose markers, refining
the `engineering-writing` skill's existing tells list."

**Step 2:** `Destination: skill — rule-admission ladder rung 2 (mt#2874):
this is task-shaped procedural guidance (a checklist consulted when writing
prose), not a per-turn constraint or an incident fact. It updates an
existing skill's domain rather than creating a new artifact type.`

**Step 3:** `tasks_search "engineering-writing AI-writing-tells"` → finds no
open edit task (this walkthrough predates mt#2547's filing).

**Step 4:** Not inside a session scoped to edit `engineering-writing` (the
agent is mid-essay-revision, not inside a skill-maintenance session) → file
a session-backed edit task via `tasks_create`, carrying the refreshed
tells list verbatim in the spec. This is mt#2547's shape (\"Update
engineering-writing skill: refresh AI-voice-tells with current (2026)
research\").

**Step 5:** `Learned: AI-writing-tells research refresh → filed
[mt#2547](minsky://task/mt%232547) (skill: engineering-writing) — carries
the finding verbatim.`

### Example 2 (memory) — illustrative

**Trigger:** Mid-task, the agent discovers that a third-party API's rate
limit resets on a rolling 24-hour window from first call, not a calendar-day
boundary — a fact that will matter for any future task hitting that API, and
isn't written down anywhere in the codebase.

**Step 2:** `Destination: memory — mt#960 rubric: durable, and NOT derivable
from code/git/specs/rules (the API's rate-limit reset semantics live only in
its vendor docs, not in anything Minsky owns).`

**Step 3:** `memory_search "<api> rate limit reset window"` → no existing
entry.

**Step 4:** In-band `memory_create` with the fact, scoped `project`, tagged
to the API/integration.

**Step 5:** `Learned: <api> rate limit resets rolling-24h, not calendar-day →
captured as memory <id>.`

### Example 3 (rule) — illustrative

**Trigger:** While debugging a flaky test, the agent discovers that Bun's
`--preload` flag order interacts with a specific mock-setup module in a way
that silently no-ops the mock if the preload order is wrong — a gotcha that
should gate how _any_ future test in this area is written, not just fix the
one flaky test.

**Step 2:** `Destination: rule — rule-admission ladder rung 1 (mt#2874):
file-shaped guidance, scoped to test files via globs, not a per-turn
universal constraint (rung 5 would over-apply it to non-test work).`

**Step 3:** Search for an existing open edit task touching
`.minsky/rules/bun-test-patterns.mdc` or similar test-pattern rule → none
found.

**Step 4:** Not inside a session scoped to edit rules → file a session-backed
edit task carrying the preload-order gotcha verbatim, targeting the
appropriate `.minsky/rules/*.mdc` test-pattern source with a `globs` pattern
matching test files.

**Step 5:** `Learned: --preload order silently no-ops mocks under condition
X → filed mt#<placeholder> (rule: bun-test-patterns) — carries the repro
verbatim.`

### Example 4 (doc) — illustrative

**Trigger:** While updating `docs/deploy-minsky-railway.md`, the agent finds
that Railway's own docs now recommend a specific health-check grace-period
pattern for zero-downtime deploys that Minsky's guide doesn't mention —
reference-shaped knowledge for anyone setting up or debugging a deploy, not
a behavior the agent must apply unprompted.

**Step 2:** `Destination: doc — Documentation Taxonomy "Engineering guide"
row: "Here's how to set up X" / migration & ops steps → docs/<topic>.md
(repo-tracked, not Notion).`

**Step 3:** Search for an existing open edit task touching
`docs/deploy-minsky-railway.md` → none found.

**Step 4:** Repo-tracked engineering guide → session-backed edit task (same
guard tier as skill/rule), carrying the grace-period recommendation and its
Railway-docs citation verbatim — unless the agent is already inside a
session whose scope covers that file, in which case it edits directly.

**Step 5:** `Learned: Railway health-check grace-period pattern for
zero-downtime deploys → filed mt#<placeholder> (doc:
deploy-minsky-railway.md) — carries the citation verbatim.`

## Future work (out of scope for this skill)

- **Hermes-style skill-generation-from-URL.** Hermes' `/learn` can source an
  entire new skill from a URL, local dir, or walked-through workflow and
  author a standards-compliant `SKILL.md` from scratch. This skill only
  routes and lands _already-articulated_ knowledge into an _existing or
  simply-scoped_ artifact — full skill authorship-from-source is a plausible
  v2 extension, not built here.
- **The (B) detector, mt#2708.** This skill is the landing target the (B)
  proactive knowledge-acquisition detector points at — per the RFC's Phase 1
  sequencing ("routing before detection... it gives the detector a landing
  target"). Building the detector itself is out of scope here; mt#2708
  depends on this skill shipping first.
- **The graduation contract binds (B), not this skill.** The RFC's
  calibration-first graduation contract (disposition ask at ≤25 logged
  fires or ≤30 days post-ship) is a property of mt#2708's detector — a
  logging/calibration mechanism that can mis-fire and needs a review
  cadence. This skill has no calibration phase: it is deterministic
  routing logic, invoked explicitly or self-triggered with no false-positive
  surface of its own to calibrate.

## Cross-references

- [RFC: First-class agent-reasoning practices — proactive learn-capture +
  explicit epistemic status](https://app.notion.com/p/3a0937f03cb481a68699e419a5ce4da0)
  (Notion `3a0937f0-3cb4-81a6-8699-e419a5ce4da0`) — the design record, Part
  1, this skill implements.
- [mt#2708](minsky://task/mt%232708) — the (B) proactive-detection sibling
  task; depends on this skill for its landing target.
- [mt#2548](minsky://task/mt%232548) — the investigation that produced the
  (A)/(B) decomposition and this skill's design.
- [mt#2547](minsky://task/mt%232547) — the per-surface example (the
  `engineering-writing` AI-tells refresh) whose shape this skill's Example 1
  formalizes.
- Memory `0565b663` — "Agents learn for the task, not the corpus," the
  behavioral bridge this skill retires. Updated on this skill's ship to
  point here instead of presenting itself as the only mechanism.
- `documentation-taxonomy.mdc` — the ten-category doc classification this
  skill's Step 2 cites for doc destinations.
- `create-rule.mdc` Step 0 (mt#2874 rule-admission ladder) — the primary
  classification rubric this skill's Step 2 applies across all four
  destinations.
- CLAUDE.md `§Memory Usage` — the mt#960 derivability rubric for memory
  destinations.
- `decision-defaults.mdc §Subsystem-assignment verification` — the
  four-step citation-and-mapping protocol this skill's Step 2 mirrors
  (cite / quote / map / verdict), applied here to artifact-type
  classification instead of subsystem migration.
- `skill-authoring.mdc` — the canonical skill-edit workflow (source →
  compile → commit both) this skill's skill-destination landing follows.
- Memory `23771583` — "Probe the artifact store before creating a durable
  artifact" — the search-before-create discipline this skill's Step 3
  cites for memory and Notion-doc dedup.
- CLAUDE.md `§Probe before claiming a shared resource` (mt#1965 → mt#1990)
  — the parallel-work discipline this skill's Step 3 cites for
  skill/rule/doc edit-task dedup.
- [mt#2258](minsky://task/mt%232258) — attention-scarcity umbrella governing
  this skill's non-blocking posture.
- [mt#1034](minsky://task/mt%231034) — asks subsystem / attention-allocation
  substrate, the surfacing channel referenced by the RFC's non-blocking
  design.
