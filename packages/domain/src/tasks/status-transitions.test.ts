import { describe, test, expect } from "bun:test";
import { TaskStatus } from "./taskConstants";
import { getWorkflow } from "./workflows";
import {
  validateStatusTransition,
  hasCloseoutEvidence,
  checkCloseoutEvidence,
  closeoutEvidenceFailureMessage,
  CLOSEOUT_EVIDENCE_HEADING,
  CLOSEOUT_EVIDENCE_NEAR_MISS_HEADING,
  closeoutEvidenceEmptySectionMessage,
  CLOSEOUT_EVIDENCE_ABSENT_MESSAGE,
} from "./status-transitions";

describe("status-transitions", () => {
  // mt#3010: the legacy VALID_TRANSITIONS backward-compat export was removed —
  // "implementation" workflow transitions are now asserted directly against the
  // registry (getWorkflow), the single source of truth.
  describe("implementation workflow transitions (registry)", () => {
    test("every TaskStatus has a transitions entry", () => {
      const { transitions } = getWorkflow("implementation");
      for (const status of Object.values(TaskStatus)) {
        expect(transitions).toHaveProperty(status);
      }
    });

    test("CLOSED is reachable from every non-CLOSED status (implementation kind)", () => {
      const { transitions } = getWorkflow("implementation");
      for (const status of Object.values(TaskStatus)) {
        if (status === TaskStatus.CLOSED) continue;
        expect(transitions[status]).toContain(TaskStatus.CLOSED);
      }
    });

    test("READY → DONE is listed (guarded by spec check in setTaskStatusFromParams)", () => {
      const { transitions } = getWorkflow("implementation");
      expect(transitions[TaskStatus.READY]).toContain(TaskStatus.DONE);
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

    test("IN-PROGRESS → DONE is valid for umbrella (single terminal, mt#2311)", () => {
      expect(() => validateStatusTransition("IN-PROGRESS", "DONE", "umbrella")).not.toThrow();
    });

    test("DONE → CLOSED is valid for umbrella", () => {
      expect(() => validateStatusTransition("DONE", "CLOSED", "umbrella")).not.toThrow();
    });

    test("CLOSED → TODO is valid for umbrella (reopen)", () => {
      expect(() => validateStatusTransition("CLOSED", "TODO", "umbrella")).not.toThrow();
    });

    // COMPLETED was removed by mt#2311 — it is no longer a state in any workflow.
    test("IN-PROGRESS → COMPLETED is invalid for umbrella (state removed, mt#2311)", () => {
      expect(() => validateStatusTransition("IN-PROGRESS", "COMPLETED", "umbrella")).toThrow(
        /Cannot transition from IN-PROGRESS to COMPLETED/
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
        validateStatusTransition("IN-PROGRESS", "IN-REVIEW", "umbrella");
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

  describe("validateStatusTransition — work-package kind (ADR-046, mt#2911)", () => {
    // The full allowed map
    test("TODO → READY is valid for work-package (publish the drafted bundle)", () => {
      expect(() => validateStatusTransition("TODO", "READY", "work-package")).not.toThrow();
    });

    test("READY → TODO is valid for work-package (pull back to drafting)", () => {
      expect(() => validateStatusTransition("READY", "TODO", "work-package")).not.toThrow();
    });

    test("IN-PROGRESS → DONE is valid for work-package (completed)", () => {
      expect(() => validateStatusTransition("IN-PROGRESS", "DONE", "work-package")).not.toThrow();
    });

    test("DONE → CLOSED and CLOSED → TODO are valid for work-package", () => {
      expect(() => validateStatusTransition("DONE", "CLOSED", "work-package")).not.toThrow();
      expect(() => validateStatusTransition("CLOSED", "TODO", "work-package")).not.toThrow();
    });

    test("every non-terminal state can reach CLOSED (supersede/abandon)", () => {
      for (const from of ["TODO", "READY", "IN-PROGRESS"]) {
        expect(() => validateStatusTransition(from, "CLOSED", "work-package")).not.toThrow();
      }
    });

    // The claim-path reservation: READY → IN-PROGRESS is reachable, but not via
    // a direct status-set — ownership identity must be written atomically with
    // the transition, so the claim command owns it.
    test("READY → IN-PROGRESS via direct status_set is RESERVED for the claim path", () => {
      expect(() => validateStatusTransition("READY", "IN-PROGRESS", "work-package")).toThrow(
        /claimed, not status-set/
      );
    });

    // Absent states
    test("PLANNING is absent for work-package (the briefing is the plan)", () => {
      expect(() => validateStatusTransition("TODO", "PLANNING", "work-package")).toThrow(
        /Cannot transition from TODO to PLANNING/
      );
    });

    test("IN-REVIEW is absent for work-package (no PR of its own)", () => {
      expect(() => validateStatusTransition("IN-PROGRESS", "IN-REVIEW", "work-package")).toThrow(
        /Cannot transition from IN-PROGRESS to IN-REVIEW/
      );
    });

    test("BLOCKED is absent for work-package (members block individually)", () => {
      expect(() => validateStatusTransition("READY", "BLOCKED", "work-package")).toThrow(
        /Cannot transition from READY to BLOCKED/
      );
    });

    test("error message includes kind label for work-package transitions", () => {
      try {
        validateStatusTransition("IN-PROGRESS", "IN-REVIEW", "work-package");
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect((error as Error).message).toContain("kind: work-package");
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

    test("IN-PROGRESS → DONE is valid for state-ops (single terminal, mt#2311)", () => {
      expect(() => validateStatusTransition("IN-PROGRESS", "DONE", "state-ops")).not.toThrow();
    });

    test("DONE → CLOSED is valid for state-ops", () => {
      expect(() => validateStatusTransition("DONE", "CLOSED", "state-ops")).not.toThrow();
    });

    test("CLOSED → TODO is valid for state-ops (reopen)", () => {
      expect(() => validateStatusTransition("CLOSED", "TODO", "state-ops")).not.toThrow();
    });

    test("IN-PROGRESS → PLANNING is valid for state-ops (go back)", () => {
      expect(() => validateStatusTransition("IN-PROGRESS", "PLANNING", "state-ops")).not.toThrow();
    });

    // Absent states
    test("IN-PROGRESS → COMPLETED is invalid for state-ops (state removed, mt#2311)", () => {
      expect(() => validateStatusTransition("IN-PROGRESS", "COMPLETED", "state-ops")).toThrow(
        /Cannot transition from IN-PROGRESS to COMPLETED/
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
        validateStatusTransition("IN-PROGRESS", "IN-REVIEW", "state-ops");
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

    // --- Synonym headings (mt#455: investigation-shaped closeout) ---

    test("accepts ## Findings as a synonym", () => {
      const spec = `## Summary\n...\n\n## Findings\nThe root cause is X; see the trace at Y.\n`;
      expect(hasCloseoutEvidence(spec)).toBe(true);
    });

    test("accepts ## Outcome as a synonym", () => {
      const spec = `## Outcome\nDecision: fold research into state-ops (ask 0480a4c3).\n`;
      expect(hasCloseoutEvidence(spec)).toBe(true);
    });

    test("synonyms are case-insensitive and accept trailing colon", () => {
      expect(hasCloseoutEvidence(`## FINDINGS:\ncontent\n`)).toBe(true);
      expect(hasCloseoutEvidence(`## outcome\ncontent\n`)).toBe(true);
    });

    test("an empty evidence section does not mask a later populated synonym section", () => {
      const spec = `## Outcome\n\n## Notes\nfiller\n\n## Findings\nActual findings here.\n`;
      expect(hasCloseoutEvidence(spec)).toBe(true);
    });

    test("does not match ## Findings-adjacent headings", () => {
      expect(hasCloseoutEvidence(`## Findings summary\ncontent\n`)).toBe(false);
      expect(hasCloseoutEvidence(`## Outcomes\ncontent\n`)).toBe(false);
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

    // --- CLOSEOUT_EVIDENCE_ABSENT_MESSAGE presence check ---

    test("CLOSEOUT_EVIDENCE_ABSENT_MESSAGE mentions Closeout evidence", () => {
      expect(CLOSEOUT_EVIDENCE_ABSENT_MESSAGE).toContain("Closeout evidence");
    });

    test("CLOSEOUT_EVIDENCE_ABSENT_MESSAGE mentions READY and DONE", () => {
      expect(CLOSEOUT_EVIDENCE_ABSENT_MESSAGE).toContain("READY");
      expect(CLOSEOUT_EVIDENCE_ABSENT_MESSAGE).toContain("DONE");
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

    test("CLOSEOUT_EVIDENCE_ABSENT_MESSAGE names the synonym headings (mt#455)", () => {
      expect(CLOSEOUT_EVIDENCE_ABSENT_MESSAGE).toContain("Findings");
      expect(CLOSEOUT_EVIDENCE_ABSENT_MESSAGE).toContain("Outcome");
    });
  });

  // --- Qualified headings + cause-specific refusals (mt#3443) ---

  /** A bare prose continuation — the shape the widening deliberately still rejects. */
  const NEAR_MISS_HEADING = "## Findings summary";

  describe("qualified closeout-evidence headings", () => {
    const QUALIFIED_HEADING = "## Findings (planning investigation, 2026-07-31)";

    const ACCEPTED_HEADINGS = [
      "## Closeout evidence",
      "## Findings",
      "## Outcome",
      "## Findings:",
      QUALIFIED_HEADING,
      "## Outcome — recommendation",
    ];

    test("accepts a parenthetical qualifier (AT1)", () => {
      const spec = `${QUALIFIED_HEADING}\nThe root cause is X.\n`;
      expect(hasCloseoutEvidence(spec)).toBe(true);
      expect(checkCloseoutEvidence(spec).state).toBe("present");
    });

    test("accepts an em-dash and an en-dash qualifier", () => {
      expect(hasCloseoutEvidence("## Outcome — recommendation\nShip option (b).\n")).toBe(true);
      expect(hasCloseoutEvidence("## Outcome – recommendation\nShip option (b).\n")).toBe(true);
    });

    test("accepts a colon-introduced qualifier, and a bare trailing colon (regression)", () => {
      expect(hasCloseoutEvidence("## Closeout evidence: deployed\nhttps://example.com\n")).toBe(
        true
      );
      expect(hasCloseoutEvidence("## Closeout evidence:\nhttps://example.com\n")).toBe(true);
    });

    test("a bare heading with content still passes (AT2 regression)", () => {
      const spec = `## Summary\n...\n\n## Findings\nThe root cause is X.\n`;
      expect(checkCloseoutEvidence(spec).state).toBe("present");
    });

    test("rejects a bare prose continuation and a plural — the deliberate non-widening", () => {
      expect(CLOSEOUT_EVIDENCE_HEADING.test("## Findings from the reviewer we rejected")).toBe(
        false
      );
      expect(CLOSEOUT_EVIDENCE_HEADING.test(NEAR_MISS_HEADING)).toBe(false);
      expect(CLOSEOUT_EVIDENCE_HEADING.test("## Outcomes")).toBe(false);
      // A plain hyphen is ordinary prose punctuation, not a qualifier delimiter (mt#3511).
      expect(CLOSEOUT_EVIDENCE_HEADING.test("## Findings - summary")).toBe(false);
    });

    test("a bracketed qualifier must close on the same line (PR #2541 R1)", () => {
      expect(CLOSEOUT_EVIDENCE_HEADING.test("## Findings [2026-08-01]")).toBe(true);
      expect(CLOSEOUT_EVIDENCE_HEADING.test("## Findings (unclosed")).toBe(false);
      expect(CLOSEOUT_EVIDENCE_HEADING.test("## Findings [unclosed")).toBe(false);
      expect(CLOSEOUT_EVIDENCE_HEADING.test("## Findings (")).toBe(false);
    });

    test("near-miss pattern matches rejected keyword headings but not unrelated ones", () => {
      expect(CLOSEOUT_EVIDENCE_NEAR_MISS_HEADING.test(NEAR_MISS_HEADING)).toBe(true);
      expect(CLOSEOUT_EVIDENCE_NEAR_MISS_HEADING.test("## Outcomes")).toBe(true);
      expect(CLOSEOUT_EVIDENCE_NEAR_MISS_HEADING.test("## Summary")).toBe(false);
      expect(CLOSEOUT_EVIDENCE_NEAR_MISS_HEADING.test("## Scope")).toBe(false);
    });

    // The two patterns duplicate their noun alternation; this pins the superset property
    // so a widening of one without the other cannot ship silently.
    test("every accepted heading also matches the near-miss pattern", () => {
      for (const heading of ACCEPTED_HEADINGS) {
        expect(CLOSEOUT_EVIDENCE_HEADING.test(heading)).toBe(true);
        expect(CLOSEOUT_EVIDENCE_NEAR_MISS_HEADING.test(heading)).toBe(true);
      }
    });
  });

  describe("closeout-evidence refusal names its actual cause (mt#3443)", () => {
    const NEAR_MISS_SPEC = `## Summary\nA task.\n\n${NEAR_MISS_HEADING}\nRichly populated.\n`;
    const EMPTY_SPEC = `## Summary\n\n## Findings\n`;
    const ABSENT_SPEC = `## Summary\nSome summary.\n\n## Scope\nIn scope: foo\n`;

    test("a populated section yields no refusal", () => {
      expect(closeoutEvidenceFailureMessage(checkCloseoutEvidence("## Findings\nX.\n"))).toBe(null);
    });

    test("a near-miss heading is reported as a heading problem, naming the heading (AT1 fallback)", () => {
      const result = checkCloseoutEvidence(NEAR_MISS_SPEC);
      expect(result.state).toBe("near-miss");
      expect(result.nearMissHeadings).toEqual([NEAR_MISS_HEADING]);

      const message = closeoutEvidenceFailureMessage(result);
      expect(message).toContain(NEAR_MISS_HEADING);
      expect(message).toContain("HEADING problem, not missing content");
    });

    test("an empty accepted section is reported as a content problem, naming it (AT3)", () => {
      const result = checkCloseoutEvidence(EMPTY_SPEC);
      expect(result.state).toBe("empty-section");
      expect(result.emptyHeadings).toEqual(["## Findings"]);
      expect(closeoutEvidenceFailureMessage(result)).toBe(
        closeoutEvidenceEmptySectionMessage(["## Findings"])
      );
      expect(closeoutEvidenceFailureMessage(result)).toContain("its section is EMPTY");
    });

    test("a spec with no evidence heading gets the no-section message (AT4)", () => {
      const result = checkCloseoutEvidence(ABSENT_SPEC);
      expect(result.state).toBe("absent");
      expect(closeoutEvidenceFailureMessage(result)).toBe(CLOSEOUT_EVIDENCE_ABSENT_MESSAGE);
    });

    test("the three refusals are distinct texts", () => {
      const messages = [NEAR_MISS_SPEC, EMPTY_SPEC, ABSENT_SPEC].map((spec) =>
        closeoutEvidenceFailureMessage(checkCloseoutEvidence(spec))
      );
      expect(new Set(messages).size).toBe(3);
    });

    test("both refusals are plural-safe when several headings are listed (PR #2541 R1)", () => {
      const twoNearMisses = `${NEAR_MISS_HEADING}\nProse.\n\n## Outcomes\nMore prose.\n`;
      const nearMiss = checkCloseoutEvidence(twoNearMisses);
      expect(nearMiss.nearMissHeadings).toEqual([NEAR_MISS_HEADING, "## Outcomes"]);
      expect(closeoutEvidenceFailureMessage(nearMiss)).toContain(
        "2 sections whose headings nearly match"
      );

      const twoEmpty = checkCloseoutEvidence(`## Findings\n\n## Outcome\n`);
      expect(twoEmpty.emptyHeadings).toEqual(["## Findings", "## Outcome"]);
      expect(closeoutEvidenceFailureMessage(twoEmpty)).toContain("2 accepted headings are present");
    });

    test("an accepted-but-empty heading outranks a near miss elsewhere in the spec", () => {
      const spec = `${NEAR_MISS_HEADING}\nProse.\n\n## Outcome\n`;
      expect(checkCloseoutEvidence(spec).state).toBe("empty-section");
    });

    test("a populated later section still wins over an earlier empty one (mt#455 regression)", () => {
      const spec = `## Outcome\n\n## Notes\nfiller\n\n## Findings (2026-08-01)\nActual findings.\n`;
      expect(checkCloseoutEvidence(spec).state).toBe("present");
    });
  });
});
