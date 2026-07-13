/**
 * Tests for the error fingerprint heuristic (mt#1484).
 *
 * Pins the v1 fingerprint behaviour so observation-only calibration data is
 * comparable across the calibration window. Any change to the heuristic that
 * affects whether two errors collide must update these tests.
 */

import { describe, expect, test } from "bun:test";
import { fingerprintError, normalizeErrorMessage, errorTypeOf } from "./fingerprint";

const TOOL_NAME = "Bash";
const PERM_DENIED = "permission denied";

describe("normalizeErrorMessage", () => {
  test("lowercases and trims whitespace", () => {
    expect(normalizeErrorMessage("  Permission Denied  ")).toBe("permission denied");
  });

  test("collapses internal whitespace runs to single spaces", () => {
    expect(normalizeErrorMessage("Error:\n\n  too\tmany   spaces")).toBe("error: too many spaces");
  });

  test("extracts message from Error instance", () => {
    expect(normalizeErrorMessage(new Error("File not found"))).toBe("file not found");
  });

  test("preserves named Error subclasses' messages", () => {
    class CustomError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "CustomError";
      }
    }
    expect(normalizeErrorMessage(new CustomError("nope"))).toBe("nope");
  });

  test("normalises null and undefined to literal strings", () => {
    expect(normalizeErrorMessage(null)).toBe("null");
    expect(normalizeErrorMessage(undefined)).toBe("undefined");
  });

  test("JSON-stringifies object errors", () => {
    expect(normalizeErrorMessage({ code: "ENOENT" })).toBe('{"code":"enoent"}');
  });
});

describe("errorTypeOf", () => {
  test("returns Error.name for Error instances", () => {
    expect(errorTypeOf(new Error("x"))).toBe("Error");
    expect(errorTypeOf(new TypeError("x"))).toBe("TypeError");
  });

  test("returns 'Error' when name is absent or empty", () => {
    const err = new Error("x");
    err.name = "";
    expect(errorTypeOf(err)).toBe("Error");
  });

  test("returns null/undefined as discrete types", () => {
    expect(errorTypeOf(null)).toBe("null");
    expect(errorTypeOf(undefined)).toBe("undefined");
  });

  test("returns typeof for non-Error values", () => {
    expect(errorTypeOf("oops")).toBe("string");
    expect(errorTypeOf(42)).toBe("number");
    expect(errorTypeOf({ code: "x" })).toBe("object");
  });
});

describe("fingerprintError", () => {
  test("identical inputs produce identical hashes", () => {
    const a = fingerprintError(TOOL_NAME, new Error(PERM_DENIED));
    const b = fingerprintError(TOOL_NAME, new Error(PERM_DENIED));
    expect(a.hash).toBe(b.hash);
  });

  test("different tool names produce different hashes for the same error", () => {
    const a = fingerprintError("Bash", new Error(PERM_DENIED));
    const b = fingerprintError("Edit", new Error(PERM_DENIED));
    expect(a.hash).not.toBe(b.hash);
  });

  test("different error types produce different hashes for the same message", () => {
    const a = fingerprintError(TOOL_NAME, new Error("oops"));
    const b = fingerprintError(TOOL_NAME, new TypeError("oops"));
    expect(a.hash).not.toBe(b.hash);
  });

  test("different messages produce different hashes", () => {
    const a = fingerprintError(TOOL_NAME, new Error("not found"));
    const b = fingerprintError(TOOL_NAME, new Error(PERM_DENIED));
    expect(a.hash).not.toBe(b.hash);
  });

  test("normalisation collapses casing and whitespace differences", () => {
    const a = fingerprintError(TOOL_NAME, new Error("Permission   Denied"));
    const b = fingerprintError(TOOL_NAME, new Error(PERM_DENIED));
    expect(a.hash).toBe(b.hash);
  });

  test("populates all fingerprint fields", () => {
    const fp = fingerprintError(TOOL_NAME, new Error("File Not Found"));
    expect(fp.toolName).toBe(TOOL_NAME);
    expect(fp.errorType).toBe("Error");
    expect(fp.normalizedMessage).toBe("file not found");
    expect(fp.hash).toMatch(/^[a-f0-9]{40}$/);
  });

  // Calibration risk: timestamps/UUIDs/paths are intentionally NOT stripped at
  // v1. This test pins that deliberate under-fire so we know to revisit if
  // calibration data shows it's a problem.
  test("v1 heuristic does NOT strip noise tokens (under-fires by design)", () => {
    const a = fingerprintError(TOOL_NAME, new Error("connection refused at 2026-05-01T04:00:00Z"));
    const b = fingerprintError(TOOL_NAME, new Error("connection refused at 2026-05-01T05:00:00Z"));
    // Different timestamps → different hashes today. This is the calibration
    // signal: if observation-only data shows this case is common, mt#1484
    // follow-up adds noise stripping.
    expect(a.hash).not.toBe(b.hash);
  });
});
