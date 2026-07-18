/**
 * Isolation tests for scripts/rationalization-review.ts (mt#2901 review R1
 * BLOCKING #2). Spawns the REAL script as a subprocess with `MINSKY_STATE_DIR`
 * / `CLAUDE_PROJECT_DIR` pointed at an isolated temp directory (never the
 * developer's real `~/.local/state/minsky/` — mt#2876 discipline) and asserts
 * the configured state dir's fire-log content is unchanged (checksum
 * before/after) across a dry run, and that `--execute` appends EXACTLY the
 * one expected self-review record and nothing else.
 *
 * This is the structural verification that the canary suite's own subprocess
 * isolation (see the script's module doc comment) does not leak into —
 * or get leaked into by — this script's real-state reads/writes: if the
 * canary subprocess's env somehow bled back into this process, or if this
 * script's real reads/writes ran against the wrong directory, either test
 * below would fail.
 *
 * @see mt#2901 — this task
 * @see scripts/rationalization-review.ts — the script under test
 */

/* eslint-disable custom/no-real-fs-in-tests -- this test's ENTIRE PURPOSE is
   proving a real-fs isolation property (a spawned subprocess never touches a
   directory outside the one it was configured to use) — a real mkdtemp
   scratch directory, real seed/checksum reads, and a real subprocess spawn
   are the point, not something to mock away. Mirrors
   .minsky/hooks/guard-health-write-isolation.test.ts's identical rationale
   for the identical class of regression test. */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT_PATH = join(import.meta.dir, "rationalization-review.ts");
const SEED_RECORD = `${JSON.stringify({
  timestamp: "2026-01-01T00:00:00.000Z",
  guardName: "seed-guard",
  event: "PreToolUse",
  decision: "allow",
  durationMs: 1,
})}\n`;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runScript(stateDir: string, args: string[]): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, SCRIPT_PATH, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, MINSKY_STATE_DIR: stateDir, CLAUDE_PROJECT_DIR: stateDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("scripts/rationalization-review.ts isolation (mt#2876 discipline)", () => {
  test("dry run (default, no --execute) never mutates the configured state dir's fire-log", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "mt2901-rr-isolation-dry-"));
    const logPath = join(stateDir, "fire-log.jsonl");
    writeFileSync(logPath, SEED_RECORD);
    const before = readFileSync(logPath, "utf-8");

    try {
      const result = await runScript(stateDir, ["--json"]);
      expect(result.exitCode).toBe(0);
      expect(() => JSON.parse(result.stdout)).not.toThrow();

      const after = readFileSync(logPath, "utf-8");
      expect(after).toBe(before);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 60000);

  test("--execute appends exactly ONE self-review record to the configured state dir, nothing else", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "mt2901-rr-isolation-exec-"));
    const logPath = join(stateDir, "fire-log.jsonl");
    writeFileSync(logPath, SEED_RECORD);

    try {
      const result = await runScript(stateDir, ["--execute", "--json"]);
      expect(result.exitCode).toBe(0);

      const lines = readFileSync(logPath, "utf-8")
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
      // The seed record + exactly one new self-review record.
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(SEED_RECORD.trim());

      const appended = JSON.parse(lines[1] ?? "{}") as {
        guardName?: string;
        event?: string;
        decision?: string;
      };
      expect(appended.guardName).toBe("rationalization-review");
      expect(appended.event).toBe("Review");
      expect(appended.decision).toBe("allow");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 60000);

  test("the canary subprocess never writes anything into the CALLER's configured state dir", async () => {
    // A stricter variant of the dry-run test: this state dir has NOTHING in
    // it at all (not even a seed file) — if the canary subprocess's own
    // isolation leaked (wrote a priming fixture, a stray file, etc.) into
    // the caller's env instead of its own temp sandbox, this would produce
    // an unexpected file/directory here.
    const stateDir = mkdtempSync(join(tmpdir(), "mt2901-rr-isolation-empty-"));

    try {
      const result = await runScript(stateDir, ["--json"]);
      expect(result.exitCode).toBe(0);

      const { readdirSync } = await import("node:fs");
      const entries = readdirSync(stateDir);
      expect(entries).toEqual([]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 60000);
});
