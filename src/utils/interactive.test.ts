/**
 * Tests for the isInteractive() utility function.
 *
 * Because isInteractive() reads process.env at call time (not import time),
 * we can test it by setting env vars before each call.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { isInteractive } from "./interactive";

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    MINSKY_NON_INTERACTIVE: process.env.MINSKY_NON_INTERACTIVE,
    CI: process.env.CI,
    TERM: process.env.TERM,
  };
  // Clear all relevant env vars before each test
  delete process.env.MINSKY_NON_INTERACTIVE;
  delete process.env.CI;
  delete process.env.TERM;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key as keyof NodeJS.ProcessEnv];
    } else {
      process.env[key as keyof NodeJS.ProcessEnv] = value;
    }
  }
});

describe("isInteractive", () => {
  test("returns false when MINSKY_NON_INTERACTIVE=1", () => {
    process.env.MINSKY_NON_INTERACTIVE = "1";
    expect(isInteractive()).toBe(false);
  });

  test("returns false when MINSKY_NON_INTERACTIVE=true", () => {
    process.env.MINSKY_NON_INTERACTIVE = "true";
    expect(isInteractive()).toBe(false);
  });

  test("returns false when CI=true", () => {
    process.env.CI = "true";
    expect(isInteractive()).toBe(false);
  });

  test("returns false when CI=1", () => {
    process.env.CI = "1";
    expect(isInteractive()).toBe(false);
  });

  test("returns false when TERM=dumb", () => {
    process.env.TERM = "dumb";
    expect(isInteractive()).toBe(false);
  });

  test("MINSKY_NON_INTERACTIVE takes precedence over CI being absent", () => {
    process.env.MINSKY_NON_INTERACTIVE = "1";
    // Even with no CI env var, MINSKY_NON_INTERACTIVE alone triggers non-interactive
    expect(isInteractive()).toBe(false);
  });

  test("returns false when stdout is not a TTY (typical in test/CI environments)", () => {
    // In test environments, stdout is not a TTY, so this should return false
    // regardless of env vars (since isTTY check comes last)
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      expect(isInteractive()).toBe(false);
    } else {
      // In a real TTY environment with no env vars set, it returns true
      expect(isInteractive()).toBe(true);
    }
  });
});
