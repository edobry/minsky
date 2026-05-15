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
 *
 * Cross-references:
 *   - mt#1812 — originating task
 *   - mt#1768 — originating incident (Cockpit bundle umbrella)
 *   - docs/task-kinds.md — narrative documentation
 *   - CLAUDE.md §Task Lifecycle — overview of the current state machine
 */

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
 */
export type TaskKind = "implementation" | "umbrella";

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
      READY: ["PLANNING", "BLOCKED", "CLOSED"],
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
  // States: TODO → PLANNING → IN-PROGRESS → COMPLETED | CLOSED
  //
  // Key difference: terminal state is COMPLETED (not DONE).
  //   - DONE carries the connotation "PR merged" for implementation tasks.
  //   - COMPLETED means "all children completed / objective achieved" for umbrellas.
  //   - CLOSED means "abandoned / superseded" (same semantics across kinds).
  //
  // Notably absent: READY (no planning gate), IN-REVIEW (no PR review phase).
  // -------------------------------------------------------------------------
  umbrella: {
    states: ["TODO", "PLANNING", "IN-PROGRESS", "COMPLETED", "CLOSED"],
    transitions: {
      TODO: ["PLANNING", "CLOSED"],
      PLANNING: ["IN-PROGRESS", "CLOSED"],
      "IN-PROGRESS": ["COMPLETED", "CLOSED"],
      COMPLETED: ["CLOSED"],
      CLOSED: ["TODO"],
    },
    terminal: ["COMPLETED", "CLOSED"],
    mappings: {
      githubIssue: {
        type: "issue",
        labels: ["epic"],
        stateMap: {
          TODO: "open",
          PLANNING: "open",
          "IN-PROGRESS": "open",
          COMPLETED: "closed",
          CLOSED: "closed",
        },
      },
      linear: {
        type: "Project", // Linear's natural primitive for umbrellas
        stateMap: {
          TODO: "Backlog",
          PLANNING: "Planned",
          "IN-PROGRESS": "In Progress",
          COMPLETED: "Completed",
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
          COMPLETED: "Done",
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
 * Default task kind for tasks that have not been explicitly assigned a kind.
 */
export const DEFAULT_KIND: TaskKind = "implementation";
