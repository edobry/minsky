/**
 * Tests for AppleScript permission-error classification (mt#2285).
 *
 * Per the task's hard sandbox constraint, these tests NEVER invoke real
 * AppleScript -- they construct the CommandExecResult shape directly and
 * verify the classifier's string-matching logic against it.
 */
import { describe, test, expect } from "bun:test";
import { isAppleScriptPermissionError, appleScriptPermissionMessage } from "./executor";
import type { CommandExecResult } from "./types";

describe("isAppleScriptPermissionError", () => {
  test("returns false when exitCode is 0", () => {
    const result: CommandExecResult = { exitCode: 0, stdout: "", stderr: "" };
    expect(isAppleScriptPermissionError(result)).toBe(false);
  });

  test("detects the -1743 errAEEventNotPermitted OSStatus in stderr", () => {
    const result: CommandExecResult = {
      exitCode: 1,
      stdout: "",
      stderr: "execution error: Not authorized to send Apple events to iTerm2. (-1743)",
    };
    expect(isAppleScriptPermissionError(result)).toBe(true);
  });

  test("detects the 'not authorized to send apple events' message text case-insensitively", () => {
    const result: CommandExecResult = {
      exitCode: 1,
      stdout: "",
      stderr: "NOT AUTHORIZED TO SEND APPLE EVENTS to Terminal.",
    };
    expect(isAppleScriptPermissionError(result)).toBe(true);
  });

  test("returns false for an unrelated osascript failure", () => {
    const result: CommandExecResult = {
      exitCode: 1,
      stdout: "",
      stderr: "execution error: Can't get window 1. (-1728)",
    };
    expect(isAppleScriptPermissionError(result)).toBe(false);
  });
});

describe("appleScriptPermissionMessage", () => {
  test("names the app and the remediation path", () => {
    const message = appleScriptPermissionMessage("iTerm2");
    expect(message).toContain("iTerm2");
    expect(message).toContain("System Settings");
    expect(message).toContain("Automation");
  });
});
