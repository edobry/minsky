import { describe, test, expect } from "bun:test";
import { TaskStatus } from "./taskConstants";
import { validateStatusTransition, VALID_TRANSITIONS } from "./status-transitions";

describe("status-transitions", () => {
  describe("VALID_TRANSITIONS map (implementation kind backward-compat)", () => {
    test("every TaskStatus has a transitions entry", () => {
      for (const status of Object.values(TaskStatus)) {
        expect(VALID_TRANSITIONS).toHaveProperty(status);
      }
    });

    test("CLOSED is reachable from every non-CLOSED status", () => {
      for (const status of Object.values(TaskStatus)) {
        if (status === TaskStatus.CLOSED) continue;
        expect(VALID_TRANSITIONS[status]).toContain(TaskStatus.CLOSED);
      }
    });
  });

  describe("validateStatusTransition — implementation kind (default)", () => {
    // Valid transitions
    test("TODO → PLANNING is valid", () => {
      expect(() => validateStatusTransition(TaskStatus.TODO, TaskStatus.PLANNING)).not.toThrow();
    });

    test("TODO → CLOSED is valid", () => {
      expect(() => validateStatusTransition(TaskStatus.TODO, TaskStatus.CLOSED)).not.toThrow();
    });

    test("PLANNING → TODO is valid (put back)", () => {
      expect(() => validateStatusTransition(TaskStatus.PLANNING, TaskStatus.TODO)).not.toThrow();
    });

    test("PLANNING → BLOCKED is valid", () => {
      expect(() => validateStatusTransition(TaskStatus.PLANNING, TaskStatus.BLOCKED)).not.toThrow();
    });

    test("PLANNING → READY is valid", () => {
      expect(() => validateStatusTransition(TaskStatus.PLANNING, TaskStatus.READY)).not.toThrow();
    });

    test("PLANNING → CLOSED is valid", () => {
      expect(() => validateStatusTransition(TaskStatus.PLANNING, TaskStatus.CLOSED)).not.toThrow();
    });

    test("READY → PLANNING is valid (go back for more investigation)", () => {
      expect(() => validateStatusTransition(TaskStatus.READY, TaskStatus.PLANNING)).not.toThrow();
    });

    test("READY → BLOCKED is valid", () => {
      expect(() => validateStatusTransition(TaskStatus.READY, TaskStatus.BLOCKED)).not.toThrow();
    });

    test("READY → CLOSED is valid", () => {
      expect(() => validateStatusTransition(TaskStatus.READY, TaskStatus.CLOSED)).not.toThrow();
    });

    test("IN_PROGRESS → IN_REVIEW is valid", () => {
      expect(() =>
        validateStatusTransition(TaskStatus.IN_PROGRESS, TaskStatus.IN_REVIEW)
      ).not.toThrow();
    });

    test("IN_PROGRESS → BLOCKED is valid", () => {
      expect(() =>
        validateStatusTransition(TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED)
      ).not.toThrow();
    });

    test("IN_PROGRESS → PLANNING is valid (go back for more investigation)", () => {
      expect(() =>
        validateStatusTransition(TaskStatus.IN_PROGRESS, TaskStatus.PLANNING)
      ).not.toThrow();
    });

    test("IN_REVIEW → DONE is valid", () => {
      expect(() => validateStatusTransition(TaskStatus.IN_REVIEW, TaskStatus.DONE)).not.toThrow();
    });

    test("IN_REVIEW → IN_PROGRESS is valid (review found issues)", () => {
      expect(() =>
        validateStatusTransition(TaskStatus.IN_REVIEW, TaskStatus.IN_PROGRESS)
      ).not.toThrow();
    });

    test("BLOCKED → PLANNING is valid", () => {
      expect(() => validateStatusTransition(TaskStatus.BLOCKED, TaskStatus.PLANNING)).not.toThrow();
    });

    test("BLOCKED → READY is valid", () => {
      expect(() => validateStatusTransition(TaskStatus.BLOCKED, TaskStatus.READY)).not.toThrow();
    });

    test("BLOCKED → TODO is valid", () => {
      expect(() => validateStatusTransition(TaskStatus.BLOCKED, TaskStatus.TODO)).not.toThrow();
    });

    test("CLOSED → TODO is valid (reopen)", () => {
      expect(() => validateStatusTransition(TaskStatus.CLOSED, TaskStatus.TODO)).not.toThrow();
    });

    // Invalid transitions
    test("TODO → IN-PROGRESS is invalid (must go through PLANNING)", () => {
      expect(() => validateStatusTransition(TaskStatus.TODO, TaskStatus.IN_PROGRESS)).toThrow(
        /Cannot transition from TODO to IN-PROGRESS/
      );
    });

    test("TODO → DONE is invalid", () => {
      expect(() => validateStatusTransition(TaskStatus.TODO, TaskStatus.DONE)).toThrow(
        /Cannot transition from TODO to DONE/
      );
    });

    test("TODO → IN-REVIEW is invalid", () => {
      expect(() => validateStatusTransition(TaskStatus.TODO, TaskStatus.IN_REVIEW)).toThrow(
        /Cannot transition from TODO to IN-REVIEW/
      );
    });

    test("TODO → BLOCKED is invalid", () => {
      expect(() => validateStatusTransition(TaskStatus.TODO, TaskStatus.BLOCKED)).toThrow(
        /Cannot transition from TODO to BLOCKED/
      );
    });

    // Special case: READY → IN-PROGRESS reserved for session_start
    test("READY → IN-PROGRESS via direct status set is rejected with session_start guidance", () => {
      expect(() => validateStatusTransition(TaskStatus.READY, TaskStatus.IN_PROGRESS)).toThrow(
        /Use session_start to transition from READY to IN-PROGRESS/
      );
    });

    // Special case: PLANNING → IN-PROGRESS must go through READY
    test("PLANNING → IN-PROGRESS via direct status set is rejected", () => {
      expect(() => validateStatusTransition(TaskStatus.PLANNING, TaskStatus.IN_PROGRESS)).toThrow(
        /Cannot transition directly from PLANNING to IN-PROGRESS.*Set status to READY first/
      );
    });

    // Error messages include valid transitions
    test("error message lists valid transitions", () => {
      try {
        validateStatusTransition(TaskStatus.TODO, TaskStatus.DONE);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("PLANNING");
        expect(message).toContain("CLOSED");
      }
    });

    // Explicit "implementation" kind behaves identically to default
    test("explicit kind=implementation uses same transitions as default", () => {
      expect(() =>
        validateStatusTransition(TaskStatus.TODO, TaskStatus.PLANNING, "implementation")
      ).not.toThrow();
      expect(() =>
        validateStatusTransition(TaskStatus.TODO, TaskStatus.DONE, "implementation")
      ).toThrow(/Cannot transition from TODO to DONE/);
    });
  });

  describe("validateStatusTransition — umbrella kind", () => {
    test("TODO → PLANNING is valid for umbrella", () => {
      expect(() => validateStatusTransition("TODO", "PLANNING", "umbrella")).not.toThrow();
    });

    test("TODO → CLOSED is valid for umbrella", () => {
      expect(() => validateStatusTransition("TODO", "CLOSED", "umbrella")).not.toThrow();
    });

    test("PLANNING → IN-PROGRESS is valid for umbrella (no READY gate)", () => {
      expect(() => validateStatusTransition("PLANNING", "IN-PROGRESS", "umbrella")).not.toThrow();
    });

    test("IN-PROGRESS → COMPLETED is valid for umbrella", () => {
      expect(() => validateStatusTransition("IN-PROGRESS", "COMPLETED", "umbrella")).not.toThrow();
    });

    test("COMPLETED → CLOSED is valid for umbrella", () => {
      expect(() => validateStatusTransition("COMPLETED", "CLOSED", "umbrella")).not.toThrow();
    });

    test("CLOSED → TODO is valid for umbrella (reopen)", () => {
      expect(() => validateStatusTransition("CLOSED", "TODO", "umbrella")).not.toThrow();
    });

    // Umbrella does not have DONE state
    test("IN-PROGRESS → DONE is invalid for umbrella (use COMPLETED)", () => {
      expect(() => validateStatusTransition("IN-PROGRESS", "DONE", "umbrella")).toThrow(
        /Cannot transition from IN-PROGRESS to DONE/
      );
    });

    // Umbrella does not have IN-REVIEW state
    test("IN-PROGRESS → IN-REVIEW is invalid for umbrella (no review phase)", () => {
      expect(() => validateStatusTransition("IN-PROGRESS", "IN-REVIEW", "umbrella")).toThrow(
        /Cannot transition from IN-PROGRESS to IN-REVIEW/
      );
    });

    // Umbrella does not have READY state in transitions
    test("TODO → READY is invalid for umbrella (no planning gate)", () => {
      expect(() => validateStatusTransition("TODO", "READY", "umbrella")).toThrow(
        /Cannot transition from TODO to READY/
      );
    });

    // Error messages include kind label for non-implementation kinds
    test("error message includes kind label for umbrella transitions", () => {
      try {
        validateStatusTransition("IN-PROGRESS", "DONE", "umbrella");
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("kind: umbrella");
      }
    });

    // PLANNING → IN-PROGRESS special case does NOT apply to umbrella
    test("PLANNING → IN-PROGRESS via status_set is allowed for umbrella (no session_start restriction)", () => {
      expect(() => validateStatusTransition("PLANNING", "IN-PROGRESS", "umbrella")).not.toThrow();
    });

    // READY → IN-PROGRESS special case does NOT apply to umbrella
    test("READY → IN-PROGRESS restriction is implementation-kind-only", () => {
      // "READY" is not in the umbrella workflow states, so this is an invalid
      // transition for a different reason (no READY state in umbrella workflow)
      expect(() => validateStatusTransition("READY", "IN-PROGRESS", "umbrella")).toThrow();
      // But the error should NOT mention "session_start"
      try {
        validateStatusTransition("READY", "IN-PROGRESS", "umbrella");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).not.toContain("session_start");
      }
    });
  });

  describe("validateStatusTransition — unknown kind falls back to implementation", () => {
    test("unknown kind uses implementation workflow", () => {
      // TODO → PLANNING valid in implementation → should work
      expect(() => validateStatusTransition("TODO", "PLANNING", "some-unknown-kind")).not.toThrow();
    });

    test("null kind uses implementation workflow", () => {
      expect(() =>
        validateStatusTransition(TaskStatus.TODO, TaskStatus.PLANNING, null)
      ).not.toThrow();
    });

    test("undefined kind uses implementation workflow", () => {
      expect(() =>
        validateStatusTransition(TaskStatus.TODO, TaskStatus.PLANNING, undefined)
      ).not.toThrow();
    });
  });
});
