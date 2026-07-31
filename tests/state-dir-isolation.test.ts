/**
 * State-dir isolation contract (mt#2872).
 *
 * The tests/setup.ts preload must point MINSKY_STATE_DIR at a per-run temp
 * dir so no test can write to the operator's real ~/.local/state/minsky —
 * the originating incident had a dispatcher test's default guard-health
 * recorder write fixture rows ("throws"/"boom") into the real log, firing a
 * CRITICAL operator escalation for a guard that doesn't exist.
 */
import { describe, test, expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { getGuardHealthLogPath } from "../.minsky/hooks/guard-health";

const REAL_STATE_DIR = join(homedir(), ".local", "state", "minsky");

describe("test-run state-dir isolation (mt#2872)", () => {
  test("MINSKY_STATE_DIR is set and does not point at the operator's real state dir", () => {
    const dir = process.env.MINSKY_STATE_DIR ?? "";
    expect(dir.length).toBeGreaterThan(0);
    expect(dir.startsWith(REAL_STATE_DIR)).toBe(false);
  });

  test("the guard-health log path resolves inside the isolated state dir", () => {
    const logPath = getGuardHealthLogPath();
    expect(logPath.startsWith(process.env.MINSKY_STATE_DIR ?? "")).toBe(true);
    expect(logPath.startsWith(REAL_STATE_DIR)).toBe(false);
  });
});
