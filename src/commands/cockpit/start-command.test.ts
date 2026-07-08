/**
 * Unit tests for the exported helpers in start-command.ts (gh#1761 R1).
 *
 * `isDbDegradationError` is extracted and exported specifically so it can be
 * tested in isolation — confirming that the `unhandledRejection` handler
 * degrades gracefully for DB errors but still exits for unrelated errors.
 */
import { describe, test, expect } from "bun:test";
import { isDbDegradationError } from "./start-command";
import { PersistenceInitTimeoutError } from "../../cockpit/shared-persistence";

describe("isDbDegradationError (gh#1761 R1)", () => {
  // DB-error branch: handler must return true so the daemon stays up.
  test("returns true for ECIRCUITBREAKER code", () => {
    expect(isDbDegradationError({ code: "ECIRCUITBREAKER" })).toBe(true);
  });

  test("returns true for EDBHANDLEREXITED code", () => {
    expect(isDbDegradationError({ code: "EDBHANDLEREXITED" })).toBe(true);
  });

  test("returns true for CONNECTION_CLOSED code", () => {
    expect(isDbDegradationError({ code: "CONNECTION_CLOSED" })).toBe(true);
  });

  test("returns true for CONNECTION_DESTROYED code", () => {
    expect(isDbDegradationError({ code: "CONNECTION_DESTROYED" })).toBe(true);
  });

  test("returns true for PersistenceInitTimeoutError", () => {
    expect(isDbDegradationError(new PersistenceInitTimeoutError(5000))).toBe(true);
  });

  // Non-DB-error branch: handler must return false so the daemon exits.
  test("returns false for a plain Error (programming bug)", () => {
    expect(isDbDegradationError(new Error("something exploded"))).toBe(false);
  });

  test("returns false for an unknown error code", () => {
    expect(isDbDegradationError({ code: "SOME_UNRELATED_ERROR" })).toBe(false);
  });

  test("returns false for null", () => {
    expect(isDbDegradationError(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isDbDegradationError(undefined)).toBe(false);
  });

  test("returns false for a string", () => {
    expect(isDbDegradationError("some string error")).toBe(false);
  });

  test("returns false for an object without a code property", () => {
    expect(isDbDegradationError({ message: "no code here" })).toBe(false);
  });
});
