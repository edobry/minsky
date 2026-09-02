import { defineSkill } from "../../../packages/domain/src/definitions/factories";
import { GATE_BATTERY } from "./gate-battery";
import { ACT_ON_RESULTS } from "./act-on-results";

export default defineSkill({
  name: "plan-task",
  description:
    "Drive a task through PLANNING to READY: investigate the spec, surface gaps, file subtasks, and run the gate check. Use when: 'investigate mt#X', 'plan mt#X', 'look into mt#X', \"what's the gap for mt#X\", 'bring mt#X to ready', 'research mt#X', 'analyze mt#X spec'. Does NOT create new tasks (use /create-task) and does NOT implement (use /implement-task).",
  userInvocable: true,
  content: `
# Plan Task

Drive an existing task from TODO through PLANNING to READY by investigating its spec, surfacing
gaps, filing any needed subtasks, and running the PLANNING → READY gate check.

## Arguments

Required: a task ID (e.g., \`/plan-task mt#915\` or \`investigate mt#915\`).

## Triggers

This skill auto-invokes on:

- "investigate mt#X"
- "plan mt#X"
- "look into mt#X"
- "what's the gap for mt#X"
- "bring mt#X to ready"
- "research mt#X"
- "analyze mt#X spec"

It does **not** trigger on task creation intents (use \`/create-task\`) or implementation
intents (use \`/implement-task\`).

## PLANNING lifecycle ownership

This skill owns the **TODO → PLANNING → READY** state arc. The first mechanical step is always
a status transition; everything else is investigation and gate-check.

## Process

- Step 1: Transition to PLANNING (idempotent)
- Step 2: Read and verify the spec
- Step 2.5: Premise audit (four checks — must run before the gate)
- Step 3: Run the PLANNING → READY gate check
  - (a) Required spec sections present
  - (b) Success criteria are testable
  - (c) Scope is bounded
  - (d) No blocking questions
  - (e) File:line references are fresh
  - (f) Subtasks filed for multi-phase work
  - (g) No parallel work in flight
  - (h) Contract-propagation enumeration
  - (j) Premise label verification (letter \`i\` intentionally skipped to avoid confusion
    with the Roman-numeral premise-audit labels \`(i)\`/\`(ii)\`/\`(iii)\`/\`(iv)\` used in Step 2.5)
  - (k) Third-party tool/dependency verification
  - (l) Authoritative-source check for third-party-system decisions (security surfaces,
    designing a mechanism on a third-party's internals, or how to use a named tool with docs)
  - (m) Factual-claim citation verification
  - (n) External-system integration provisioning enumeration
  - (o) Problem-statement verification (reproduce a spec's asserted runtime/causal failure before accepting it)
  - (p) First-party decision-record check (search the in-repo ADR corpus before proposing a mechanism)
- Step 4: Act on gate results

### Step 1: Transition to PLANNING (idempotent)

1. Call \`mcp__minsky__tasks_status_get\` with the task ID to read the current status.
2. Branch on current status:
   - **TODO** → call \`mcp__minsky__tasks_status_set\` to transition to **PLANNING**.
   - **PLANNING** → already in the right state; proceed without re-transitioning.
   - **READY** → task is already gate-passed. Confirm with the user whether to re-investigate
     or stop. Default: stop and report it's READY.
   - **IN-PROGRESS / IN-REVIEW / DONE** → task is past the planning phase. Inform the user
     and stop — do not attempt to walk the status backward.
   - **BLOCKED** → surface the blocker, do not transition.

### Step 2: Read and verify the spec

1. Call \`mcp__minsky__tasks_spec_get\` to load the full task specification.
2. Check that the spec is substantive — not just a one-line title. If the spec is empty or
   only contains a title, that is itself a blocking gap (surface it now).
3. Note any file:line references and verify them against the current codebase (use
   \`mcp__minsky__session_exec\` or \`mcp__minsky__session_grep_search\` to confirm they exist
   and point to the right code).
4. **Heartbeat reminder (mt#2824).** This investigation step and the premise audit below
   commonly chain several tool calls back-to-back with no interstitial prose. Emit a
   one-line heartbeat (current activity + health signal) at least every 10 minutes or 15
   consecutive tool calls, whichever comes first — see \`user-preferences.mdc §Progress
   heartbeats during tool-only stretches\`. Don't hold a genuine blocking finding for the
   next scheduled heartbeat; report it immediately.
5. **Search BEFORE you write an ownership claim (mt#3806).** If rescoping this spec is about
   to put a claim about *who owns something* into it — "unowned", "no task covers this",
   "nothing handles this", or a file-level collision with named other work — run the search
   that would falsify it FIRST: \`mcp__minsky__tasks_search\` for the ownership claim,
   \`get_files\`/\`git_log --path\` for the file claim (gate (g) check 1 spells both out). **A
   negative ownership claim must cite the search that supports it, or not be written.**

   This step exists because the search is already guaranteed — and was, by this skill, at the
   wrong time. In the originating incident (\`/plan-task mt#3682\`, 2026-08-08) an agent wrote
   "unowned — no task covers this today" into a spec's \`## Does NOT cover\`; gate (g) then ran
   \`tasks_search\` **two minutes later, in the same skill run**, and returned mt#3826, which had
   covered it for four hours and supplied the cause the spec called undetermined. No amount of
   diligence fixes an ordering: the skill consulted its own oracle after the artifact was
   written.

   **Only the search hoists, not the whole gate.** Gate (g)'s path-collision check consumes the
   spec's \`## Scope\` → \`In scope\` file list, so it cannot run before the spec is read — moving
   the full gate here would break its own input. What moves is the cheap part that has no such
   dependency: the ownership search. Gate (g) still runs in full at Step 3; this makes the claim
   the trigger rather than the step.

6. **Enumerate EVERY required-actions section, not just the template's (mt#4177).** On a re-run
   against a task that already carries a gap report, grep the spec's headings for every
   required-actions list — match \`required actions\` **case-insensitively at any heading depth**,
   since the template emits \`### Required actions before READY\` but a later amendment writes its
   own under a variant (\`### Required actions added\`, \`### Further required actions\`). **Name each
   section you found in the audit output**, so a reader can tell "walked both" from "walked one and
   did not know there was another."

   **Then classify each match — the pattern deliberately over-matches.** A heading like
   \`## Required actions resolved (2026-08-16)\` is a RECORD of discharge, not a list of owed work,
   and a later pass must not try to re-discharge it. Sort the matches into OWED and RESOLVED, name
   which is which, and walk only the owed ones. Over-matching then costs one line of triage;
   under-matching costs a missed action, which is the failure this item exists to prevent — so the
   pattern is loose on purpose and the reading is where precision belongs.

   Each action in every OWED section is discharged before READY, or explicitly deferred with a
   reason. A second owed list is not optional context — its items are numbered as a continuation of
   the first, which is exactly what makes a partial read look complete.

   Originating incident (mt#2755, 2026-08-16): the spec carried actions 1-4 under the template's
   heading and actions **5, 6, 7** under \`### Required actions added\`, appended by a premise
   correction five days later with no forward pointer from the first list. A re-run discharged 1-4
   and set READY. Action 6 was "before speccing any queued detector, read the shipped
   policy-coverage detector and record whether each is a consumer" — and three detector children
   had already been filed without it.

   Why this is a procedure fix rather than a spec-hygiene rule: the corpus ENCOURAGES appending
   (gap reports, premise corrections and deviation records are all appended sections), and a
   correction that surfaces new work naturally writes its own list rather than editing a section
   another pass authored days earlier. Requiring future specs to consolidate would not repair the
   ones that already exist.

### Step 2.5: Premise audit

Before running the spec-quality gate, answer all four checks below explicitly in your
planning output. **READY recommendations, closure recommendations, and new-task creation
calls are blocked until all four answers are stated.**

Each check is a separate sub-section in the output. Use the (i)/(ii)/(iii)/(iv) labels.

#### Premise check (i) — Open hypotheses

Does the parent investigation (or the spec being planned) explicitly leave premises open
that this task is treating as settled?

- Name any open premises the spec carries forward as if they were resolved facts.
- Identify what evidence or decision would resolve each open premise.
- Either gate the task on that resolution, or rescope to be premise-independent.

If no open premises exist, state that explicitly: "(i) No open premises identified."

#### Categorization check (ii) — Scope/label fit

Is the plan relying on a categorization (scope label, file pattern, tier, classifier
verdict) — and does that categorization actually fit the change's nature, or is it
inherited from a heuristic built for a different purpose?

- Name any categorization the plan depends on.
- Verify it was designed for this type of change (not just pattern-matched).
- If the categorization is suspect: file a separate task to fix the classifier rather than
  building on its bad output. Do not proceed on a categorization you cannot validate.

If no categorization is relied on, state that explicitly: "(ii) No inherited categorization relied on."

#### Parallel-work check (iii) — In-flight overlap

Before recommending closure, amendment, or new tasks: run \`mcp__minsky__tasks_search\`
with subsystem keywords from the task being planned. Surface any in-flight tasks that
touch the same files, subsystem, or problem class.

This check fires the moment the planning flow generates a closure, amendment, or new-task
recommendation — not only on the actual \`tasks_create\` call.

Report any overlapping tasks found. If none: "(iii) No overlapping in-flight tasks found."

#### Framing check (iv) — Symptom vs. structure

Before recommending implementation, ask: "Is this fixing a symptom of a deeper structural
issue?"

If a fix repeatedly recurs in the same area (sanitizer iteration #N, prompt iteration #N,
classifier patch #N), surface the structural reframe as a follow-up RFC even when shipping
the tactical patch.

**Socratic-premise sub-check.** When stuck on a tactical recommendation, decompose the
operation being patched into its constituent parts. Ask: "What are the actual sub-operations
of this thing? Are they being conflated?" Apply Socratic decomposition of the operation
being patched as part of this check — not just pattern-matching on cluster shape.

**Architecture-consistency sub-check (mt#1856).** When the spec proposes a **new
capability, abstraction, substrate, or module**, it must name one of: (a) **which
existing pattern it extends** — a sibling ADR's capability slot (e.g., an ADR-002
persistence-provider capability), an existing module's interface, an established
convention; OR (b) **explicit justification for a new pattern** — why the existing
pattern doesn't fit and what alternatives were rejected. A spec that introduces a new
structural element without naming the extend-vs-introduce choice fails this sub-check.
Originating incident (2026-05-15, mt#1852 / ADR-010): the substrate choice was framed
as novel without checking it against the existing \`project_supabase\` pattern, which
let "session vs transaction pool mode" and "pooled vs direct connection" collapse under
the salient phrase "no LISTEN/NOTIFY."

**Design-intent-assertion citation sub-check (mt#1676).** When the recommendation depends
on an **asserted claim about Minsky's design intent** — trigger phrases such as "X is part
of Minsky's design intent," "the right move per the strategic frame," "X is the role of
surface Y," "this surface is for A, not B," "the design trajectory is Z" — the gate requires
the agent to either (a) **cite a specific corpus source** (task ID, memory ID, Notion page
ID, ADR number, CLAUDE.md section), or (b) **explicitly disclaim it as a hypothesis** ("I'm
asserting this without evidence; treat as hypothesis"). If neither is present, the sub-check
fails — surface the gap before recommending the action. This is the _asserting_ direction
(agent invents a frame to justify a tactical preference); \`feedback_strategic_reframe_first\`
covers the _connecting_ direction (user's tactical ask → existing frame). Originating incident
(2026-05-08 hosted-MCP framing failure): the agent asserted "hosted MCP is the task-management
substrate, not a session-runner" with no evidence and against the actual corpus (mt#263,
mt#190, Progressive Adoption Model T4).

If no structural issue is suspected: "(iv) No recurring pattern identified; tactical fix is appropriate."

${GATE_BATTERY}${ACT_ON_RESULTS}`,
});
