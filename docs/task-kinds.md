# Task Kinds — Engineering Guide

Minsky tasks have a `kind` field that selects the **per-kind workflow definition**:
the state machine, allowed transitions, terminal states, and the mapping tables
that describe how to represent tasks of this kind in external tools (GitHub Issues,
Linear, Jira).

This document covers:

- What task kind is and why it exists
- The v1 kinds: `implementation`, `umbrella`, and `state-ops`
- The workflow definition shape (state machine + mapping tables)
- How to add a new kind
- Cross-references and backfill

---

## The concept

### Lifecycle axis vs. work-content axis

Task kind operates on the **lifecycle axis**: which state machine applies to this task?
It is orthogonal to the **work-content axis** (mt#455), which classifies what kind of
work a task involves (research, design, implementation, refactor, docs, test, chore).

| Field  | Axis         | Values (v1)                               | Answers                              |
| ------ | ------------ | ----------------------------------------- | ------------------------------------ |
| `kind` | Lifecycle    | `implementation`, `umbrella`, `state-ops` | Which state machine applies?         |
| `type` | Work content | (mt#455)                                  | What kind of work does this task do? |

### Why kind exists

The original state machine (`TODO → PLANNING → READY → IN-PROGRESS → IN-REVIEW → DONE`)
was designed for tasks that ship via a pull request. It worked well for implementation
tasks but broke down for **umbrella tasks** (epics, tracking issues) that:

- Aggregate child tasks without producing a PR of their own
- Complete when all children complete, not when a PR is merged
- Don't have a planning gate (READY), code review phase (IN-REVIEW), or a PR-merged terminal state (DONE)

The originating incident (mt#1768, 2026-05-13) was an umbrella task that sat at READY
with all 10 children DONE. The state machine had no clean terminal path — DONE requires
an IN-REVIEW transition, but there's no PR to review. The workaround was to CLOSE the
task with a completion note, which misrepresents completion as abandonment.

---

## v1 Kinds

### `implementation` (default)

The existing state machine, encoded as data. All tasks created before mt#1812 shipped
have this kind by default (via the `kind TEXT NOT NULL DEFAULT 'implementation'` column).

**States:** `TODO`, `PLANNING`, `READY`, `IN-PROGRESS`, `IN-REVIEW`, `DONE`, `BLOCKED`, `CLOSED`

**Transitions:**

```
TODO      → PLANNING, CLOSED
PLANNING  → READY, TODO, BLOCKED, CLOSED
READY     → PLANNING, BLOCKED, CLOSED
IN-PROGRESS → IN-REVIEW, BLOCKED, PLANNING, CLOSED
IN-REVIEW → IN-PROGRESS, DONE, BLOCKED, CLOSED
DONE      → CLOSED
BLOCKED   → TODO, PLANNING, READY, CLOSED
CLOSED    → TODO (reopen)
```

**Terminal states:** `DONE`, `CLOSED`

**Special cases (enforced by the gate, not the workflow data):**

- `READY → IN-PROGRESS` can only happen via `session_start`, not `tasks_status_set`.
- `PLANNING → IN-PROGRESS` must go through READY first.

**Tool mappings:**
| State | GitHub Issues | Linear | Jira |
|-------|--------------|--------|------|
| TODO | open | Backlog | To Do |
| PLANNING | open | Todo | In Planning |
| READY | open | Todo | Ready |
| IN-PROGRESS | open | In Progress | In Progress |
| IN-REVIEW | open | In Review | In Review |
| DONE | closed | Done | Done |
| BLOCKED | open (+ label) | Backlog (+ label) | Blocked |
| CLOSED | closed | Canceled | Canceled |

---

### `umbrella`

A simpler lifecycle for epic/metadata tasks with no associated PR.

**States:** `TODO`, `PLANNING`, `IN-PROGRESS`, `COMPLETED`, `CLOSED`

**Transitions:**

```
TODO       → PLANNING, CLOSED
PLANNING   → IN-PROGRESS, CLOSED
IN-PROGRESS → COMPLETED, CLOSED
COMPLETED  → CLOSED
CLOSED     → TODO (reopen)
```

**Terminal states:** `COMPLETED`, `CLOSED`

**Key differences from `implementation`:**

- `COMPLETED` (not `DONE`) is the success terminal state. `DONE` carries the connotation
  "PR merged"; `COMPLETED` means "objective achieved / all children done."
- No `READY` state — umbrella tasks don't have a planning-completeness gate before work starts.
- No `IN-REVIEW` state — umbrella tasks don't go through a PR review phase.
- No `BLOCKED` state — umbrellas that are blocked can just stay `IN-PROGRESS` or revert
  to `PLANNING`.
- `PLANNING → IN-PROGRESS` does NOT require going through READY first (no `session_start`
  restriction for umbrellas).

**Closeout guard (mt#2606).** A transition to `COMPLETED` is refused while any child
task is non-terminal, since `COMPLETED` means "all children done." Semantics:

- **Terminal** for the check means the child's status is a terminal state in any
  registered workflow — the union `DONE` / `CLOSED` / `COMPLETED`
  (`isTerminalTaskStatus()` in `workflows.ts`, a domain predicate deliberately
  distinct from the UI's hidden-by-default listing filter).
- On refusal the error names every incomplete child with its status, e.g.
  `Cannot complete umbrella task mt#X: 2 child task(s) not terminal
(DONE/CLOSED/COMPLETED): mt#A (IN-PROGRESS), mt#B (TODO). Complete or close the
children first (mt#2606).` A child whose record cannot be read counts as
  incomplete (`(unreadable)`).
- An umbrella with zero children completes freely.
- Enforced in `setTaskStatusFromParams` (`tasks/commands/mutation-commands.ts`,
  helper `assertUmbrellaChildrenComplete`), which the `tasks.ts` facade — the
  `@minsky/domain/tasks` barrel target used by `tasks_status_set` and
  `tasks_dispatch` — delegates to. The check requires an injected
  `taskGraphService` (the MCP/CLI registry always injects one); direct domain
  callers without it skip the guard rather than fail.
- `CLOSED` is not guarded — abandoning an umbrella with open children remains legal.

**Tool mappings:**
| State | GitHub Issues | Linear | Jira |
|-------|--------------|--------|------|
| TODO | open | Backlog | To Do |
| PLANNING | open | Planned | In Planning |
| IN-PROGRESS | open | In Progress | In Progress |
| COMPLETED | closed | Completed | Done |
| CLOSED | closed | Canceled | Canceled |

Linear's natural primitive for umbrella tasks is **Project** (not Issue), which is
reflected in `mappings.linear.type = "Project"`. Jira's natural primitive is **Epic**.

---

### `state-ops`

No-code / pure-state tasks — triage sweeps, config-only ops, decision records — that
terminate honestly without a session workspace or a PR (mt#2661).

**States:** `TODO`, `PLANNING`, `READY`, `IN-PROGRESS`, `COMPLETED`, `CLOSED`

**Transitions:**

```
TODO        → PLANNING, CLOSED
PLANNING    → READY, TODO, CLOSED
READY       → IN-PROGRESS, PLANNING, CLOSED
IN-PROGRESS → COMPLETED, PLANNING, CLOSED
COMPLETED   → CLOSED
CLOSED      → TODO (reopen)
```

**Terminal states:** `COMPLETED`, `CLOSED`

**Key differences from `implementation`:**

- `COMPLETED` (not `DONE`) is the success terminal state — same convention as `umbrella`.
- `READY → IN-PROGRESS` is a **legal direct transition** via `tasks_status_set`. The
  implementation-kind special case that reserves this transition for `session_start`
  (`status-transitions.ts`) is gated on `kind === "implementation"` and does not apply
  here — a state-ops task has no code workspace to create a session for.
- No `IN-REVIEW` state — no PR review phase (no PR is produced).
- No `BLOCKED` state — a blocked state-ops task can revert to `PLANNING` instead.

**Key difference from `umbrella`:**

- `state-ops` **keeps the `READY` planning gate** that `umbrella` skips. A state-ops
  task still goes through `/plan-task` before work starts; it just doesn't require a
  session workspace to move past `READY` into `IN-PROGRESS`.

**Tool mappings:**
| State | GitHub Issues | Linear | Jira |
|-------|--------------|--------|------|
| TODO | open | Backlog | To Do |
| PLANNING | open | Todo | In Planning |
| READY | open | Todo | Ready |
| IN-PROGRESS | open | In Progress | In Progress |
| COMPLETED | closed | Done | Done |
| CLOSED | closed | Canceled | Canceled |

---

## Workflow definition shape

The registry lives at `src/domain/tasks/workflows.ts`. Each entry has this shape:

```typescript
interface Workflow {
  states: string[]; // Complete set of valid states
  transitions: Record<string, string[]>; // Adjacency list: from → [to, ...]
  terminal: string[]; // States with no further progression
  mappings: {
    githubIssue: {
      type: "issue";
      labels: string[]; // Labels applied to GitHub issues of this kind
      stateMap: Record<string, string>; // task state → GitHub issue state
    };
    linear: {
      type: "Issue" | "Project"; // Linear entity type
      stateMap: Record<string, string>; // task state → Linear workflow state name
    };
    jira: {
      issueType: string; // Jira issue type name
      workflowName: string; // Jira workflow scheme name
      stateMap: Record<string, string>; // task state → Jira workflow state name
    };
  };
}
```

The mapping tables are the **spec for future migration** to external tools. When Minsky
eventually integrates with GitHub Issues, Linear, or Jira, these tables provide the
field-by-field mapping without additional reverse-engineering.

---

## How the gate dispatches on kind

`validateStatusTransition(from, to, kind?)` in `src/domain/tasks/status-transitions.ts`:

1. Reads `kind` from the task (defaults to `"implementation"` when unset).
2. Calls `getWorkflow(kind)` to look up the workflow (falls back to `implementation`
   for unknown kinds — backward-compat).
3. Checks `workflow.transitions[from]` for `to`. Throws `ValidationError` if not found.
4. Includes `(kind: <name>)` in the error message for non-implementation kinds.

The implementation-kind special cases (READY→IN-PROGRESS reserved for `session_start`,
PLANNING→IN-PROGRESS requires READY first) are enforced before the registry lookup and
apply only when `kind === "implementation"`.

---

## Adding a new kind

Adding a new kind requires **two changes only**:

1. **Registry entry**: add a new entry to `WORKFLOWS` in `src/domain/tasks/workflows.ts`
   with the full workflow definition (states, transitions, terminal, mappings).

2. **Type union**: add the kind string to `TaskKind` in the same file.

No schema changes, no gate refactoring, no migration script required. The `kind` column
is a free-form text field; new kind strings are immediately valid.

Example (illustrative, not in v1):

```typescript
// In workflows.ts:
export type TaskKind = "implementation" | "umbrella" | "spike";

WORKFLOWS["spike"] = {
  states: ["TODO", "IN-PROGRESS", "FINDINGS-RECORDED", "CLOSED"],
  transitions: {
    TODO: ["IN-PROGRESS", "CLOSED"],
    "IN-PROGRESS": ["FINDINGS-RECORDED", "CLOSED"],
    "FINDINGS-RECORDED": ["CLOSED"],
    CLOSED: ["TODO"],
  },
  terminal: ["FINDINGS-RECORDED", "CLOSED"],
  mappings: {
    /* ... */
  },
};
```

### Future kinds (not in v1)

These are illustrative extension patterns that use the registry without any gate changes:

| Kind    | Use case                            | Key difference                                         |
| ------- | ----------------------------------- | ------------------------------------------------------ |
| `bug`   | Bug reports with reproduction steps | `REPRODUCED`, `ROOT-CAUSE-FOUND` intermediate states   |
| `spike` | Research/investigation              | `FINDINGS-RECORDED` terminal instead of DONE/COMPLETED |
| `rfc`   | Design proposals                    | `DRAFT → REVIEW → PUBLISHED` workflow                  |
| `chore` | Maintenance tasks                   | Simplified `TODO → IN-PROGRESS → DONE`                 |
| `docs`  | Documentation tasks                 | Same as chore; different tool mapping                  |

Each is one registry entry. No schema or gate changes.

---

## Backfill heuristic

The migration script (`scripts/migrate-task-kinds.ts`) backfills `kind` on existing
tasks using this heuristic:

```
kind = "umbrella"  when:  hasChildren AND NOT hasPr
kind = "implementation"  otherwise
```

Where:

- `hasChildren` — task appears as `toTaskId` in a `parent`-type relationship
- `hasPr` — any session linked to this task has a non-null `prBranch` or `prState`

The heuristic is conservative: it prefers to leave ambiguous tasks as `"implementation"`
rather than mis-classify them.

### Promote-only semantics (mt#2761)

The script is **promote-only**: it never changes a task whose current kind is
anything other than `"implementation"`. Only `"implementation"` (the default kind,
and the kind every task had before mt#1812 shipped) is eligible for promotion to
`"umbrella"`. A task already classified as `"state-ops"` (mt#2661), a hand-set
`"umbrella"` on a leaf task (see the reclassification table below), or any other
kind is always left untouched — even when the hasChildren/hasPr heuristic above
would, taken alone, suggest a different kind for it.

This was added after a 2026-07-13 re-run of the backfill demoted 5 tasks that had
been deliberately reclassified outside the heuristic's signal:

- `mt#2625`, `mt#2645` — the mt#2661 `state-ops` back-annotations. Both have no
  children of their own and no PR, so the bare heuristic computes
  `"implementation"` for them — a demotion of a manual `state-ops` classification.
- `mt#1533`, `mt#1534`, `mt#1535` — hand-classified `umbrella` leaf tasks (the
  mt#1451 children; see the reclassification table below). These have no
  children of their own either, so the bare heuristic also computes
  `"implementation"` for them — a demotion of a manual `umbrella` classification.

Before the fix, the script only ever computed `"umbrella"` or `"implementation"`
and treated any mismatch between that computation and the task's current kind as
a change to apply — which silently demoted any non-default kind the heuristic
didn't know about. The promote-only guard closes this: a task's current kind is
only ever changed when it is presently `"implementation"`.

The classification decision is implemented as a small pure function,
`classifyTaskKind()` in `scripts/migrate-task-kinds-classify.ts` (unit-tested in
the sibling `.test.ts` file), so the promote-only logic can be verified without
a live database connection.

Dry-run output distinguishes three dispositions per task:

- `[PROMOTE]` — currently `"implementation"`, heuristic says `"umbrella"` — would
  be applied under `--execute`.
- `[SKIPPED]` — currently a non-default kind, heuristic disagrees — reported for
  visibility, never applied ("skipped (non-default kind, preserving manual
  classification)").
- `[  OK  ]` — no change needed either way (shown only with `--verbose`).

**Usage:**

```bash
# Preview (no changes made):
bun scripts/migrate-task-kinds.ts

# Apply (promotions only — never demotes a non-default kind):
bun scripts/migrate-task-kinds.ts --execute

# Preview with all tasks listed:
bun scripts/migrate-task-kinds.ts --verbose
```

---

## Reclassification of originating incidents

After the system shipped, the following tasks were reclassified as `kind: "umbrella"`:

| Task    | Title                     | Status    |
| ------- | ------------------------- | --------- |
| mt#1768 | Cockpit bundle umbrella   | COMPLETED |
| mt#1451 | Task graph reorganization | CLOSED    |
| mt#1533 | (child of mt#1451)        | CLOSED    |
| mt#1534 | (child of mt#1451)        | CLOSED    |
| mt#1535 | (child of mt#1451)        | CLOSED    |
| mt#1143 | Cockpit v0                | PLANNING  |

mt#1768's transition to COMPLETED proved the umbrella terminal-state path end-to-end.

---

## Cross-references

- `mt#1812` — this feature's tracking task
- `mt#1768` — originating incident (Cockpit bundle umbrella, CLOSED with workaround note)
- `mt#2661` — `state-ops` kind (no-code tasks cannot terminate honestly); back-annotated
  mt#2625 and mt#2645, the two originating CLOSED-as-delivered workarounds
- `mt#455` — work-content type classification (orthogonal axis)
- `packages/domain/src/tasks/workflows.ts` — the workflow registry
- `packages/domain/src/tasks/status-transitions.ts` — the gate that dispatches on kind
- `src/domain/storage/migrations/pg/0036_add_task_kind.sql` — DB migration
- `scripts/migrate-task-kinds.ts` — kind backfill script (promote-only, mt#2761)
- `scripts/migrate-task-kinds-classify.ts` — extracted, unit-tested classification function
- `scripts/smoke-task-kinds.ts` — smoke test for the system
- `mt#2761` — promote-only fix + reflect-metadata boot fix for the backfill script
- CLAUDE.md `## Task Lifecycle` — overview of the current state machine
- CLAUDE.md `## Verification surfaces` — the merge gate that atomically sets DONE
