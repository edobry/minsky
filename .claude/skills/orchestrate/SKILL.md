---
name: orchestrate
description: >-
  Multi-task coordination: parent+subtask decomposition, parallel dispatch
  planning, dependency-graph navigation, and cross-task scope assessment. Use
  when: 'decompose mt#X', 'break this down into subtasks', 'coordinate mt#A and
  mt#B', 'dispatch in parallel', 'dependency order', "what's the order for...",
  'run X Y Z in parallel'. Does NOT own single-task lifecycle transitions —
  those belong to /plan-task, /implement-task, and /verify-task.
user-invocable: true
---

# Orchestrate

Multi-task coordination skill. Handles parent+subtask decomposition, parallel dispatch planning,
dependency-graph navigation, and cross-task scope assessment.

This skill does NOT own single-task lifecycle transitions:

- Planning and investigation → `/plan-task`
- Implementation and sessions → `/implement-task`
- Verification and merge → `/verify-task`

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

Optional: one or more task IDs (e.g., `/orchestrate mt#123` or `/orchestrate mt#A mt#B mt#C`).
If no task IDs are given, the skill works from context provided by the user.

## Coordination concerns

### A. Pre-decomposition: sweep for parallel work

**Before creating any subtasks or sibling tasks**, check whether parallel work already exists.
This prevents duplicate effort and coordination collisions.

Per `feedback_check_parallel_work_before_decomposing`: this sweep is required for ANY
`tasks_create` call for a bug-fix or decomposition, not just sibling-task creation. Three
recurrences (mt#1192/mt#1199, mt#1068/mt#1240, mt#1261/mt#1281) established this as a
mechanical rule.

**Sweep procedure:**

1. Call `mcp__minsky__tasks_list` with `status: "IN-PROGRESS"` to find active work.
2. Call `mcp__minsky__tasks_list` with `status: "TODO"` to find planned work.
3. Call `mcp__minsky__tasks_search` with keywords from the task title or domain area.
4. Check `mcp__minsky__tasks_children` if decomposing an existing parent task — subtasks
   may already be filed.
5. If overlapping tasks are found, surface them to the user before creating anything:

```
Parallel work detected:
- mt#X (IN-PROGRESS): "<title>" — same domain/files
- mt#Y (TODO): "<title>" — may conflict

Recommend: coordinate with mt#X before filing new subtasks, or subsume the scope if
mt#X's criteria are a strict subset.
```

### B. Subtask decomposition before dispatch

**For any non-trivial multi-phase task, decompose into subtasks first.**
Never dispatch subagents directly against a monolithic task with multiple phases.

Per `feedback_subagent_decomposition_first`: 5/5 non-trivial subagent dispatches on 2026-04-22
hit turn limits mid-implementation. Pre-decomposition via `tasks_create --parent` was the only
reliable fix.

**Decomposition procedure:**

1. Read the task spec: `mcp__minsky__tasks_spec_get` with the parent task ID.
2. Identify independent phases or components from the spec's Success Criteria and Scope.
3. For each phase, call `mcp__minsky__tasks_create` with `parent: "<parent-id>"`:
   - Title: scoped to the phase (e.g., "Implement X for mt#N")
   - Description: the specific success criteria for this phase
   - Status: "TODO"
4. Verify children were created: `mcp__minsky__tasks_children` with the parent ID.
5. Surface the decomposition to the user before dispatching:

```
Decomposed mt#N into:
- mt#N.1: "<phase-1-title>"
- mt#N.2: "<phase-2-title>" (depends on mt#N.1)
- mt#N.3: "<phase-3-title>"

Dependency order: mt#N.1 → mt#N.2 → mt#N.3

To implement each subtask, use /implement-task mt#N.1
```

**Sizing guideline:** each subtask should be bounded to 8–12 files of change. If a subtask
touches more than 12 files, decompose it further before dispatch.

### C. Parallel dispatch: file-overlap analysis

**Before dispatching parallel subagents, verify they do not share files.**
Parallel agents writing to the same file produce merge conflicts that block both branches.

Per `feedback_parallel_subagent_dispatch_pattern`: file-overlap analysis upfront (before any
parallel dispatch) is mandatory. Failure to do this produces conflicts that burned a session-
and-a-half in documented cases (e.g., PR #763, mt#1216 mid-iteration).

**File-overlap analysis procedure:**

1. For each candidate parallel task, read its spec and identify the files it will touch.
   Use `mcp__minsky__tasks_spec_get` + `mcp__minsky__session_grep_search` to map out the
   expected file set.
2. Build a file-set matrix:

| Task | Expected files             |
| ---- | -------------------------- |
| mt#A | src/domain/foo.ts, tests/… |
| mt#B | src/adapters/bar.ts, …     |
| mt#C | src/domain/foo.ts, …       |

3. Check for intersections across rows.
4. Branch on overlap:

   **No overlap** → dispatch all tasks in parallel. Provide the user with a prompt
   template for each subagent (use `mcp__minsky__session_generate_prompt`).

   **Overlap detected** → do NOT dispatch in parallel. Present the conflict:

```
File overlap detected:
- mt#A and mt#C both touch src/domain/foo.ts

Safe parallelism: mt#A ∥ mt#B (no shared files)
Must serialize: mt#C after mt#A (shared: src/domain/foo.ts)

Recommended order: dispatch mt#A ∥ mt#B first, then mt#C after mt#A merges.
```

### D. In-flight iteration: branch-divergence check

The pre-dispatch sweep in §A catches sibling work that's already filed/merged at decomposition
time. This rule extends that to the **review-iteration window** — once a PR is open and
iterating with `minsky-reviewer[bot]`, sibling tasks may merge to main and create a real
conflict that no MCP tool can resolve.

**Apply when coordinating any task that is IN-REVIEW with multi-round reviewer iteration.**
Per `feedback_check_branch_behind_main_during_iteration`: PR #763 (mt#1190) burned a
session-and-a-half because mt#1216 merged mid-iteration touching the same file, and
`session_update` then aborted on the conflict (mt#1303 gap, see Error recovery below).

**Procedure:** every 2-3 reviewer rounds OR when iteration has spanned >30 minutes:

1. `mcp__minsky__git_log` with `ref: "task/mt-X"` and `limit: 5` — record the branch HEAD.
2. `mcp__minsky__git_log` with `ref: "origin/main"` and `limit: 5` — note recent main commits.
3. If main has advanced and the branch's base ancestor hasn't moved, run
   `mcp__minsky__session_update` early — before more iteration commits stack up — so any
   conflicts surface while you still have buffer.
4. If `session_update` aborts on conflict, that's the mt#1303 gap. **Do not loop with
   different flags** (`skipConflictCheck`, `force`, `noStash` all abort identically). See
   "Error recovery → session_update aborts on conflict without markers" below.

**Pattern recognition for high-risk siblings:** tasks named `[same area] polish` /
`QoL bundle` / `calibration` are the most likely to touch overlapping files mid-iteration.
When dispatching alongside such a sibling, expect to apply this check more often.

## Error recovery

Operational realities that bit prior multi-task workflows hard. Each entry names the symptom,
the root cause, and the recovery path. These supplement the per-skill error handling — they
are surfaced at the orchestration layer because the recovery often spans skill boundaries
(e.g., bypass-merge after `/review-pr` cannot APPROVE).

| Symptom                                                                                                | Root cause                                                                                                                                                                                                                                                                                        | Recovery path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_update` reports "Content conflicts detected" but working tree is clean (no `<<<<<<<` markers) | mt#1303 tooling gap: the tool aborts the merge cleanly on conflict and reverts the merge state. There is currently no MCP path to leave conflict markers for manual resolution. Direct `git merge` is hook-blocked. Looping with `skipConflictCheck` / `force` / `noStash` all abort identically. | When content compatibility is achievable but git's 3-way merge sees overlapping edits: (1) `mcp__minsky__session_exec` `git reset --hard origin/main` (carve-out is allowed); (2) use `mcp__minsky__session_write_file` to rewrite the conflicting file(s) with the desired final content; (3) `mcp__minsky__session_commit`; (4) `mcp__minsky__git_push` with `force: true`. **Cost: this loses the multi-commit history of the branch — the PR effectively becomes a single squashed commit.** Acceptable for feature PRs; loses signal for debugging-trail PRs. Escalate to the user if blocking — they can run `git merge` outside hook scope. |
| `minsky-reviewer[bot]` silent for >5 min after a follow-up push that addressed BLOCKING findings       | mt#1110-class webhook-miss-on-subsequent-push reliability gap. Distinct from CI not firing (which is a separate webhook/CI-trigger problem). Same-App-identity APPROVE block does NOT apply here — that's a structural gate; this is a reliability gate.                                          | (1) Confirm push reached GitHub: `mcp__minsky__session_pr_get`, check `head.sha`. (2) Try an empty commit to wake the webhook: `mcp__minsky__session_commit` with `noFiles: true` and `noStage: true`, then push. (3) If still silent, escalate via `gh api PUT /repos/.../pulls/N/merge` (`merge_method=merge`, never `squash`) — only after BLOCKING findings are addressed and remaining gap is the missing reviewer signal. (4) After bypass merge, manually clean up the session: `mcp__minsky__session_delete`. (5) Track the instance in `project_mt1110_calibration_data.md`. See `/review-pr` step 7a and `feedback_gh_api_bypass`.       |

## Dependency graph navigation

When the user asks "what's the order for mt#A, mt#B, mt#C" or similar, use
`mcp__minsky__tasks_deps_tree` to read the dependency graph and surface a concrete
execution order.

**Navigation procedure:**

1. Call `mcp__minsky__tasks_deps_tree` for each task in the set.
2. Build a topological sort from the dependency edges.
3. Surface the ordering as a numbered list with rationale:

```
Execution order for mt#A, mt#B, mt#C:

1. mt#B — no dependencies, unblocked
2. mt#A — depends on mt#B (must wait for mt#B to merge)
3. mt#C — depends on mt#A and mt#B (must be last)

Independent tasks that can run in parallel: none (linear dependency chain)
```

If no dependencies exist between tasks, confirm they are all unblocked and parallel dispatch
is safe (subject to file-overlap check in §C above).

## Dispatch handoff

After decomposition and/or ordering, hand off to the appropriate phase skills:

- **For each subtask that is TODO and needs planning:**
  > "Run `/plan-task mt#N.1` to investigate and bring it to READY."
- **For each subtask that is READY and needs implementation:**
  > "Run `/implement-task mt#N.1` to start development."
- **For each task that is IN-REVIEW:**
  > "Run `/verify-task mt#N.1` to verify and close out."

Do NOT call `session_start`, `session_pr_create`, or any single-task lifecycle primitive
directly. This skill's responsibility ends at surfacing the coordination plan and handing off
to the appropriate phase skill.

## Key constraints

- **Never call `session_start` directly.** Session creation belongs to `/implement-task`.
- **Never call `session_pr_create` directly.** PR creation belongs to `/implement-task`.
- **Never set task status directly.** Status transitions belong to the phase skills.
- **Always sweep for parallel work before decomposing.** This is a mechanical pre-check, not optional.
- **Always analyze file overlap before parallel dispatch.** Two agents on the same file produce conflicts.
- **Decompose before dispatch.** Monolithic tasks dispatched to subagents hit turn limits.
