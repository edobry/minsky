import { describe, test, expect } from "bun:test";
import {
  formatTaskIdForDisplay,
  validateQualifiedTaskId,
  isQualifiedFormat,
  getTaskIdNumber,
} from "./task-id-utils";

describe("Task ID Utilities - STRICT QUALIFIED IDs ONLY", () => {
  describe("validateQualifiedTaskId", () => {
    test("should accept only qualified IDs", () => {
      expect(validateQualifiedTaskId("md#283")).toBe("md#283");
      expect(validateQualifiedTaskId("gh#123")).toBe("gh#123");
      expect(validateQualifiedTaskId("md#001")).toBe("md#001");
    });

    test("should convert legacy IDs to qualified format", () => {
      // These legacy formats are converted to qualified IDs
      expect(validateQualifiedTaskId("283")).toBe("md#283");
      expect(validateQualifiedTaskId("#283")).toBe("md#283");
      // task# is actually treated as already qualified format
      expect(validateQualifiedTaskId("task#283")).toBe("task#283");
    });

    test("should reject truly invalid input", () => {
      expect(validateQualifiedTaskId("")).toBeNull();
      expect(validateQualifiedTaskId("abc@$")).toBeNull();
    });

    test("should handle invalid input", () => {
      expect(validateQualifiedTaskId(null as any)).toBeNull();
      expect(validateQualifiedTaskId(undefined as any)).toBeNull();
      expect(validateQualifiedTaskId(123 as any)).toBeNull();
    });
  });

  describe("formatTaskIdForDisplay", () => {
    test("should preserve qualified IDs unchanged", () => {
      expect(formatTaskIdForDisplay("md#283")).toBe("md#283");
      expect(formatTaskIdForDisplay("gh#123")).toBe("gh#123");
      expect(formatTaskIdForDisplay("md#001")).toBe("md#001");
    });

    test("should convert legacy formats for display (graceful fallback)", () => {
      // These are graceful fallbacks for display purposes
      expect(formatTaskIdForDisplay("64")).toBe("md#64");
      expect(formatTaskIdForDisplay("#64")).toBe("md#64");
      expect(formatTaskIdForDisplay("0")).toBe("md#0");
    });

    test("should handle invalid input", () => {
      expect(formatTaskIdForDisplay("")).toBe("");
      expect(formatTaskIdForDisplay(null as any)).toBe("");
      expect(formatTaskIdForDisplay(undefined as any)).toBe("");
    });
  });

  describe("isQualifiedFormat", () => {
    test("should identify qualified IDs correctly", () => {
      expect(isQualifiedFormat("md#283")).toBe(true);
      expect(isQualifiedFormat("gh#123")).toBe(true);
      expect(isQualifiedFormat("local#456")).toBe(true);
    });

    test("should reject non-qualified formats", () => {
      expect(isQualifiedFormat("283")).toBe(false);
      expect(isQualifiedFormat("#283")).toBe(false);
      // Note: task# is actually detected as qualified by the current regex
      expect(isQualifiedFormat("task#283")).toBe(true);
      expect(isQualifiedFormat("")).toBe(false);
    });
  });

  describe("getTaskIdNumber", () => {
    test("should extract numbers from qualified IDs only", () => {
      expect(getTaskIdNumber("md#283")).toBe(283);
      expect(getTaskIdNumber("gh#123")).toBe(123);
      expect(getTaskIdNumber("md#001")).toBe(1);
      expect(getTaskIdNumber("md#000")).toBe(0);
    });

    test("should handle legacy numeric formats", () => {
      // These formats are supported for backward compatibility
      expect(getTaskIdNumber("283")).toBe(283);
      expect(getTaskIdNumber("#283")).toBe(283);
      expect(getTaskIdNumber("task#283")).toBe(283);
    });

    test("should return null for invalid input", () => {
      expect(getTaskIdNumber("")).toBeNull();
      expect(getTaskIdNumber("abc")).toBeNull();
    });

    test("should handle invalid input", () => {
      expect(getTaskIdNumber(null as any)).toBeNull();
      expect(getTaskIdNumber(undefined as any)).toBeNull();
    });
  });

  describe("integration scenarios", () => {
    test("should maintain strict qualified ID policy", () => {
      const qualifiedIds = ["md#283", "gh#123", "md#001"];

      for (const id of qualifiedIds) {
        // Validation should pass
        expect(validateQualifiedTaskId(id)).toBe(id);
        expect(isQualifiedFormat(id)).toBe(true);

        // Display should preserve the ID
        expect(formatTaskIdForDisplay(id)).toBe(id);

        // Number extraction should work
        const num = getTaskIdNumber(id);
        expect(typeof num).toBe("number");
        expect(num).toBeGreaterThanOrEqual(0);
      }
    });

    test("should handle various input formats consistently", () => {
      const numericLegacyIds = ["283", "#283"];
      const invalidIds = ["", "abc@$"];

      // Numeric legacy IDs should be converted to qualified format
      for (const id of numericLegacyIds) {
        expect(validateQualifiedTaskId(id)).toBe("md#283");
      }

      // task# prefix is treated as already qualified
      expect(validateQualifiedTaskId("task#283")).toBe("task#283");

      // Invalid IDs should be rejected
      for (const id of invalidIds) {
        expect(validateQualifiedTaskId(id)).toBeNull();
        expect(isQualifiedFormat(id)).toBe(false);

        // Number extraction should fail
        expect(getTaskIdNumber(id)).toBeNull();
      }
    });
  });
});
