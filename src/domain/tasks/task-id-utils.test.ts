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

describe("Task ID Utilities - Strict In/Out", () => {
  describe("normalizeTaskIdForStorage (strict)", () => {
    test("should return same for qualified formats", () => {
      expect(normalizeTaskIdForStorage("md#283")).toBe("md#283");
      expect(normalizeTaskIdForStorage("gh#001")).toBe("gh#001");
      expect(normalizeTaskIdForStorage("task#64")).toBe("task#64");
    });

    test("should return null for non-qualified formats", () => {
      expect(normalizeTaskIdForStorage("283")).toBeNull();
      expect(normalizeTaskIdForStorage("#283")).toBeNull();
      expect(normalizeTaskIdForStorage("##283")).toBeNull();
      expect(normalizeTaskIdForStorage("  #64  ")).toBeNull();
      expect(normalizeTaskIdForStorage("")).toBeNull();
      expect(normalizeTaskIdForStorage("   ")).toBeNull();
      expect(normalizeTaskIdForStorage("abc")).toBeNull();
      expect(normalizeTaskIdForStorage("283abc")).toBeNull();
      expect(normalizeTaskIdForStorage(null as any)).toBeNull();
      expect(normalizeTaskIdForStorage(undefined as any)).toBeNull();
      expect(normalizeTaskIdForStorage(123 as any)).toBeNull();
    });
  });

  describe("formatTaskIdForDisplay (strict)", () => {
    test("should return same for qualified formats", () => {
      expect(formatTaskIdForDisplay("md#283")).toBe("md#283");
      expect(formatTaskIdForDisplay("gh#001")).toBe("gh#001");
    });

    test("should return empty for non-qualified input", () => {
      expect(formatTaskIdForDisplay("283")).toBe("");
      expect(formatTaskIdForDisplay("#283")).toBe("");
      expect(formatTaskIdForDisplay("0")).toBe("");
    });

    test("should handle invalid input", () => {
      expect(formatTaskIdForDisplay("")).toBe("");
      expect(formatTaskIdForDisplay(null as any)).toBe("");
      expect(formatTaskIdForDisplay(undefined as any)).toBe("");
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

  describe("convertTaskIdFormat (strict)", () => {
    test("should return same for qualified input", () => {
      expect(convertTaskIdFormat("md#283", "storage")).toBe("md#283");
      expect(convertTaskIdFormat("gh#283", "display")).toBe("gh#283");
    });

    test("should return null for non-qualified input", () => {
      expect(convertTaskIdFormat("283", "storage")).toBeNull();
      expect(convertTaskIdFormat("#283", "display")).toBeNull();
      expect(convertTaskIdFormat("", "storage")).toBeNull();
      expect(convertTaskIdFormat("abc", "display")).toBeNull();
    });
  });

  describe("isValidTaskIdInput (strict)", () => {
    test("should accept qualified formats", () => {
      expect(isValidTaskIdInput("md#283")).toBe(true);
      expect(isValidTaskIdInput("gh#001")).toBe(true);
      expect(isValidTaskIdInput("task#283")).toBe(true);
    });

    test("should reject non-qualified formats", () => {
      expect(isValidTaskIdInput("")).toBe(false);
      expect(isValidTaskIdInput("283")).toBe(false);
      expect(isValidTaskIdInput("#283")).toBe(false);
      expect(isValidTaskIdInput("abc")).toBe(false);
      expect(isValidTaskIdInput("##283")).toBe(false);
    });
  });

  describe("getTaskIdNumber (strict)", () => {
    test("should extract numbers from qualified formats", () => {
      expect(getTaskIdNumber("md#283")).toBe(283);
      expect(getTaskIdNumber("gh#001")).toBe(1);
      expect(getTaskIdNumber("task#007")).toBe(7);
    });

    test("should return null for non-qualified formats", () => {
      expect(getTaskIdNumber("")).toBeNull();
      expect(getTaskIdNumber("abc")).toBeNull();
      expect(getTaskIdNumber("283abc")).toBeNull();
      expect(getTaskIdNumber("#abc")).toBeNull();
      expect(getTaskIdNumber("283")).toBeNull();
      expect(getTaskIdNumber("#283")).toBeNull();
    });
  });

  describe("integration scenarios (strict)", () => {
    test("should require qualified input across workflow", () => {
      const userInputs = ["md#283", "gh#283", "task#283"];

      for (const input of userInputs) {
        const storageId = normalizeTaskIdForStorage(input);
        expect(storageId).toBe(input);

        const displayId = formatTaskIdForDisplay(storageId!);
        expect(displayId).toBe(input);

        expect(isStorageFormat(storageId!)).toBe(true);
        expect(isDisplayFormat(displayId)).toBe(true);
      }
    });
  });
});
