import { describe, expect, test } from "bun:test";

import { DeploymentWaitTimeoutError, isTerminalStatus, type DeploymentStatus } from "./types";

describe("isTerminalStatus", () => {
  const cases: { status: DeploymentStatus; expected: boolean }[] = [
    { status: "SUCCESS", expected: true },
    { status: "FAILED", expected: true },
    { status: "CANCELLED", expected: true },
    { status: "CRASHED", expected: true },
    { status: "BUILDING", expected: false },
    { status: "DEPLOYING", expected: false },
    { status: "UNKNOWN", expected: false },
  ];

  for (const { status, expected } of cases) {
    test(`${status} → ${expected}`, () => {
      expect(isTerminalStatus(status)).toBe(expected);
    });
  }
});

describe("DeploymentWaitTimeoutError", () => {
  test("carries timeout and last status", () => {
    const err = new DeploymentWaitTimeoutError(600, "BUILDING", null);
    expect(err.timeoutSeconds).toBe(600);
    expect(err.lastStatus).toBe("BUILDING");
    expect(err.lastRecord).toBeNull();
    expect(err.message).toContain("600s");
    expect(err.message).toContain("BUILDING");
    expect(err.name).toBe("DeploymentWaitTimeoutError");
  });

  test("preserves last record when provided", () => {
    const record = {
      id: "dep-1",
      status: "BUILDING" as const,
      commitHash: "abc1234",
      commitMessage: "fix: thing",
      createdAt: "2026-05-11T20:00:00Z",
      finishedAt: null,
      durationMs: null,
      url: null,
    };
    const err = new DeploymentWaitTimeoutError(60, "BUILDING", record);
    expect(err.lastRecord).toBe(record);
  });
});
