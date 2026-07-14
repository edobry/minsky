/**
 * Task Workflow Registry — mt#1812
 *
 * Defines the per-kind workflow definitions (state machines, allowed transitions,
 * terminal states) and the tool-mapping tables for GitHub Issues, Linear, and Jira.
 *
 * Every task has a `kind` field that selects the workflow definition used to
 * validate status transitions. Adding a new kind requires only:
 *   1. A new entry in the WORKFLOWS registry below.
 *   2. No schema changes, no gate refactoring.
 *
 * v1 kinds:
 *   - "implementation" — the existing state machine, encoded as data.
 *   - "umbrella" — simpler lifecycle for epic/metadata tasks that complete without a PR.
 *   - "state-ops" — no-code / pure-state tasks (triage sweeps, config-only ops, decision
 *     records) that terminate at DONE without a session or a PR (mt#2661; single
 *     success terminal across kinds since mt#2311).
 *
 * Cross-references:
 *   - mt#1812 — originating task
 *   - mt#1768 — originating incident (Cockpit bundle umbrella)
 *   - mt#2661 — "state-ops" kind (no-code tasks cannot terminate honestly)
 *   - docs/task-kinds.md — narrative documentation
 *   - CLAUDE.md §Task Lifecycle — overview of the current state machine
 */

import { ValidationError } from "../errors/index";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Mapping from a task state to the corresponding representation in an external
 * issue-tracking tool. Used to derive the correct state when migrating to
 * GitHub Issues, Linear, or Jira.
 */
export interface ToolStateMap {
  [taskState: string]: string;
}

/**
 * GitHub Issues mapping for a workflow kind.
 */
export interface GithubIssueMapping {
  /** GitHub issue type primitive ("issue") */
  type: "issue";
  /** Labels applied to issues of this kind (e.g. "epic", "task") */
  labels: string[];
  /** Maps task state → GitHub issue state ("open" | "closed") or label annotation */
  stateMap: ToolStateMap;
}

/**
 * Linear mapping for a workflow kind.
 */
export interface LinearMapping {
  /** Linear entity type ("Issue" | "Project") */
  type: "Issue" | "Project";
  /** Maps task state → Linear workflow state name */
  stateMap: ToolStateMap;
}

/**
 * Jira mapping for a workflow kind.
 */
export interface JiraMapping {
  /** Jira issue type name (e.g. "Task", "Epic") */
  issueType: string;
  /** Jira workflow scheme name (informational; schemes are configured in Jira) */
  workflowName: string;
  /** Maps task state → Jira workflow state name */
  stateMap: ToolStateMap;
}

/**
 * Tool mapping tables for a workflow kind.
 * Each entry is the spec for how to represent tasks of this kind
 * in the corresponding external tool when migrating.
 */
export interface WorkflowMappings {
  githubIssue: GithubIssueMapping;
  linear: LinearMapping;
  jira: JiraMapping;
}

/**
 * Per-kind workflow definition.
 *
 * A workflow defines:
 *   - The complete set of states a task of this kind can occupy.
 *   - The valid transitions between states (adjacency list).
 *   - Which states are terminal (no further transitions expected).
 *   - How states map to external tool primitives for future migration.
 */
export interface Workflow {
  /** All valid states for tasks of this kind */
  states: string[];
  /**
   * Allowed transitions, keyed by current state.
   * Terminal states that permit no further transitions MAY be omitted from
   * this map (an empty or missing entry ⟹ no outgoing transitions).
   */
  transitions: Record<string, string[]>;
  /** States from which no further workflow progression is expected */
  terminal: string[];
  /** External tool mapping tables */
  mappings: WorkflowMappings;
}

/**
 * The v1 task kinds.
 *
 * "implementation" — covers all tasks that ship via a PR (the existing state machine).
 * "umbrella"       — covers epic / tracking tasks with no associated PR.
 * "state-ops"      — covers no-code / pure-state tasks (triage sweeps, config-only ops,
 *                    decision records) that terminate at DONE without a session
 *                    or a PR (mt#2661).
 */
export type TaskKind = "implementation" | "umbrella" | "state-ops";

// ---------------------------------------------------------------------------
// Workflow Registry
// ---------------------------------------------------------------------------

/**
 * Registry of per-kind workflow definitions, keyed by kind string.
 *
 * The state-transition gate (status-transitions.ts) dispatches on `task.kind`
 * to select the appropriate workflow and validates transitions against it.
 *
 * To add a new kind:
 *   1. Add an entry to WORKFLOWS below.
 *   2. Add the kind string to the TaskKind union type above.
 *   3. No schema changes or gate refactoring required.
 */
export const WORKFLOWS: Record<TaskKind, Workflow> = {
  // -------------------------------------------------------------------------
  // "implementation" — the existing state machine, encoded as data.
  //
  // States: TODO → PLANNING → READY → IN-PROGRESS → IN-REVIEW → DONE
  //         BLOCKED, CLOSED (from/to various states)
  //
  // Note on READY → IN-PROGRESS and PLANNING → IN-PROGRESS:
  //   These transitions are intentionally absent from this map because they
  //   can only occur via `session_start`, not via direct `tasks_status_set`.
  //   The gate enforces this as a special case before consulting the workflow.
  // -------------------------------------------------------------------------
  implementation: {
    states: ["TODO", "PLANNING", "READY", "IN-PROGRESS", "IN-REVIEW", "DONE", "BLOCKED", "CLOSED"],
    transitions: {
      TODO: ["PLANNING", "CLOSED"],
      PLANNING: ["READY", "TODO", "BLOCKED", "CLOSED"],
      // DONE is allowed here for external-deliverable tasks that close without a PR.
      // The spec-content gate (hasCloseoutEvidence) is enforced in
      // setTaskStatusFromParams before validateStatusTransition is called.
      // See .minsky/rules/task-lifecycle-external-deliverable.mdc (or the compiled CLAUDE.md section) for the convention.
      READY: ["PLANNING", "BLOCKED", "CLOSED", "DONE"],
      "IN-PROGRESS": ["IN-REVIEW", "BLOCKED", "PLANNING", "CLOSED"],
      "IN-REVIEW": ["IN-PROGRESS", "DONE", "BLOCKED", "CLOSED"],
      DONE: ["CLOSED"],
      BLOCKED: ["TODO", "PLANNING", "READY", "CLOSED"],
      CLOSED: ["TODO"],
    },
    terminal: ["DONE", "CLOSED"],
    mappings: {
      githubIssue: {
        type: "issue",
        labels: ["task"],
        stateMap: {
          TODO: "open",
          PLANNING: "open",
          READY: "open",
          "IN-PROGRESS": "open",
          "IN-REVIEW": "open",
          DONE: "closed",
          BLOCKED: "open", // open with "blocked" label
          CLOSED: "closed",
        },
      },
      linear: {
        type: "Issue",
        stateMap: {
          TODO: "Backlog",
          PLANNING: "Todo",
          READY: "Todo",
          "IN-PROGRESS": "In Progress",
          "IN-REVIEW": "In Review",
          DONE: "Done",
          BLOCKED: "Backlog", // Backlog with "Blocked" label
          CLOSED: "Canceled",
        },
      },
      jira: {
        issueType: "Task",
        workflowName: "Implementation Workflow",
        stateMap: {
          TODO: "To Do",
          PLANNING: "In Planning",
          READY: "Ready",
          "IN-PROGRESS": "In Progress",
          "IN-REVIEW": "In Review",
          DONE: "Done",
          BLOCKED: "Blocked",
          CLOSED: "Canceled",
        },
      },
    },
  },

  // -------------------------------------------------------------------------
  // "umbrella" — simpler lifecycle for epic / metadata tasks with no PR.
  //
  // States: TODO → PLANNING → IN-PROGRESS → DONE | CLOSED
  //
  // Single success terminal DONE across all kinds (mt#2311, principal decision
  // 2026-06-05; supersedes mt#1812's per-kind COMPLETED terminal). What
  // distinguishes an umbrella completion is not the terminal's NAME but its
  // path: umbrella IN-PROGRESS → DONE is a legal operator-set transition
  // (guarded by the children-completeness check in mutation-commands.ts),
  // while implementation DONE remains merge-gated.
  //   - CLOSED means "abandoned / superseded" (same semantics across kinds).
  //
  // Notably absent: READY (no planning gate), IN-REVIEW (no PR review phase).
  // -------------------------------------------------------------------------
  umbrella: {
    states: ["TODO", "PLANNING", "IN-PROGRESS", "DONE", "CLOSED"],
    transitions: {
      TODO: ["PLANNING", "CLOSED"],
      PLANNING: ["IN-PROGRESS", "CLOSED"],
      "IN-PROGRESS": ["DONE", "CLOSED"],
      DONE: ["CLOSED"],
      CLOSED: ["TODO"],
    },
    terminal: ["DONE", "CLOSED"],
    mappings: {
      githubIssue: {
        type: "issue",
        labels: ["epic"],
        stateMap: {
          TODO: "open",
          PLANNING: "open",
          "IN-PROGRESS": "open",
          DONE: "closed",
          CLOSED: "closed",
        },
      },
      linear: {
        type: "Project", // Linear's natural primitive for umbrellas
        stateMap: {
          TODO: "Backlog",
          PLANNING: "Planned",
          "IN-PROGRESS": "In Progress",
          DONE: "Completed",
          CLOSED: "Canceled",
        },
      },
      jira: {
        issueType: "Epic",
        workflowName: "Epic Workflow",
        stateMap: {
          TODO: "To Do",
          PLANNING: "In Planning",
          "IN-PROGRESS": "In Progress",
          DONE: "Done",
          CLOSED: "Canceled",
        },
      },
    },
  },

  // -------------------------------------------------------------------------
  // "state-ops" — no-code / pure-state tasks (triage sweeps, config-only ops,
  // decision records) that terminate without a session or a PR (mt#2661).
  //
  // States: TODO → PLANNING → READY → IN-PROGRESS → DONE | CLOSED
  //
  // Key difference from "implementation": READY → IN-PROGRESS is a LEGAL direct
  // transition here (not reserved for session_start). The implementation-kind
  // special cases in status-transitions.ts (READY→IN-PROGRESS via session_start
  // only; PLANNING→IN-PROGRESS must go through READY) are gated on
  // `kind === "implementation"` and do NOT apply to state-ops — see mt#2661.
  //
  // Key difference from "umbrella": state-ops KEEPS the READY planning gate
  // (umbrella skips it) because state-ops tasks still go through /plan-task
  // before work starts; it just doesn't require a session workspace to move
  // past READY. Success terminal is DONE (mt#2311, single terminal across
  // kinds): "objective achieved without a PR-merge event" — reached via a
  // legal direct IN-PROGRESS → DONE operator transition.
  // -------------------------------------------------------------------------
  "state-ops": {
    states: ["TODO", "PLANNING", "READY", "IN-PROGRESS", "DONE", "CLOSED"],
    transitions: {
      TODO: ["PLANNING", "CLOSED"],
      PLANNING: ["READY", "TODO", "CLOSED"],
      READY: ["IN-PROGRESS", "PLANNING", "CLOSED"],
      "IN-PROGRESS": ["DONE", "PLANNING", "CLOSED"],
      DONE: ["CLOSED"],
      CLOSED: ["TODO"],
    },
    terminal: ["DONE", "CLOSED"],
    mappings: {
      githubIssue: {
        type: "issue",
        labels: ["state-ops"],
        stateMap: {
          TODO: "open",
          PLANNING: "open",
          READY: "open",
          "IN-PROGRESS": "open",
          DONE: "closed",
          CLOSED: "closed",
        },
      },
      linear: {
        type: "Issue",
        stateMap: {
          TODO: "Backlog",
          PLANNING: "Todo",
          READY: "Todo",
          "IN-PROGRESS": "In Progress",
          DONE: "Done",
          CLOSED: "Canceled",
        },
      },
      jira: {
        issueType: "Task",
        workflowName: "State-Ops Workflow",
        stateMap: {
          TODO: "To Do",
          PLANNING: "In Planning",
          READY: "Ready",
          "IN-PROGRESS": "In Progress",
          DONE: "Done",
          CLOSED: "Canceled",
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up the workflow for a given kind. Returns the "implementation" workflow
 * as the default when kind is unset or unknown — this preserves backward
 * compatibility with tasks created before the kind field was introduced.
 */
export function getWorkflow(kind: string | undefined | null): Workflow {
  const resolvedKind = (kind || "implementation") as TaskKind;
  return WORKFLOWS[resolvedKind] ?? WORKFLOWS["implementation"];
}

/**
 * Return true when `kind` names a valid v1 workflow kind.
 */
export function isKnownKind(kind: string): kind is TaskKind {
  return kind in WORKFLOWS;
}

/**
 * Validate an optional `kind` filter/edit value against the workflow registry.
 * Throws a `ValidationError` naming the valid kinds when `kind` is set but unknown.
 * A no-op when `kind` is undefined (the caller did not request kind filtering/editing).
 *
 * Shared by the kind-filter read paths (tasks_list / tasks_search / tasks_available,
 * mt#2762) and mirrors the inline check `tasks edit --kind` already performs
 * (edit-commands.ts), giving both a single source of truth for the error message.
 */
export function assertKnownKind(kind: string | undefined): void {
  if (kind === undefined) return;
  if (!isKnownKind(kind)) {
    const known = Object.keys(WORKFLOWS).join(", ");
    throw new ValidationError(`Unknown task kind: "${kind}". Valid kinds: ${known}.`);
  }
}

/**
 * Default task kind for tasks that have not been explicitly assigned a kind.
 */
export const DEFAULT_KIND: TaskKind = "implementation";

/**
 * True when `status` is a terminal state in ANY registered workflow
 * (currently the union {DONE, CLOSED} — single success terminal since
 * mt#2311). This is the domain-level "no further work expected" predicate —
 * e.g. the parent-DONE closeout guard (mt#1649) uses it to decide whether a
 * child task counts as complete. Distinct from the UI's hidden-by-default
 * listing filter, which may drift for display reasons without changing
 * closeout semantics.
 */
export function isTerminalTaskStatus(status: string | undefined): boolean {
  if (!status) return false;
  return Object.values(WORKFLOWS).some((workflow) => workflow.terminal.includes(status));
}
