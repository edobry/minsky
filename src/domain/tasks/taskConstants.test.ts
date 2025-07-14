import { describe, test, expect } from "bun:test";
import {
  TASK_STATUS,
  TASK_STATUS_CHECKBOX,
  CHECKBOX_TO_STATUS,
  TASK_REGEX_PATTERNS,
  TASK_PARSING_UTILS,
  isValidTaskStatus,
} from "../taskConstants";

const TEST_VALUE = 123;
const TEST_ARRAY_SIZE = 6;

describe("Task Constants and Utilities", () => {
  describe("Basic Constants", () => {
    test("should have all required task statuses", () => {
      expect(Object.keys(TASK_STATUS)).toEqual([
        "TODO",
        "IN_PROGRESS",
        "IN_REVIEW",
        "DONE",
        "BLOCKED",
        "CLOSED",
      ]);
    });

    test("should have bidirectional mapping between status and checkbox", () => {
      // Test status to checkbox mapping
      expect(TASK_STATUS_CHECKBOX[TASK_STATUS.TODO]).toBe(" ");
      expect(TASK_STATUS_CHECKBOX[TASK_STATUS.IN_PROGRESS]).toBe("+");
      expect(TASK_STATUS_CHECKBOX[TASK_STATUS.IN_REVIEW]).toBe("-");
      expect(TASK_STATUS_CHECKBOX[TASK_STATUS.DONE]).toBe("x");
      expect(TASK_STATUS_CHECKBOX[TASK_STATUS.BLOCKED]).toBe("~");
      expect(TASK_STATUS_CHECKBOX[TASK_STATUS.CLOSED]).toBe("!");

      // Test checkbox to status mapping
      expect(CHECKBOX_TO_STATUS[" "]).toBe(TASK_STATUS.TODO);
      expect(CHECKBOX_TO_STATUS["+"]).toBe(TASK_STATUS.IN_PROGRESS);
      expect(CHECKBOX_TO_STATUS["-"]).toBe(TASK_STATUS.IN_REVIEW);
      expect(CHECKBOX_TO_STATUS["x"]).toBe(TASK_STATUS.DONE);
      expect(CHECKBOX_TO_STATUS["X"]).toBe(TASK_STATUS.DONE); // Both cases
      expect(CHECKBOX_TO_STATUS["~"]).toBe(TASK_STATUS.BLOCKED);
      expect(CHECKBOX_TO_STATUS["!"]).toBe(TASK_STATUS.CLOSED);
    });
  });

  describe("Regex Patterns", () => {
    test("should match valid task lines", () => {
      const testLines = [
        `- [ ] Test task [#${TEST_VALUE}](path/to/spec.md)`,
        "- [x] Completed task [#456](path/to/spec.md)",
        "- [+] In progress task [#789](path/to/spec.md)",
        "- [-] In review task [#101](path/to/spec.md)",
        "- [~] Blocked task [#202](path/to/spec.md)",
        "- [!] Closed task [#303](path/to/spec.md)",
      ];

      testLines.forEach((line) => {
        expect(TASK_REGEX_PATTERNS.TASK_LINE.test(line)).toBe(true);
      });
    });

    test("should not match invalid task lines", () => {
      const invalidLines = [
        `- [?] Invalid checkbox [#${TEST_VALUE}](path/to/spec.md)`,
        "- [ ] Missing link",
        "Not a task line at all",
        `  - [ ] Indented task [#${TEST_VALUE}](path/to/spec.md)`,
      ];

      invalidLines.forEach((line) => {
        expect(TASK_REGEX_PATTERNS.TASK_LINE.test(line)).toBe(false);
      });
    });
  });

  describe("Parsing Utilities", () => {
    test("should parse valid task lines correctly", () => {
      const testCases = [
        {
          line: `- [ ] Test task [#${TEST_VALUE}](path/to/spec.md)`,
          expected: { checkbox: " ", title: "Test task", id: `#${TEST_VALUE}` },
        },
        {
          line: "- [x] Completed task [#456](path/to/spec.md)",
          expected: { checkbox: "x", title: "Completed task", id: "#456" },
        },
        {
          line: "- [~] Blocked task [#789](path/to/spec.md)",
          expected: { checkbox: "~", title: "Blocked task", id: "#789" },
        },
      ];

      testCases.forEach(({ line, expected }) => {
        const result = TASK_PARSING_UTILS.parseTaskLine(line);
        expect(result).toEqual(expected);
      });
    });

    test("should return null for invalid task lines", () => {
      const invalidLines = [
        `- [?] Invalid checkbox [#${TEST_VALUE}](path/to/spec.md)`,
        "- [ ] Missing link",
        "Not a task line at all",
      ];

      invalidLines.forEach((line) => {
        expect(TASK_PARSING_UTILS.parseTaskLine(line)).toBeNull();
      });
    });

    test("should replace checkbox status correctly", () => {
      const originalLine = `- [ ] Test task [#${TEST_VALUE}](path/to/spec.md)`;
      const result = TASK_PARSING_UTILS.replaceCheckboxStatus(originalLine, TASK_STATUS.BLOCKED);
      expect(result).toBe(`- [~] Test task [#${TEST_VALUE}](path/to/spec.md)`);
    });

    test("should get status from checkbox correctly", () => {
      expect(TASK_PARSING_UTILS.getStatusFromCheckbox(" ")).toBe(TASK_STATUS.TODO);
      expect(TASK_PARSING_UTILS.getStatusFromCheckbox("x")).toBe(TASK_STATUS.DONE);
      expect(TASK_PARSING_UTILS.getStatusFromCheckbox("~")).toBe(TASK_STATUS.BLOCKED);
      expect(TASK_PARSING_UTILS.getStatusFromCheckbox("?")).toBe(TASK_STATUS.TODO);
    });

    test("should get checkbox from status correctly", () => {
      expect(TASK_PARSING_UTILS.getCheckboxFromStatus(TASK_STATUS.TODO)).toBe(" ");
      expect(TASK_PARSING_UTILS.getCheckboxFromStatus(TASK_STATUS.DONE)).toBe("x");
      expect(TASK_PARSING_UTILS.getCheckboxFromStatus(TASK_STATUS.BLOCKED)).toBe("~");
    });

    test("should validate task-like lines correctly", () => {
      expect(TASK_PARSING_UTILS.isTaskLike("- [ ] Some task")).toBe(true);
      expect(TASK_PARSING_UTILS.isTaskLike("- [x] Some task")).toBe(true);
      expect(TASK_PARSING_UTILS.isTaskLike("- [~] Some task")).toBe(true);
      expect(TASK_PARSING_UTILS.isTaskLike("Not a task")).toBe(false);
      expect(TASK_PARSING_UTILS.isTaskLike("* [ ] Different bullet")).toBe(false);
    });
  });

  describe("Status Validation", () => {
    test("should validate valid statuses", () => {
      expect(isValidTaskStatus("TODO")).toBe(true);
      expect(isValidTaskStatus("IN-PROGRESS")).toBe(true);
      expect(isValidTaskStatus("IN-REVIEW")).toBe(true);
      expect(isValidTaskStatus("DONE")).toBe(true);
      expect(isValidTaskStatus("BLOCKED")).toBe(true);
      expect(isValidTaskStatus("CLOSED")).toBe(true);
    });

    test("should reject invalid statuses", () => {
      expect(isValidTaskStatus("INVALID")).toBe(false);
      expect(isValidTaskStatus("")).toBe(false);
      expect(isValidTaskStatus("todo")).toBe(false);
    });
  });

  describe("Dynamic Pattern Generation", () => {
    test("should generate patterns that include all status characters", () => {
      const allCheckboxChars = Object.keys(CHECKBOX_TO_STATUS);

      allCheckboxChars.forEach((char) => {
        const testLine = `- [${char}] Test task [#${TEST_VALUE}](path/to/spec.md)`;
        expect(TASK_REGEX_PATTERNS.TASK_LINE.test(testLine)).toBe(true);
      });
    });

    test("should handle new status additions gracefully", () => {
      const currentStatusCount = Object.keys(TASK_STATUS).length;
      const currentCheckboxCount = Object.keys(CHECKBOX_TO_STATUS).length;

      expect(currentStatusCount).toBeGreaterThanOrEqual(TEST_ARRAY_SIZE);
      expect(currentCheckboxCount).toBeGreaterThanOrEqual(TEST_ARRAY_SIZE);

      expect(TASK_REGEX_PATTERNS.TASK_LINE).toBeDefined();
      expect(TASK_REGEX_PATTERNS.CHECKBOX_REPLACE).toBeDefined();
    });
  });
});
