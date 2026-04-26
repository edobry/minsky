import { defineSkill } from "../../../src/domain/definitions/factories";

export default defineSkill({
  name: "plan-task",
  description:
    "Drive a task through PLANNING to READY: investigate the spec, surface gaps, file subtasks, and run the gate check. Use when: 'investigate mt#X', 'plan mt#X', 'look into mt#X', \"what's the gap for mt#X\", 'bring mt#X to ready', 'research mt#X', 'analyze mt#X spec'. Does NOT create new tasks (use /create-task) and does NOT implement (use /implement-task).",
  content: `# Plan Task

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

### Step 3: Run the PLANNING → READY gate check

Evaluate each criterion in order. A single **fail** halts promotion to READY; surface all
failures together so the user can address them in one pass.

#### Gate criterion (a) — Required spec sections present

The spec must have **all five** of the following top-level sections (exact heading text):

- \`## Summary\`
- \`## Success Criteria\`
- \`## Scope\`
- \`## Acceptance Tests\`
- \`## Context\`

Check each section's presence. Record any missing sections as blocking gaps.

#### Gate criterion (b) — Success criteria are testable

Each item under \`## Success Criteria\` must be independently verifiable by an agent or a
human reviewer. Reject criteria that:
- Use vague language ("should work correctly", "behaves as expected", "is improved")
- Cannot be checked by running a command, reading a file, or calling a tool
- Are aspirational rather than observable

For each weak criterion, write a concrete revision and surface it as a gap.

#### Gate criterion (c) — Scope is bounded

\`## Scope\` must contain explicit **In scope** and **Out of scope** (or equivalent) lists.
A scope section that only describes what is in scope (no out-of-scope list) is insufficient —
without an out-of-scope list, creep risk is unmanaged. Surface as a gap if missing.

#### Gate criterion (d) — No blocking questions

Look for any open questions in the spec or in the task's history that would prevent starting
implementation. Indicators:
- "TBD" or "TODO" items inside the spec text
- Unresolved design decisions ("[open question: …]" patterns)
- Dependencies on unmerged PRs or incomplete tasks (check status of listed deps)

If blocking questions exist, list them explicitly. They must be answered before READY.

#### Gate criterion (e) — File:line references are fresh

For every \`path/to/file.ts:N\` reference in the spec:
1. Verify the file exists in the current codebase.
2. Verify the referenced code (function, class, constant) is still present near line N (±10).
3. If a reference is stale, note the stale ref and the correct location (or note it was deleted).

If no file:line references exist in the spec, this criterion passes automatically.

#### Gate criterion (f) — Subtasks filed for multi-phase work

If the task spec describes work that spans multiple independent phases, components, or team
boundaries, confirm that child subtasks have been filed (check \`mcp__minsky__tasks_children\`).
If the parent has no children but the work clearly decomposes, surface "subtasks not yet filed"
as a blocking gap and propose the decomposition.

Single-phase tasks pass this criterion automatically.

### Step 4: Act on gate results

**All gate criteria pass:**

1. Report the gate summary (all green).
2. Call \`mcp__minsky__tasks_status_set\` to transition the task to **READY**.
3. Report: "Task mt#X is now READY for implementation. Use \`/implement-task mt#X\` to begin."

**One or more gate criteria fail:**

1. Do **not** call \`tasks_status_set\` → READY.
2. Task remains in PLANNING.
3. Present a structured gap report:

\`\`\`
## Gap Report for mt#X (PLANNING — not yet READY)

### Blocking gaps
- [criterion letter] <description of gap>
- [criterion letter] <description of gap>

### Required actions before READY
1. <concrete action the user or agent must take>
2. <concrete action the user or agent must take>

To re-run the gate after fixes: \`/plan-task mt#X\`
\`\`\`

4. Stop. Do not attempt to patch the spec automatically unless the user explicitly asks.

## State transition map

| Current status   | Action                                           |
|------------------|--------------------------------------------------|
| TODO             | → PLANNING (first step), then investigate + gate |
| PLANNING         | Skip transition, investigate + gate              |
| READY            | Report already READY, stop (confirm to re-run)   |
| IN-PROGRESS      | Out of scope for this skill; inform user         |
| IN-REVIEW        | Out of scope for this skill; inform user         |
| DONE             | Out of scope for this skill; inform user         |
| BLOCKED          | Surface blocker, do not transition               |

## Key constraints

- **Never set DONE** — only the merge + post-merge audit flow does that.
- **Never start a session** — that is \`/implement-task\`'s responsibility.
- **Never create the task** — use \`/create-task\` for new tasks.
- **Idempotent transitions** — calling \`tasks_status_set\` → PLANNING when already PLANNING
  is a no-op; the skill handles this by reading status first.
`,
});
