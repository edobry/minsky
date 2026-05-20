import { defineSkill } from "../../../src/domain/definitions/factories";

export default defineSkill({
  name: "orchestrate",
  description:
    "Multi-task coordination: parent+subtask decomposition, parallel dispatch planning, dependency-graph navigation, and cross-task scope assessment. " +
    "Use when: 'decompose mt#X', 'break this down into subtasks', 'coordinate mt#A and mt#B', 'dispatch in parallel', 'dependency order', \"what's the order for...\", 'run X Y Z in parallel'. " +
    "Does NOT own single-task lifecycle transitions — those belong to /plan-task, /implement-task, and /verify-task.",
  userInvocable: true,
  content: `# Orchestrate

Multi-task coordination skill. Handles parent+subtask decomposition, parallel dispatch planning,
dependency-graph navigation, and cross-task scope assessment.

This skill does NOT own single-task lifecycle transitions:
- Planning and investigation → \`/plan-task\`
- Implementation and sessions → \`/implement-task\`
- Verification and merge → \`/verify-task\`

## Triggers

This skill activates on multi-task coordination verbs:
- "decompose mt#X"
- "break this down into subtasks"
- "coordinate mt#A and mt#B"
- "dispatch in parallel"
- "dependency order"
- "what's the order for…"
- "run X Y Z in parallel"

This skill does NOT trigger on single-task verbs: "start working on", "implement mt#X",
"investigate mt#X" — those belong to the phase skills above.

## Arguments

Optional: one or more task IDs (e.g., \`/orchestrate mt#123\` or \`/orchestrate mt#A mt#B mt#C\`).
If no task IDs are given, the skill works from context provided by the user.

## Coordination concerns

### A. Pre-decomposition: sweep for parallel work

**Before creating any subtasks or sibling tasks**, check whether parallel work already exists.
This prevents duplicate effort and coordination collisions.

Per \`feedback_check_parallel_work_before_decomposing\`: this sweep is required for ANY
\`tasks_create\` call for a bug-fix or decomposition, not just sibling-task creation. Three
recurrences (mt#1192/mt#1199, mt#1068/mt#1240, mt#1261/mt#1281) established this as a
mechanical rule.

**Sweep procedure:**

1. Call \`mcp__minsky__tasks_list\` with \`status: "IN-PROGRESS"\` to find active work.
2. Call \`mcp__minsky__tasks_list\` with \`status: "TODO"\` to find planned work.
3. Call \`mcp__minsky__tasks_search\` with keywords from the task title or domain area.
4. Check \`mcp__minsky__tasks_children\` if decomposing an existing parent task — subtasks
   may already be filed.
5. If overlapping tasks are found, surface them to the user before creating anything:

\`\`\`
Parallel work detected:
- mt#X (IN-PROGRESS): "<title>" — same domain/files
- mt#Y (TODO): "<title>" — may conflict

Recommend: coordinate with mt#X before filing new subtasks, or subsume the scope if
mt#X's criteria are a strict subset.
\`\`\`

### B. Subtask decomposition before dispatch

**For any non-trivial multi-phase task, decompose into subtasks first.**
Never dispatch subagents directly against a monolithic task with multiple phases.

Per \`feedback_subagent_decomposition_first\`: 5/5 non-trivial subagent dispatches on 2026-04-22
hit turn limits mid-implementation. Pre-decomposition via \`tasks_create --parent\` was the only
reliable fix.

**Decomposition procedure:**

1. Read the task spec: \`mcp__minsky__tasks_spec_get\` with the parent task ID.
2. Identify independent phases or components from the spec's Success Criteria and Scope.
3. For each phase, call \`mcp__minsky__tasks_create\` with \`parent: "<parent-id>"\`:
   - Title: scoped to the phase (e.g., "Implement X for mt#N")
   - Description: the specific success criteria for this phase
   - Status: "TODO"
4. Verify children were created: \`mcp__minsky__tasks_children\` with the parent ID.
5. Surface the decomposition to the user before dispatching:

\`\`\`
Decomposed mt#N into:
- mt#N.1: "<phase-1-title>"
- mt#N.2: "<phase-2-title>" (depends on mt#N.1)
- mt#N.3: "<phase-3-title>"

Dependency order: mt#N.1 → mt#N.2 → mt#N.3

To implement each subtask, use /implement-task mt#N.1
\`\`\`

**Sizing guideline:** each subtask should be bounded to 8–12 files of change. If a subtask
touches more than 12 files, decompose it further before dispatch.

### C. Parallel dispatch: file-overlap analysis

**Before dispatching parallel subagents, verify they do not share files.**
Parallel agents writing to the same file produce merge conflicts that block both branches.

Per \`feedback_parallel_subagent_dispatch_pattern\`: file-overlap analysis upfront (before any
parallel dispatch) is mandatory. Failure to do this produces conflicts that burned a session-
and-a-half in documented cases (e.g., PR #763, mt#1216 mid-iteration).

**File-overlap analysis procedure:**

1. For each candidate parallel task, read its spec and identify the files it will touch.
   Use \`mcp__minsky__tasks_spec_get\` + \`mcp__minsky__session_grep_search\` to map out the
   expected file set.
2. Build a file-set matrix:

| Task   | Expected files              |
|--------|-----------------------------|
| mt#A   | src/domain/foo.ts, tests/… |
| mt#B   | src/adapters/bar.ts, …      |
| mt#C   | src/domain/foo.ts, …        |

3. Check for intersections across rows.
4. Branch on overlap:

   **No overlap** → dispatch all tasks in parallel. Provide the user with a prompt
   template for each subagent (use \`mcp__minsky__session_generate_prompt\`).

   **Overlap detected** → do NOT dispatch in parallel. Present the conflict:

\`\`\`
File overlap detected:
- mt#A and mt#C both touch src/domain/foo.ts

Safe parallelism: mt#A ∥ mt#B (no shared files)
Must serialize: mt#C after mt#A (shared: src/domain/foo.ts)

Recommended order: dispatch mt#A ∥ mt#B first, then mt#C after mt#A merges.
\`\`\`

### D. DAG filing: wave-by-wave with dependsOn, not bulk-create-then-wire

**When filing a multi-task graph that carries real dependency edges** (e.g., an umbrella + N children where some children depend on others), the default pattern is **wave-by-wave filing** with \`dependsOn\` populated at \`tasks_create\` time — NOT bulk-create-then-bulk-wire.

The anti-pattern: \`tasks_create\` for every node in parallel batches with NO deps, then \`tasks_deps_add\` for every edge in a final batch. The two-phase shape looks faster (more parallelism on the API calls) but has worse atomic-failure semantics: if the deps-add phase fails mid-flight (network glitch, validation rejection, race), the umbrella has N children but partial-or-zero dependency edges. Recovery requires manually inspecting which edges landed and replaying the missing ones — exactly the silent half-shipped state the recovery-layer discipline (CLAUDE.md \`§Work Completion > Recovery layer spec discipline\`) prohibits.

The correct pattern leverages \`tasks_create\`'s existing \`dependsOn\` parameter:

\`\`\`
Wave 0: file root task alone (no deps).
        → \`tasks_create(title="Umbrella mt#1234")\`

Wave 1: file tasks whose deps are ALL in Wave 0, with dependsOn populated.
        → \`tasks_create(title="Phase 1a", parent="mt#1234", dependsOn=[])\` (no deps within the wave)
        → \`tasks_create(title="Phase 1b", parent="mt#1234", dependsOn=[])\`

Wave 2: file tasks whose deps are ALL in Waves 0-1, with dependsOn populated.
        → \`tasks_create(title="Phase 2 — needs 1a + 1b", parent="mt#1234", dependsOn=["mt#1235", "mt#1236"])\`

Continue until DAG is complete.
\`\`\`

**Why wave-by-wave is the default:**

- **Atomic per wave.** Each wave's \`tasks_create\` calls succeed or fail atomically per task; the dependency edge is part of the same call. No "task exists but edge doesn't" state.
- **Failure recovery is local.** If wave 2 fails, waves 0 and 1 are already complete with correct edges. Replay only the failed wave.
- **No re-traversal cost.** The deps-add phase in the bulk pattern requires looking up the IDs of just-created tasks to wire edges; wave-by-wave already has the IDs in hand from the prior wave.

**Trade-off (be honest):**

- Bulk-create-then-wire is fewer turns total (more parallelism per phase) but worse failure semantics.
- Wave-by-wave is roughly the same wall-clock at typical DAG sizes (3–10 tasks, 1–3 waves) but cleaner failure semantics.
- For trivial DAGs (single parent + N independent children with no inter-sib deps), the patterns converge — both reduce to one wave of \`tasks_create\` calls with no edges to wire. The discipline matters when the graph has inter-sibling dependencies.

**When this fires:** \`tasks_create\` calls for 2+ related tasks where at least one sibling depends on another, OR an umbrella with children that have inter-sibling edges. The signal is "multi-task filing with \`tasks_deps_add\` calls planned afterward" — surface the wave structure first, file with \`dependsOn\` populated, never queue deps-add as a separate phase.

## Dependency graph navigation

When the user asks "what's the order for mt#A, mt#B, mt#C" or similar, use
\`mcp__minsky__tasks_deps_tree\` to read the dependency graph and surface a concrete
execution order.

**Navigation procedure:**

1. Call \`mcp__minsky__tasks_deps_tree\` for each task in the set.
2. Build a topological sort from the dependency edges.
3. Surface the ordering as a numbered list with rationale:

\`\`\`
Execution order for mt#A, mt#B, mt#C:

1. mt#B — no dependencies, unblocked
2. mt#A — depends on mt#B (must wait for mt#B to merge)
3. mt#C — depends on mt#A and mt#B (must be last)

Independent tasks that can run in parallel: none (linear dependency chain)
\`\`\`

If no dependencies exist between tasks, confirm they are all unblocked and parallel dispatch
is safe (subject to file-overlap check in §C above).

## Dispatch handoff

After decomposition and/or ordering, hand off to the appropriate phase skills:

- **For each subtask that is TODO and needs planning:**
  > "Run \`/plan-task mt#N.1\` to investigate and bring it to READY."
- **For each subtask that is READY and needs implementation:**
  > "Run \`/implement-task mt#N.1\` to start development."
- **For each task that is IN-REVIEW:**
  > "Run \`/verify-task mt#N.1\` to verify and close out."

Do NOT call \`session_start\`, \`session_pr_create\`, or any single-task lifecycle primitive
directly. This skill's responsibility ends at surfacing the coordination plan and handing off
to the appropriate phase skill.

## Post-merge deploy verification across an epic

When an epic's subtasks land code that runs in a deployed service, the agent driving the epic should verify each merge's deploy succeeded — Railway redeploys are not "the build checks passed, we're done." A Dockerfile breakage, missing env var, or container-start crash shows up post-merge and won't be caught by pre-merge CI. Use the platform-neutral MCP tools that wrap the deployment platform (Railway is the v1 concrete adapter; v2 candidates: Vercel, Cloudflare Pages, Fly.io, etc.).

After any subtask merge that touches deployed code, call \`mcp__minsky__deployment_wait-for-latest\` to block on the auto-deploy and surface the terminal status. On FAILED / CRASHED, call \`mcp__minsky__deployment_logs\` for the failed deployment ID and surface the build/runtime failure to the user. See \`docs/deployment-platforms.md\` for the abstraction and \`/implement-task\` step 10 for the single-task variant.

## Key constraints

- **Never call \`session_start\` directly.** Session creation belongs to \`/implement-task\`.
- **Never call \`session_pr_create\` directly.** PR creation belongs to \`/implement-task\`.
- **Never set task status directly.** Status transitions belong to the phase skills.
- **Always sweep for parallel work before decomposing.** This is a mechanical pre-check, not optional.
- **Always analyze file overlap before parallel dispatch.** Two agents on the same file produce conflicts.
- **Decompose before dispatch.** Monolithic tasks dispatched to subagents hit turn limits.
- **File DAGs wave-by-wave with \`dependsOn\` populated, never bulk-create-then-bulk-wire.** Two-phase filing leaves orphan-edge state on mid-flight failure; \`tasks_create\`'s \`dependsOn\` parameter is the right primitive. See §D.
`,
});
