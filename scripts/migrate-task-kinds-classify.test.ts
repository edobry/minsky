import { describe, expect, it } from "bun:test";
import { classifyTaskKind } from "./migrate-task-kinds-classify";

const SKIP_NON_DEFAULT_KIND = "skip-non-default-kind";

describe("classifyTaskKind", () => {
  describe("implementation kind (eligible for promotion)", () => {
    it("promotes to umbrella when hasChildren and no PR", () => {
      const result = classifyTaskKind({
        taskId: "mt#100",
        currentKind: "implementation",
        hasChildren: true,
        hasPr: false,
      });
      expect(result.action).toBe("promote");
      expect(result.changed).toBe(true);
      expect(result.proposedKind).toBe("umbrella");
    });

    it("treats a null currentKind as implementation and promotes when eligible", () => {
      const result = classifyTaskKind({
        taskId: "mt#101",
        currentKind: null,
        hasChildren: true,
        hasPr: false,
      });
      expect(result.currentKind).toBe("implementation");
      expect(result.action).toBe("promote");
      expect(result.proposedKind).toBe("umbrella");
    });

    it("treats an undefined currentKind as implementation and promotes when eligible", () => {
      const result = classifyTaskKind({
        taskId: "mt#102",
        currentKind: undefined,
        hasChildren: true,
        hasPr: false,
      });
      expect(result.currentKind).toBe("implementation");
      expect(result.action).toBe("promote");
    });

    it("stays implementation when hasChildren but has a PR", () => {
      const result = classifyTaskKind({
        taskId: "mt#103",
        currentKind: "implementation",
        hasChildren: true,
        hasPr: true,
      });
      expect(result.action).toBe("no-change");
      expect(result.changed).toBe(false);
      expect(result.proposedKind).toBe("implementation");
    });

    it("stays implementation when no children", () => {
      const result = classifyTaskKind({
        taskId: "mt#104",
        currentKind: "implementation",
        hasChildren: false,
        hasPr: false,
      });
      expect(result.action).toBe("no-change");
      expect(result.changed).toBe(false);
    });
  });

  describe("non-default kind (promote-only guard, mt#2761)", () => {
    it("never demotes state-ops even when heuristic suggests implementation (mt#2625/mt#2645 regression)", () => {
      // A state-ops task with no children and no PR: the bare heuristic
      // would compute "implementation", which is exactly the demotion bug
      // observed for mt#2625/mt#2645.
      const result = classifyTaskKind({
        taskId: "mt#2625",
        currentKind: "state-ops",
        hasChildren: false,
        hasPr: false,
      });
      expect(result.action).toBe(SKIP_NON_DEFAULT_KIND);
      expect(result.changed).toBe(false);
      expect(result.proposedKind).toBe("state-ops");
      expect(result.heuristicKind).toBe("implementation");
    });

    it("never demotes state-ops even when heuristic suggests umbrella", () => {
      const result = classifyTaskKind({
        taskId: "mt#2645",
        currentKind: "state-ops",
        hasChildren: true,
        hasPr: false,
      });
      expect(result.action).toBe(SKIP_NON_DEFAULT_KIND);
      expect(result.changed).toBe(false);
      expect(result.proposedKind).toBe("state-ops");
      expect(result.heuristicKind).toBe("umbrella");
    });

    it("never demotes a hand-classified umbrella leaf task with no children (mt#1533-1535 regression)", () => {
      // Hand-classified umbrella leaf tasks (mt#1451 children) have no
      // children of their own and no PR, so the bare heuristic computes
      // "implementation" — exactly the demotion bug observed for
      // mt#1533/mt#1534/mt#1535.
      const result = classifyTaskKind({
        taskId: "mt#1533",
        currentKind: "umbrella",
        hasChildren: false,
        hasPr: false,
      });
      expect(result.action).toBe(SKIP_NON_DEFAULT_KIND);
      expect(result.changed).toBe(false);
      expect(result.proposedKind).toBe("umbrella");
      expect(result.heuristicKind).toBe("implementation");
    });

    it("reports no-change (not skip) when a non-default kind already agrees with the heuristic", () => {
      const result = classifyTaskKind({
        taskId: "mt#200",
        currentKind: "umbrella",
        hasChildren: true,
        hasPr: false,
      });
      expect(result.action).toBe("no-change");
      expect(result.changed).toBe(false);
      expect(result.proposedKind).toBe("umbrella");
    });

    it("never touches an arbitrary future kind not covered by the heuristic at all", () => {
      const result = classifyTaskKind({
        taskId: "mt#300",
        currentKind: "spike",
        hasChildren: true,
        hasPr: false,
      });
      expect(result.action).toBe(SKIP_NON_DEFAULT_KIND);
      expect(result.changed).toBe(false);
      expect(result.proposedKind).toBe("spike");
    });
  });

  describe("changed flag correctness", () => {
    it("changed is true only for action === promote", () => {
      const promote = classifyTaskKind({
        taskId: "mt#1",
        currentKind: "implementation",
        hasChildren: true,
        hasPr: false,
      });
      const skip = classifyTaskKind({
        taskId: "mt#2",
        currentKind: "state-ops",
        hasChildren: false,
        hasPr: false,
      });
      const noChange = classifyTaskKind({
        taskId: "mt#3",
        currentKind: "implementation",
        hasChildren: false,
        hasPr: false,
      });
      expect(promote.changed).toBe(true);
      expect(skip.changed).toBe(false);
      expect(noChange.changed).toBe(false);
    });
  });
});
