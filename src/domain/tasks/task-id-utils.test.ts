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
    test("should convert display format to storage format", () => {
      expect(normalizeTaskIdForStorage("#283")).toBe("283");
      expect(normalizeTaskIdForStorage("#001")).toBe("001");
      expect(normalizeTaskIdForStorage("#64")).toBe("64");
    });

    test("should keep storage format as-is", () => {
      expect(normalizeTaskIdForStorage("283")).toBe("283");
      expect(normalizeTaskIdForStorage("001")).toBe("001");
      expect(normalizeTaskIdForStorage("64")).toBe("64");
    });

    test("should handle task# prefix", () => {
      expect(normalizeTaskIdForStorage("task#283")).toBe("283");
      expect(normalizeTaskIdForStorage("task#001")).toBe("001");
      expect(normalizeTaskIdForStorage("task#64")).toBe("64");
    });

    test("should handle whitespace", () => {
      expect(normalizeTaskIdForStorage("  #283  ")).toBe("283");
      expect(normalizeTaskIdForStorage("  283  ")).toBe("283");
      expect(normalizeTaskIdForStorage("  task#283  ")).toBe("283");
    });

    test("should return null for invalid input", () => {
      expect(normalizeTaskIdForStorage("")).toBeNull();
      expect(normalizeTaskIdForStorage("abc")).toBeNull();
      expect(normalizeTaskIdForStorage("#abc")).toBeNull();
      expect(normalizeTaskIdForStorage("283abc")).toBeNull();
      expect(normalizeTaskIdForStorage("#283abc")).toBeNull();
      expect(normalizeTaskIdForStorage("-283")).toBeNull();
      expect(normalizeTaskIdForStorage("0")).toBe("0"); // 0 is valid
    });

    test("should return null for non-string input", () => {
      expect(normalizeTaskIdForStorage(null as any)).toBeNull();
      expect(normalizeTaskIdForStorage(undefined as any)).toBeNull();
      expect(normalizeTaskIdForStorage(283 as any)).toBeNull();
    });
  });

  describe("formatTaskIdForDisplay", () => {
    test("should add # prefix to storage format", () => {
      expect(formatTaskIdForDisplay("283")).toBe("#283");
      expect(formatTaskIdForDisplay("001")).toBe("#001");
      expect(formatTaskIdForDisplay("64")).toBe("#64");
    });

    test("should handle numeric input", () => {
      expect(formatTaskIdForDisplay(283)).toBe("#283");
      expect(formatTaskIdForDisplay(1)).toBe("#1");
      expect(formatTaskIdForDisplay(0)).toBe("#0");
    });

    test("should preserve existing # prefix", () => {
      expect(formatTaskIdForDisplay("#283")).toBe("#283");
      expect(formatTaskIdForDisplay("#001")).toBe("#001");
      expect(formatTaskIdForDisplay("#64")).toBe("#64");
    });

    test("should handle edge cases", () => {
      expect(formatTaskIdForDisplay("")).toBe("#unknown");
      expect(formatTaskIdForDisplay(null as any)).toBe("#unknown");
      expect(formatTaskIdForDisplay(undefined as any)).toBe("#unknown");
    });
  });

  describe("isStorageFormat", () => {
    test("should identify storage format correctly", () => {
      expect(isStorageFormat("283")).toBe(true);
      expect(isStorageFormat("001")).toBe(true);
      expect(isStorageFormat("64")).toBe(true);
      expect(isStorageFormat("0")).toBe(true);
    });

    test("should reject display format", () => {
      expect(isStorageFormat("#283")).toBe(false);
      expect(isStorageFormat("#001")).toBe(false);
      expect(isStorageFormat("#64")).toBe(false);
    });

    test("should reject invalid formats", () => {
      expect(isStorageFormat("")).toBe(false);
      expect(isStorageFormat("abc")).toBe(false);
      expect(isStorageFormat("283abc")).toBe(false);
      expect(isStorageFormat("task#283")).toBe(false);
    });

    test("should handle whitespace", () => {
      expect(isStorageFormat("  283  ")).toBe(true);
      expect(isStorageFormat("  #283  ")).toBe(false);
    });
  });

  describe("isDisplayFormat", () => {
    test("should identify display format correctly", () => {
      expect(isDisplayFormat("#283")).toBe(true);
      expect(isDisplayFormat("#001")).toBe(true);
      expect(isDisplayFormat("#64")).toBe(true);
      expect(isDisplayFormat("#0")).toBe(true);
    });

    test("should reject storage format", () => {
      expect(isDisplayFormat("283")).toBe(false);
      expect(isDisplayFormat("001")).toBe(false);
      expect(isDisplayFormat("64")).toBe(false);
    });

    test("should reject invalid formats", () => {
      expect(isDisplayFormat("")).toBe(false);
      expect(isDisplayFormat("#")).toBe(false);
      expect(isDisplayFormat("#abc")).toBe(false);
      expect(isDisplayFormat("#283abc")).toBe(false);
      expect(isDisplayFormat("task#283")).toBe(false);
    });

    test("should handle whitespace", () => {
      expect(isDisplayFormat("  #283  ")).toBe(true);
      expect(isDisplayFormat("  283  ")).toBe(false);
    });
  });

  describe("convertTaskIdFormat", () => {
    test("should convert to storage format", () => {
      expect(convertTaskIdFormat("#283", "storage")).toBe("283");
      expect(convertTaskIdFormat("283", "storage")).toBe("283");
      expect(convertTaskIdFormat("task#283", "storage")).toBe("283");
    });

    test("should convert to display format", () => {
      expect(convertTaskIdFormat("283", "display")).toBe("#283");
      expect(convertTaskIdFormat("#283", "display")).toBe("#283");
      expect(convertTaskIdFormat("task#283", "display")).toBe("#283");
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
      expect(isValidTaskIdInput("0")).toBe(true);
      expect(isValidTaskIdInput("#0")).toBe(true);
    });

    test("should reject invalid formats", () => {
      expect(isValidTaskIdInput("")).toBe(false);
      expect(isValidTaskIdInput("abc")).toBe(false);
      expect(isValidTaskIdInput("#abc")).toBe(false);
      expect(isValidTaskIdInput("283abc")).toBe(false);
      expect(isValidTaskIdInput("#283abc")).toBe(false);
      expect(isValidTaskIdInput("-283")).toBe(false);
    });

    test("should handle whitespace", () => {
      expect(isValidTaskIdInput("  283  ")).toBe(true);
      expect(isValidTaskIdInput("  #283  ")).toBe(true);
      expect(isValidTaskIdInput("  task#283  ")).toBe(true);
    });
  });

  describe("getTaskIdNumber", () => {
    test("should extract numeric value from valid formats", () => {
      expect(getTaskIdNumber("283")).toBe(283);
      expect(getTaskIdNumber("#283")).toBe(283);
      expect(getTaskIdNumber("task#283")).toBe(283);
      expect(getTaskIdNumber("0")).toBe(0);
      expect(getTaskIdNumber("#0")).toBe(0);
    });

    test("should return null for invalid formats", () => {
      expect(getTaskIdNumber("")).toBeNull();
      expect(getTaskIdNumber("abc")).toBeNull();
      expect(getTaskIdNumber("#abc")).toBeNull();
      expect(getTaskIdNumber("283abc")).toBeNull();
      expect(getTaskIdNumber("#283abc")).toBeNull();
      expect(getTaskIdNumber("-283")).toBeNull();
    });

    test("should handle leading zeros correctly", () => {
      expect(getTaskIdNumber("001")).toBe(1);
      expect(getTaskIdNumber("#001")).toBe(1);
      expect(getTaskIdNumber("task#001")).toBe(1);
    });

    test("should handle whitespace", () => {
      expect(getTaskIdNumber("  283  ")).toBe(283);
      expect(getTaskIdNumber("  #283  ")).toBe(283);
      expect(getTaskIdNumber("  task#283  ")).toBe(283);
    });
  });

  describe("Integration scenarios", () => {
    test("should handle round-trip conversions", () => {
      const inputs = ["283", "#283", "task#283", "001", "#001"];
      
      for (const input of inputs) {
        const storage = normalizeTaskIdForStorage(input);
        expect(storage).not.toBeNull();
        
        const display = formatTaskIdForDisplay(storage!);
        expect(isDisplayFormat(display)).toBe(true);
        
        const backToStorage = normalizeTaskIdForStorage(display);
        expect(backToStorage).toBe(storage);
      }
    });

    test("should maintain consistency across utilities", () => {
      const testId = "283";
      
      expect(isStorageFormat(testId)).toBe(true);
      expect(isDisplayFormat(testId)).toBe(false);
      expect(isValidTaskIdInput(testId)).toBe(true);
      expect(getTaskIdNumber(testId)).toBe(283);
      
      const display = formatTaskIdForDisplay(testId);
      expect(isStorageFormat(display)).toBe(false);
      expect(isDisplayFormat(display)).toBe(true);
      expect(isValidTaskIdInput(display)).toBe(true);
      expect(getTaskIdNumber(display)).toBe(283);
    });
  });
}); 
