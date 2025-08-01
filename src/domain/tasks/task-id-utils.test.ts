import { describe, test, expect } from "bun:test";
import {
  normalizeTaskIdForStorage,
  formatTaskIdForDisplay,
  isStorageFormat,
  isDisplayFormat,
  convertTaskIdFormat,
  isValidTaskIdInput,
  getTaskIdNumber,
} from "./task-id-utils";

describe("Task ID Utilities for Task 283", () => {
  describe("normalizeTaskIdForStorage", () => {
    test("should convert display format to qualified storage format", () => {
      expect(normalizeTaskIdForStorage("#283")).toBe("md#283");
      expect(normalizeTaskIdForStorage("#001")).toBe("md#001");
      expect(normalizeTaskIdForStorage("#64")).toBe("md#64");
    });

    test("should convert legacy format to qualified storage format", () => {
      expect(normalizeTaskIdForStorage("283")).toBe("md#283");
      expect(normalizeTaskIdForStorage("001")).toBe("md#001");
      expect(normalizeTaskIdForStorage("64")).toBe("md#64");
    });

    test("should handle task# prefix format", () => {
      expect(normalizeTaskIdForStorage("task#283")).toBe("md#283");
      expect(normalizeTaskIdForStorage("TASK#64")).toBe("md#64");
      expect(normalizeTaskIdForStorage("Task#001")).toBe("md#001");
    });

    test("should strip multiple # prefixes", () => {
      expect(normalizeTaskIdForStorage("##283")).toBe("md#283");
      expect(normalizeTaskIdForStorage("###64")).toBe("md#64");
    });

    test("should handle whitespace", () => {
      expect(normalizeTaskIdForStorage("  283  ")).toBe("md#283");
      expect(normalizeTaskIdForStorage("  #64  ")).toBe("md#64");
      expect(normalizeTaskIdForStorage("  task#001  ")).toBe("md#001");
    });

    test("should return null for invalid input", () => {
      expect(normalizeTaskIdForStorage("")).toBeNull();
      expect(normalizeTaskIdForStorage("   ")).toBeNull();
      expect(normalizeTaskIdForStorage("abc")).toBeNull();
      expect(normalizeTaskIdForStorage("#abc")).toBeNull();
      expect(normalizeTaskIdForStorage("283abc")).toBeNull();
      expect(normalizeTaskIdForStorage("abc283")).toBeNull();
      expect(normalizeTaskIdForStorage(null as any)).toBeNull();
      expect(normalizeTaskIdForStorage(undefined as any)).toBeNull();
      expect(normalizeTaskIdForStorage(123 as any)).toBeNull();
    });

    test("should handle edge cases", () => {
      expect(normalizeTaskIdForStorage("0")).toBe("md#0");
      expect(normalizeTaskIdForStorage("#0")).toBe("md#0");
      expect(normalizeTaskIdForStorage("000")).toBe("md#000");
      expect(normalizeTaskIdForStorage("#000")).toBe("md#000");
    });
  });

  describe("formatTaskIdForDisplay", () => {
    test("should handle legacy storage format by converting to qualified", () => {
      expect(formatTaskIdForDisplay("283")).toBe("md#283");
      expect(formatTaskIdForDisplay("001")).toBe("md#001");
      expect(formatTaskIdForDisplay("64")).toBe("md#64");
    });

    test("should handle legacy display format by converting to qualified", () => {
      expect(formatTaskIdForDisplay("#283")).toBe("md#283");
      expect(formatTaskIdForDisplay("#001")).toBe("md#001");
      expect(formatTaskIdForDisplay("#64")).toBe("md#64");
    });

    test("should handle invalid input", () => {
      expect(formatTaskIdForDisplay("")).toBe("");
      expect(formatTaskIdForDisplay(null as any)).toBe("");
      expect(formatTaskIdForDisplay(undefined as any)).toBe("");
    });

    test("should handle edge cases", () => {
      expect(formatTaskIdForDisplay("0")).toBe("md#0");
      expect(formatTaskIdForDisplay("000")).toBe("md#000");
    });
  });

  describe("isStorageFormat", () => {
    test("should identify qualified storage format correctly", () => {
      expect(isStorageFormat("md#283")).toBe(true);
      expect(isStorageFormat("gh#001")).toBe(true);
      expect(isStorageFormat("md#64")).toBe(true);
      expect(isStorageFormat("md#0")).toBe(true);
    });

    test("should reject legacy formats", () => {
      expect(isStorageFormat("283")).toBe(false);
      expect(isStorageFormat("#283")).toBe(false);
      expect(isStorageFormat("#001")).toBe(false);
      expect(isStorageFormat("#64")).toBe(false);
    });

    test("should reject invalid formats", () => {
      expect(isStorageFormat("")).toBe(false);
      expect(isStorageFormat("abc")).toBe(false);
      expect(isStorageFormat("283abc")).toBe(false);
      expect(isStorageFormat("task#283")).toBe(true); // task#283 is valid qualified format
      expect(isStorageFormat(null as any)).toBe(false);
      expect(isStorageFormat(undefined as any)).toBe(false);
    });

    test("should handle whitespace", () => {
      expect(isStorageFormat("  md#283  ")).toBe(true);
      expect(isStorageFormat("  abc  ")).toBe(false);
    });
  });

  describe("isDisplayFormat", () => {
    test("should identify qualified display format correctly", () => {
      expect(isDisplayFormat("md#283")).toBe(true);
      expect(isDisplayFormat("gh#001")).toBe(true);
      expect(isDisplayFormat("md#64")).toBe(true);
      expect(isDisplayFormat("md#0")).toBe(true);
    });

    test("should reject legacy formats", () => {
      expect(isDisplayFormat("283")).toBe(false);
      expect(isDisplayFormat("#283")).toBe(false);
      expect(isDisplayFormat("#001")).toBe(false);
      expect(isDisplayFormat("#64")).toBe(false);
    });

    test("should reject invalid formats", () => {
      expect(isDisplayFormat("")).toBe(false);
      expect(isDisplayFormat("#")).toBe(false);
      expect(isDisplayFormat("#abc")).toBe(false);
      expect(isDisplayFormat("#283abc")).toBe(false);
      expect(isDisplayFormat("##283")).toBe(false);
      expect(isDisplayFormat("task#283")).toBe(true); // task#283 is valid qualified format
      expect(isDisplayFormat(null as any)).toBe(false);
      expect(isDisplayFormat(undefined as any)).toBe(false);
    });

    test("should handle whitespace", () => {
      expect(isDisplayFormat("  md#283  ")).toBe(true);
      expect(isDisplayFormat("  #abc  ")).toBe(false);
    });
  });

  describe("convertTaskIdFormat", () => {
    test("should convert to qualified storage format", () => {
      expect(convertTaskIdFormat("#283", "storage")).toBe("md#283");
      expect(convertTaskIdFormat("283", "storage")).toBe("md#283");
      expect(convertTaskIdFormat("task#283", "storage")).toBe("md#283");
    });

    test("should convert to qualified display format", () => {
      expect(convertTaskIdFormat("283", "display")).toBe("md#283");
      expect(convertTaskIdFormat("#283", "display")).toBe("md#283");
      expect(convertTaskIdFormat("task#283", "display")).toBe("md#283");
    });

    test("should return null for invalid input", () => {
      expect(convertTaskIdFormat("abc", "storage")).toBeNull();
      expect(convertTaskIdFormat("abc", "display")).toBeNull();
      expect(convertTaskIdFormat("", "storage")).toBeNull();
      expect(convertTaskIdFormat("", "display")).toBeNull();
    });
  });

  describe("isValidTaskIdInput", () => {
    test("should accept valid formats", () => {
      expect(isValidTaskIdInput("283")).toBe(true);
      expect(isValidTaskIdInput("#283")).toBe(true);
      expect(isValidTaskIdInput("task#283")).toBe(true);
      expect(isValidTaskIdInput("001")).toBe(true);
      expect(isValidTaskIdInput("#001")).toBe(true);
      expect(isValidTaskIdInput("0")).toBe(true);
    });

    test("should reject invalid formats", () => {
      expect(isValidTaskIdInput("")).toBe(false);
      expect(isValidTaskIdInput("abc")).toBe(false);
      expect(isValidTaskIdInput("283abc")).toBe(false);
      expect(isValidTaskIdInput("#abc")).toBe(false);
      expect(isValidTaskIdInput("##283")).toBe(true); // Multiple # are stripped, so this is valid
    });
  });

  describe("getTaskIdNumber", () => {
    test("should extract numbers from valid formats", () => {
      expect(getTaskIdNumber("283")).toBe(283);
      expect(getTaskIdNumber("#283")).toBe(283);
      expect(getTaskIdNumber("task#283")).toBe(283);
      expect(getTaskIdNumber("001")).toBe(1);
      expect(getTaskIdNumber("#001")).toBe(1);
      expect(getTaskIdNumber("0")).toBe(0);
    });

    test("should return null for invalid formats", () => {
      expect(getTaskIdNumber("")).toBeNull();
      expect(getTaskIdNumber("abc")).toBeNull();
      expect(getTaskIdNumber("283abc")).toBeNull();
      expect(getTaskIdNumber("#abc")).toBeNull();
    });

    test("should handle leading zeros correctly", () => {
      expect(getTaskIdNumber("000")).toBe(0);
      expect(getTaskIdNumber("007")).toBe(7);
      expect(getTaskIdNumber("#007")).toBe(7);
    });
  });

  describe("integration scenarios", () => {
    test("should handle full workflow: input -> storage -> display (PERMISSIVE IN, STRICT OUT)", () => {
      const userInputs = ["283", "#283", "task#283", "  #283  "];

      for (const input of userInputs) {
        // Normalize for storage (qualified format)
        const storageId = normalizeTaskIdForStorage(input);
        expect(storageId).toBe("md#283");

        // Format for display (same as storage - qualified format)
        const displayId = formatTaskIdForDisplay(storageId!);
        expect(displayId).toBe("md#283");

        // Verify format detection
        expect(isStorageFormat(storageId!)).toBe(true);
        expect(isDisplayFormat(displayId)).toBe(true);
      }
    });

    test("should maintain data consistency with qualified format", () => {
      const testCases = [
        { input: "1", storage: "md#1", display: "md#1", number: 1 },
        { input: "#064", storage: "md#064", display: "md#064", number: 64 },
        { input: "task#283", storage: "md#283", display: "md#283", number: 283 },
      ];

      for (const testCase of testCases) {
        expect(normalizeTaskIdForStorage(testCase.input)).toBe(testCase.storage);
        expect(formatTaskIdForDisplay(testCase.storage)).toBe(testCase.display);
        expect(getTaskIdNumber(testCase.input)).toBe(testCase.number);
        expect(isValidTaskIdInput(testCase.input)).toBe(true);
      }
    });
  });
});
