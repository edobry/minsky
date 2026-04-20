import { describe, test, expect } from "bun:test";
import { TaskStatus } from "./taskConstants";
import { validateStatusTransition, VALID_TRANSITIONS } from "./status-transitions";

describe("status-transitions", () => {
  describe("VALID_TRANSITIONS map", () => {
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

  describe("validateStatusTransition", () => {
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

    test("PLANNING → CLOSED is valid", () => {
      expect(() => validateStatusTransition(TaskStatus.PLANNING, TaskStatus.CLOSED)).not.toThrow();
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

    // Special case: PLANNING → IN-PROGRESS reserved for session_start
    test("PLANNING → IN-PROGRESS via direct status set is rejected with session_start guidance", () => {
      expect(() => validateStatusTransition(TaskStatus.PLANNING, TaskStatus.IN_PROGRESS)).toThrow(
        /Use session_start to transition from PLANNING to IN-PROGRESS/
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
  });
});
