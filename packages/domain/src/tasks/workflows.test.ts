/**
 * Tests for the task workflow registry (mt#1812).
 *
 * Verifies that the WORKFLOWS registry is internally consistent:
 *   - All transition targets exist in the states list.
 *   - Terminal states have no outgoing transitions (or an empty list).
 *   - All tool-mapping entries are present.
 *   - getWorkflow() returns the correct workflow and falls back gracefully.
 */

import { describe, test, expect } from "bun:test";
import {
  WORKFLOWS,
  getWorkflow,
  isKnownKind,
  assertKnownKind,
  DEFAULT_KIND,
  isTerminal,
  isActiveWork,
  isAwaitingReview,
  DEFAULT_HIDDEN_STATUSES,
  isHiddenByDefaultStatus,
  BIND_ADVANCE_SEAM_STATUS,
  TERMINAL_TASK_STATUS_VALUES,
  type TaskKind,
} from "./workflows";
import { ValidationError } from "../errors/index";

describe("WORKFLOWS registry — internal consistency", () => {
  const kindNames = Object.keys(WORKFLOWS) as TaskKind[];

  test("registry exports implementation, umbrella, and state-ops kinds", () => {
    expect(WORKFLOWS).toHaveProperty("implementation");
    expect(WORKFLOWS).toHaveProperty("umbrella");
    expect(WORKFLOWS).toHaveProperty("state-ops");
  });

  for (const kind of kindNames) {
    const workflow = WORKFLOWS[kind];

    describe(`kind: ${kind}`, () => {
      test("has non-empty states list", () => {
        expect(workflow.states.length).toBeGreaterThan(0);
      });

      test("has non-empty terminal list", () => {
        expect(workflow.terminal.length).toBeGreaterThan(0);
      });

      test("all terminal states are in the states list", () => {
        for (const terminalState of workflow.terminal) {
          expect(workflow.states).toContain(terminalState);
        }
      });

      test("all transition source states are in the states list", () => {
        for (const fromState of Object.keys(workflow.transitions)) {
          expect(workflow.states).toContain(fromState);
        }
      });

      test("all transition target states are in the states list", () => {
        for (const [_fromState, toStates] of Object.entries(workflow.transitions)) {
          for (const toState of toStates) {
            expect(workflow.states).toContain(toState);
          }
        }
      });

      test("has all three tool mappings (githubIssue, linear, jira)", () => {
        expect(workflow.mappings).toHaveProperty("githubIssue");
        expect(workflow.mappings).toHaveProperty("linear");
        expect(workflow.mappings).toHaveProperty("jira");
      });

      test("githubIssue mapping has type, labels, and stateMap", () => {
        expect(workflow.mappings.githubIssue).toHaveProperty("type");
        expect(workflow.mappings.githubIssue).toHaveProperty("labels");
        expect(workflow.mappings.githubIssue).toHaveProperty("stateMap");
        expect(Array.isArray(workflow.mappings.githubIssue.labels)).toBe(true);
      });

      test("linear mapping has type and stateMap", () => {
        expect(workflow.mappings.linear).toHaveProperty("type");
        expect(workflow.mappings.linear).toHaveProperty("stateMap");
      });

      test("jira mapping has issueType, workflowName, and stateMap", () => {
        expect(workflow.mappings.jira).toHaveProperty("issueType");
        expect(workflow.mappings.jira).toHaveProperty("workflowName");
        expect(workflow.mappings.jira).toHaveProperty("stateMap");
      });

      test("all states have an entry in the githubIssue stateMap", () => {
        for (const state of workflow.states) {
          expect(workflow.mappings.githubIssue.stateMap).toHaveProperty(state);
        }
      });

      test("all states have an entry in the linear stateMap", () => {
        for (const state of workflow.states) {
          expect(workflow.mappings.linear.stateMap).toHaveProperty(state);
        }
      });

      test("all states have an entry in the jira stateMap", () => {
        for (const state of workflow.states) {
          expect(workflow.mappings.jira.stateMap).toHaveProperty(state);
        }
      });
    });
  }
});

describe("implementation workflow — specific state machine properties", () => {
  const workflow = WORKFLOWS["implementation"];

  test("has the complete expected states", () => {
    const expected = [
      "TODO",
      "PLANNING",
      "READY",
      "IN-PROGRESS",
      "IN-REVIEW",
      "DONE",
      "BLOCKED",
      "CLOSED",
    ];
    for (const state of expected) {
      expect(workflow.states).toContain(state);
    }
  });

  test("terminal states are DONE and CLOSED", () => {
    expect(workflow.terminal).toContain("DONE");
    expect(workflow.terminal).toContain("CLOSED");
  });

  test("GitHub Issues maps to issue type", () => {
    expect(workflow.mappings.githubIssue.type).toBe("issue");
  });

  test("Linear maps to Issue type", () => {
    expect(workflow.mappings.linear.type).toBe("Issue");
  });

  test("Jira maps to Task issue type", () => {
    expect(workflow.mappings.jira.issueType).toBe("Task");
  });
});

describe("umbrella workflow — specific state machine properties", () => {
  const workflow = WORKFLOWS["umbrella"];

  test("has the complete expected states", () => {
    const expected = ["TODO", "PLANNING", "IN-PROGRESS", "DONE", "CLOSED"];
    for (const state of expected) {
      expect(workflow.states).toContain(state);
    }
  });

  test("does NOT have READY, IN-REVIEW, or COMPLETED states", () => {
    expect(workflow.states).not.toContain("READY");
    expect(workflow.states).not.toContain("IN-REVIEW");
    // COMPLETED removed by mt#2311 — single success terminal (DONE) across kinds.
    expect(workflow.states).not.toContain("COMPLETED");
  });

  test("terminal states are DONE and CLOSED (mt#2311)", () => {
    expect(workflow.terminal).toContain("DONE");
    expect(workflow.terminal).toContain("CLOSED");
    expect(workflow.terminal).not.toContain("COMPLETED");
  });

  test("GitHub Issues maps to issue type with epic label", () => {
    expect(workflow.mappings.githubIssue.type).toBe("issue");
    expect(workflow.mappings.githubIssue.labels).toContain("epic");
  });

  test("Linear maps to Project type (natural primitive for umbrellas)", () => {
    expect(workflow.mappings.linear.type).toBe("Project");
  });

  test("Jira maps to Epic issue type", () => {
    expect(workflow.mappings.jira.issueType).toBe("Epic");
  });
});

describe("state-ops workflow — specific state machine properties", () => {
  const workflow = WORKFLOWS["state-ops"];

  test("has the complete expected state-ops states", () => {
    const expected = ["TODO", "PLANNING", "READY", "IN-PROGRESS", "DONE", "CLOSED"];
    for (const state of expected) {
      expect(workflow.states).toContain(state);
    }
  });

  test("HAS a READY state (unlike umbrella)", () => {
    expect(workflow.states).toContain("READY");
  });

  test("does NOT have IN-REVIEW, COMPLETED, or BLOCKED states", () => {
    expect(workflow.states).not.toContain("IN-REVIEW");
    // COMPLETED removed by mt#2311 — single success terminal (DONE) across kinds.
    expect(workflow.states).not.toContain("COMPLETED");
    expect(workflow.states).not.toContain("BLOCKED");
  });

  test("terminal states are DONE and CLOSED (mt#2311)", () => {
    expect(workflow.terminal).toContain("DONE");
    expect(workflow.terminal).toContain("CLOSED");
    expect(workflow.terminal).not.toContain("COMPLETED");
  });

  test("READY → IN-PROGRESS is a legal direct transition (no session_start gate)", () => {
    expect(workflow.transitions["READY"]).toContain("IN-PROGRESS");
  });

  test("IN-PROGRESS → DONE is a legal transition", () => {
    expect(workflow.transitions["IN-PROGRESS"]).toContain("DONE");
  });

  test("GitHub Issues maps to issue type with state-ops label", () => {
    expect(workflow.mappings.githubIssue.type).toBe("issue");
    expect(workflow.mappings.githubIssue.labels).toContain("state-ops");
  });

  test("Linear maps to Issue type", () => {
    expect(workflow.mappings.linear.type).toBe("Issue");
  });

  test("Jira maps to Task issue type", () => {
    expect(workflow.mappings.jira.issueType).toBe("Task");
  });
});

describe("getWorkflow() helper", () => {
  test("returns implementation workflow for 'implementation'", () => {
    const wf = getWorkflow("implementation");
    expect(wf).toBe(WORKFLOWS["implementation"]);
  });

  test("returns umbrella workflow for 'umbrella'", () => {
    const wf = getWorkflow("umbrella");
    expect(wf).toBe(WORKFLOWS["umbrella"]);
  });

  test("returns state-ops workflow for 'state-ops'", () => {
    const wf = getWorkflow("state-ops");
    expect(wf).toBe(WORKFLOWS["state-ops"]);
  });

  test("returns implementation workflow for null (backward-compat)", () => {
    const wf = getWorkflow(null);
    expect(wf).toBe(WORKFLOWS["implementation"]);
  });

  test("returns implementation workflow for undefined (backward-compat)", () => {
    const wf = getWorkflow(undefined);
    expect(wf).toBe(WORKFLOWS["implementation"]);
  });

  test("returns implementation workflow for empty string (backward-compat)", () => {
    const wf = getWorkflow("");
    expect(wf).toBe(WORKFLOWS["implementation"]);
  });

  test("falls back to implementation for unknown kind", () => {
    const wf = getWorkflow("not-a-real-kind");
    expect(wf).toBe(WORKFLOWS["implementation"]);
  });
});

describe("isKnownKind() helper", () => {
  test("returns true for 'implementation'", () => {
    expect(isKnownKind("implementation")).toBe(true);
  });

  test("returns true for 'umbrella'", () => {
    expect(isKnownKind("umbrella")).toBe(true);
  });

  test("returns true for 'state-ops'", () => {
    expect(isKnownKind("state-ops")).toBe(true);
  });

  test("returns false for unknown kinds", () => {
    expect(isKnownKind("bug")).toBe(false);
    expect(isKnownKind("spike")).toBe(false);
    expect(isKnownKind("")).toBe(false);
  });
});

describe("DEFAULT_KIND", () => {
  test("is 'implementation'", () => {
    expect(DEFAULT_KIND).toBe("implementation");
  });
});

describe("assertKnownKind() helper (mt#2762)", () => {
  test("is a no-op for undefined (no kind filter requested)", () => {
    expect(() => assertKnownKind(undefined)).not.toThrow();
  });

  test("is a no-op for each known kind", () => {
    expect(() => assertKnownKind("implementation")).not.toThrow();
    expect(() => assertKnownKind("umbrella")).not.toThrow();
    expect(() => assertKnownKind("state-ops")).not.toThrow();
  });

  test("throws a ValidationError for an unknown kind", () => {
    expect(() => assertKnownKind("bogus")).toThrow(ValidationError);
  });

  test("ValidationError message names the unknown kind and all valid kinds", () => {
    try {
      assertKnownKind("bogus");
      throw new Error("expected assertKnownKind to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const message = (error as ValidationError).message;
      expect(message).toContain('"bogus"');
      expect(message).toContain("implementation");
      expect(message).toContain("umbrella");
      expect(message).toContain("state-ops");
    }
  });
});

// ---------------------------------------------------------------------------
// mt#3010 — semantic predicates + constants (single-authority consolidation)
// ---------------------------------------------------------------------------

describe("isTerminal() predicate", () => {
  test("is true for DONE and CLOSED", () => {
    expect(isTerminal("DONE")).toBe(true);
    expect(isTerminal("CLOSED")).toBe(true);
  });

  test("is false for every non-terminal status", () => {
    for (const status of ["TODO", "PLANNING", "READY", "IN-PROGRESS", "IN-REVIEW", "BLOCKED"]) {
      expect(isTerminal(status)).toBe(false);
    }
  });

  test("is false for undefined and empty string", () => {
    expect(isTerminal(undefined)).toBe(false);
    expect(isTerminal("")).toBe(false);
  });

  test("is false for an unknown/orphaned status (e.g. the retired COMPLETED)", () => {
    expect(isTerminal("COMPLETED")).toBe(false);
  });
});

describe("isActiveWork() predicate", () => {
  test("is true only for IN-PROGRESS", () => {
    expect(isActiveWork("IN-PROGRESS")).toBe(true);
  });

  test("is false for every other status, including the adjacent IN-REVIEW", () => {
    for (const status of ["TODO", "PLANNING", "READY", "IN-REVIEW", "DONE", "BLOCKED", "CLOSED"]) {
      expect(isActiveWork(status)).toBe(false);
    }
  });
});

describe("isAwaitingReview() predicate", () => {
  test("is true only for IN-REVIEW", () => {
    expect(isAwaitingReview("IN-REVIEW")).toBe(true);
  });

  test("is false for every other status, including the adjacent IN-PROGRESS", () => {
    for (const status of [
      "TODO",
      "PLANNING",
      "READY",
      "IN-PROGRESS",
      "DONE",
      "BLOCKED",
      "CLOSED",
    ]) {
      expect(isAwaitingReview(status)).toBe(false);
    }
  });
});

describe("DEFAULT_HIDDEN_STATUSES / isHiddenByDefaultStatus", () => {
  test("DEFAULT_HIDDEN_STATUSES is exactly {DONE, CLOSED}", () => {
    expect([...DEFAULT_HIDDEN_STATUSES].sort()).toEqual(["CLOSED", "DONE"]);
  });

  test("isHiddenByDefaultStatus matches DEFAULT_HIDDEN_STATUSES membership", () => {
    for (const status of DEFAULT_HIDDEN_STATUSES) {
      expect(isHiddenByDefaultStatus(status)).toBe(true);
    }
    for (const status of ["TODO", "PLANNING", "READY", "IN-PROGRESS", "IN-REVIEW", "BLOCKED"]) {
      expect(isHiddenByDefaultStatus(status)).toBe(false);
    }
  });

  test("isHiddenByDefaultStatus is false for undefined", () => {
    expect(isHiddenByDefaultStatus(undefined)).toBe(false);
  });
});

describe("BIND_ADVANCE_SEAM_STATUS", () => {
  test("is READY", () => {
    expect(BIND_ADVANCE_SEAM_STATUS).toBe("READY");
  });

  test("is a member of the implementation workflow's states", () => {
    expect(WORKFLOWS.implementation.states).toContain(BIND_ADVANCE_SEAM_STATUS);
  });
});

describe("TERMINAL_TASK_STATUS_VALUES", () => {
  test("is exactly {DONE, CLOSED}, matching isTerminal's semantics", () => {
    expect([...TERMINAL_TASK_STATUS_VALUES].sort()).toEqual(["CLOSED", "DONE"]);
  });

  test("every value in the tuple is terminal per isTerminal()", () => {
    for (const status of TERMINAL_TASK_STATUS_VALUES) {
      expect(isTerminal(status)).toBe(true);
    }
  });

  test("has no duplicate values across the registry's per-kind terminal arrays", () => {
    expect(TERMINAL_TASK_STATUS_VALUES.length).toBe(new Set(TERMINAL_TASK_STATUS_VALUES).size);
  });
});

describe("Workflow.restrictedTransitions (mt#3010 — data-driven session_start special cases)", () => {
  test("implementation workflow reserves READY -> IN-PROGRESS for session_start", () => {
    const restricted = WORKFLOWS.implementation.restrictedTransitions ?? [];
    const entry = restricted.find((r) => r.from === "READY" && r.to === "IN-PROGRESS");
    expect(entry).toBeDefined();
    expect(entry?.message).toContain("session_start");
  });

  test("implementation workflow gives a READY-first hint for PLANNING -> IN-PROGRESS", () => {
    const restricted = WORKFLOWS.implementation.restrictedTransitions ?? [];
    const entry = restricted.find((r) => r.from === "PLANNING" && r.to === "IN-PROGRESS");
    expect(entry).toBeDefined();
    expect(entry?.message).toContain("READY");
  });

  test("umbrella and state-ops workflows declare no restrictedTransitions", () => {
    expect(WORKFLOWS.umbrella.restrictedTransitions).toBeUndefined();
    expect(WORKFLOWS["state-ops"].restrictedTransitions).toBeUndefined();
  });
});
