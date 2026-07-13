import { describe, test, expect } from "bun:test";
import { TaskStatus } from "./taskConstants";
import {
  validateStatusTransition,
  VALID_TRANSITIONS,
  hasCloseoutEvidence,
  CLOSEOUT_EVIDENCE_HEADING,
  READY_TO_DONE_MISSING_EVIDENCE_MESSAGE,
} from "./status-transitions";

describe("status-transitions", () => {
  describe("VALID_TRANSITIONS map (implementation kind backward-compat)", () => {
    test("every TaskStatus has a transitions entry", () => {
      for (const status of Object.values(TaskStatus)) {
        expect(VALID_TRANSITIONS).toHaveProperty(status);
      }
    });

    test("CLOSED is reachable from every non-CLOSED status (implementation kind)", () => {
      for (const status of Object.values(TaskStatus)) {
        // Skip CLOSED (the terminal) and COMPLETED (umbrella-kind terminal — has its
        // own per-kind workflow in WORKFLOWS.umbrella; the implementation-kind
        // VALID_TRANSITIONS table only lists it for type exhaustivity with an
        // empty outgoing array per mt#1812).
        if (status === TaskStatus.CLOSED || status === TaskStatus.COMPLETED) continue;
        expect(VALID_TRANSITIONS[status]).toContain(TaskStatus.CLOSED);
      }
    });

    test("READY → DONE is listed in VALID_TRANSITIONS (guarded by spec check in setTaskStatusFromParams)", () => {
      expect(VALID_TRANSITIONS[TaskStatus.READY]).toContain(TaskStatus.DONE);
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

    test("READY → DONE is valid at the transition-gate level (spec check is upstream)", () => {
      // The workflow allows READY → DONE; the spec content guard lives in
      // setTaskStatusFromParams, not in validateStatusTransition itself.
      expect(() => validateStatusTransition(TaskStatus.READY, TaskStatus.DONE)).not.toThrow();
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

  describe("validateStatusTransition — state-ops kind (mt#2661)", () => {
    test("TODO → PLANNING is valid for state-ops", () => {
      expect(() => validateStatusTransition("TODO", "PLANNING", "state-ops")).not.toThrow();
    });

    test("TODO → CLOSED is valid for state-ops", () => {
      expect(() => validateStatusTransition("TODO", "CLOSED", "state-ops")).not.toThrow();
    });

    test("PLANNING → READY is valid for state-ops", () => {
      expect(() => validateStatusTransition("PLANNING", "READY", "state-ops")).not.toThrow();
    });

    // Core mt#2661 property: READY → IN-PROGRESS is legal WITHOUT session_start
    // for state-ops, unlike implementation.
    test("READY → IN-PROGRESS via direct status_set is ALLOWED for state-ops (no session required)", () => {
      expect(() => validateStatusTransition("READY", "IN-PROGRESS", "state-ops")).not.toThrow();
    });

    test("IN-PROGRESS → COMPLETED is valid for state-ops", () => {
      expect(() => validateStatusTransition("IN-PROGRESS", "COMPLETED", "state-ops")).not.toThrow();
    });

    test("COMPLETED → CLOSED is valid for state-ops", () => {
      expect(() => validateStatusTransition("COMPLETED", "CLOSED", "state-ops")).not.toThrow();
    });

    test("CLOSED → TODO is valid for state-ops (reopen)", () => {
      expect(() => validateStatusTransition("CLOSED", "TODO", "state-ops")).not.toThrow();
    });

    test("IN-PROGRESS → PLANNING is valid for state-ops (go back)", () => {
      expect(() => validateStatusTransition("IN-PROGRESS", "PLANNING", "state-ops")).not.toThrow();
    });

    // Absent states
    test("IN-PROGRESS → DONE is invalid for state-ops (use COMPLETED)", () => {
      expect(() => validateStatusTransition("IN-PROGRESS", "DONE", "state-ops")).toThrow(
        /Cannot transition from IN-PROGRESS to DONE/
      );
    });

    test("IN-PROGRESS → IN-REVIEW is invalid for state-ops (no review phase)", () => {
      expect(() => validateStatusTransition("IN-PROGRESS", "IN-REVIEW", "state-ops")).toThrow(
        /Cannot transition from IN-PROGRESS to IN-REVIEW/
      );
    });

    test("PLANNING → BLOCKED is invalid for state-ops (no BLOCKED state)", () => {
      expect(() => validateStatusTransition("PLANNING", "BLOCKED", "state-ops")).toThrow(
        /Cannot transition from PLANNING to BLOCKED/
      );
    });

    // Error messages include kind label for non-implementation kinds
    test("error message includes kind label for state-ops transitions", () => {
      try {
        validateStatusTransition("IN-PROGRESS", "DONE", "state-ops");
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("kind: state-ops");
      }
    });

    // The implementation-kind session_start special case does NOT apply to state-ops
    test("READY → IN-PROGRESS error does not mention session_start for state-ops", () => {
      // No error expected at all, but assert defensively that even if the
      // registry ever tightened, the session_start special case never applies.
      expect(() => validateStatusTransition("READY", "IN-PROGRESS", "state-ops")).not.toThrow();
    });

    // The implementation-kind PLANNING→IN-PROGRESS special case does NOT apply to state-ops
    test("PLANNING → IN-PROGRESS is invalid for state-ops but not via the session_start special case", () => {
      // PLANNING → IN-PROGRESS is not a direct transition in the state-ops workflow
      // (must go through READY first), but the error should be the generic
      // "cannot transition" message, not the implementation-only session_start guidance.
      try {
        validateStatusTransition("PLANNING", "IN-PROGRESS", "state-ops");
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        const message = (error as Error).message;
        expect(message).not.toContain("session_start");
        expect(message).toContain("kind: state-ops");
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

  describe("hasCloseoutEvidence", () => {
    // --- Positive cases ---

    test("returns true when section has content", () => {
      const spec = `## Summary\nSome summary.\n\n## Closeout evidence\nhttps://notion.so/page-123 — Published 2026-05-11.\n`;
      expect(hasCloseoutEvidence(spec)).toBe(true);
    });

    test("returns true with minimal content after heading", () => {
      const spec = `## Closeout evidence\nDone.\n`;
      expect(hasCloseoutEvidence(spec)).toBe(true);
    });

    test("returns true when section is at end of spec with content", () => {
      const spec = `## Summary\n...\n\n## Closeout evidence\nArtifact: https://example.com/artifact`;
      expect(hasCloseoutEvidence(spec)).toBe(true);
    });

    // --- Case-insensitive heading ---

    test("is case-insensitive: ## CLOSEOUT EVIDENCE", () => {
      const spec = `## CLOSEOUT EVIDENCE\nhttps://example.com/artifact\n`;
      expect(hasCloseoutEvidence(spec)).toBe(true);
    });

    test("is case-insensitive: ## closeout evidence", () => {
      const spec = `## closeout evidence\nhttps://example.com/artifact\n`;
      expect(hasCloseoutEvidence(spec)).toBe(true);
    });

    test("is case-insensitive: ## Closeout Evidence", () => {
      const spec = `## Closeout Evidence\nhttps://example.com/artifact\n`;
      expect(hasCloseoutEvidence(spec)).toBe(true);
    });

    test("matches heading with trailing colon", () => {
      const spec = `## Closeout evidence:\nhttps://example.com/artifact\n`;
      expect(hasCloseoutEvidence(spec)).toBe(true);
    });

    // --- Negative cases ---

    test("returns false when spec is empty string", () => {
      expect(hasCloseoutEvidence("")).toBe(false);
    });

    test("returns false when section is absent", () => {
      const spec = `## Summary\nSome summary.\n\n## Scope\nIn scope: foo\n`;
      expect(hasCloseoutEvidence(spec)).toBe(false);
    });

    test("returns false when heading is present but no content follows", () => {
      const spec = `## Summary\n\n## Closeout evidence\n`;
      expect(hasCloseoutEvidence(spec)).toBe(false);
    });

    test("returns false when heading is present but only blank lines follow", () => {
      const spec = `## Closeout evidence\n\n\n   \n`;
      expect(hasCloseoutEvidence(spec)).toBe(false);
    });

    test("returns false when heading is present but section ends at next ## heading with no content", () => {
      const spec = `## Closeout evidence\n\n## Another section\nContent here.\n`;
      expect(hasCloseoutEvidence(spec)).toBe(false);
    });

    test("returns false when spec is a null-ish empty value", () => {
      expect(hasCloseoutEvidence("")).toBe(false);
    });

    // --- READY_TO_DONE_MISSING_EVIDENCE_MESSAGE presence check ---

    test("READY_TO_DONE_MISSING_EVIDENCE_MESSAGE mentions Closeout evidence", () => {
      expect(READY_TO_DONE_MISSING_EVIDENCE_MESSAGE).toContain("Closeout evidence");
    });

    test("READY_TO_DONE_MISSING_EVIDENCE_MESSAGE mentions READY and DONE", () => {
      expect(READY_TO_DONE_MISSING_EVIDENCE_MESSAGE).toContain("READY");
      expect(READY_TO_DONE_MISSING_EVIDENCE_MESSAGE).toContain("DONE");
    });

    // --- CLOSEOUT_EVIDENCE_HEADING regex ---

    test("CLOSEOUT_EVIDENCE_HEADING matches canonical form", () => {
      expect(CLOSEOUT_EVIDENCE_HEADING.test("## Closeout evidence")).toBe(true);
    });

    test("CLOSEOUT_EVIDENCE_HEADING is case-insensitive", () => {
      expect(CLOSEOUT_EVIDENCE_HEADING.test("## CLOSEOUT EVIDENCE")).toBe(true);
    });

    test("CLOSEOUT_EVIDENCE_HEADING does not match ## without the words", () => {
      expect(CLOSEOUT_EVIDENCE_HEADING.test("## Summary")).toBe(false);
    });
  });
});
