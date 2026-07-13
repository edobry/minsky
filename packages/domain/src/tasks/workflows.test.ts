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
import { WORKFLOWS, getWorkflow, isKnownKind, DEFAULT_KIND, type TaskKind } from "./workflows";

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
    const expected = ["TODO", "PLANNING", "IN-PROGRESS", "COMPLETED", "CLOSED"];
    for (const state of expected) {
      expect(workflow.states).toContain(state);
    }
  });

  test("does NOT have READY, IN-REVIEW, or DONE states", () => {
    expect(workflow.states).not.toContain("READY");
    expect(workflow.states).not.toContain("IN-REVIEW");
    expect(workflow.states).not.toContain("DONE");
  });

  test("terminal states are COMPLETED and CLOSED", () => {
    expect(workflow.terminal).toContain("COMPLETED");
    expect(workflow.terminal).toContain("CLOSED");
  });

  test("COMPLETED (not DONE) is the success terminal state", () => {
    expect(workflow.terminal).toContain("COMPLETED");
    expect(workflow.terminal).not.toContain("DONE");
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
    const expected = ["TODO", "PLANNING", "READY", "IN-PROGRESS", "COMPLETED", "CLOSED"];
    for (const state of expected) {
      expect(workflow.states).toContain(state);
    }
  });

  test("HAS a READY state (unlike umbrella)", () => {
    expect(workflow.states).toContain("READY");
  });

  test("does NOT have IN-REVIEW, DONE, or BLOCKED states", () => {
    expect(workflow.states).not.toContain("IN-REVIEW");
    expect(workflow.states).not.toContain("DONE");
    expect(workflow.states).not.toContain("BLOCKED");
  });

  test("terminal states are COMPLETED and CLOSED", () => {
    expect(workflow.terminal).toContain("COMPLETED");
    expect(workflow.terminal).toContain("CLOSED");
  });

  test("COMPLETED (not DONE) is the success terminal state", () => {
    expect(workflow.terminal).toContain("COMPLETED");
    expect(workflow.terminal).not.toContain("DONE");
  });

  test("READY → IN-PROGRESS is a legal direct transition (no session_start gate)", () => {
    expect(workflow.transitions["READY"]).toContain("IN-PROGRESS");
  });

  test("IN-PROGRESS → COMPLETED is a legal transition", () => {
    expect(workflow.transitions["IN-PROGRESS"]).toContain("COMPLETED");
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
