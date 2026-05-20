# Task Kinds — Engineering Guide

Minsky tasks have a `kind` field that selects the **per-kind workflow definition**:
the state machine, allowed transitions, terminal states, and the mapping tables
that describe how to represent tasks of this kind in external tools (GitHub Issues,
Linear, Jira).

This document covers:

- What task kind is and why it exists
- The v1 kinds: `implementation` and `umbrella`
- The workflow definition shape (state machine + mapping tables)
- How to add a new kind
- Cross-references and backfill

---

## The concept

### Lifecycle axis vs. work-content axis

Task kind operates on the **lifecycle axis**: which state machine applies to this task?
It is orthogonal to the **work-content axis** (mt#455), which classifies what kind of
work a task involves (research, design, implementation, refactor, docs, test, chore).

| Field  | Axis         | Values (v1)                  | Answers                              |
| ------ | ------------ | ---------------------------- | ------------------------------------ |
| `kind` | Lifecycle    | `implementation`, `umbrella` | Which state machine applies?         |
| `type` | Work content | (mt#455)                     | What kind of work does this task do? |

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

**Usage:**

```bash
# Preview (no changes made):
bun scripts/migrate-task-kinds.ts

# Apply:
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
- `mt#455` — work-content type classification (orthogonal axis)
- `src/domain/tasks/workflows.ts` — the workflow registry
- `src/domain/tasks/status-transitions.ts` — the gate that dispatches on kind
- `src/domain/storage/migrations/pg/0036_add_task_kind.sql` — DB migration
- `scripts/migrate-task-kinds.ts` — kind backfill script
- `scripts/smoke-task-kinds.ts` — smoke test for the system
- CLAUDE.md `## Task Lifecycle` — overview of the current state machine
- CLAUDE.md `## Verification surfaces` — the merge gate that atomically sets DONE
