// mt#3072 — end-to-end reproduction of the standalone-duplicate-matcher
// probe-failure mode: simulate a probe failure through the REAL entrypoint
// (`runStandaloneDuplicateGuardInner`, not just the pure decision function),
// through the REAL `recordGuardCheckSkip` call, into a real (temp) guard-health
// log, then read it back and assert the recorded event carries a diagnosable
// message and a causeClass — never the pre-mt#2958 generic "tasks_search
// failed or returned unparseable output ... see stderr" boilerplate that made
// the 2026-07-19 -> 07-22 incident undiagnosable from the log alone.
//
// This is `.minsky/hooks/`'s dependency-free-tree pattern: real fs, an
// isolated MINSKY_STATE_DIR (never the developer's real state dir), no
// module mocking (the probe's own fetchSimilar dependency is injected via
// `runStandaloneDuplicateGuardInner`'s exported deps param, mt#3072).

/* eslint-disable custom/no-real-fs-in-tests -- isolated mkdtemp scratch dir,
   same pattern as guard-health-write-isolation.test.ts / the escalation
   detector's real-log test. */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStandaloneDuplicateGuardInner } from "./parallel-work-guard-standalone";
import { readGuardHealthEvents } from "./guard-health";
import type { ToolHookInput } from "./types";

function tasksCreateInput(): ToolHookInput {
  return {
    session_id: "mt3072-repro-session",
    cwd: "/repo",
    hook_event_name: "PreToolUse",
    tool_name: "tasks_create",
    tool_input: { title: "Some new standalone task" },
  };
}

describe("runStandaloneDuplicateGuardInner -> guard-health log (mt#3072 AT1)", () => {
  test("a probe failure lands a diagnosable check-skip event — not the generic pre-mt#2958 boilerplate", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "mt3072-standalone-health-log-"));
    const prevStateDir = process.env.MINSKY_STATE_DIR;
    process.env.MINSKY_STATE_DIR = scratchDir;
    try {
      await runStandaloneDuplicateGuardInner(tasksCreateInput(), {
        fetchSimilar: () => ({
          failed: "write CONNECT_TIMEOUT 192.0.2.1:5432",
          causeClass: "infra",
        }),
      });

      const events = readGuardHealthEvents();
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event?.guardName).toBe("standalone-duplicate-matcher");
      expect(event?.kind).toBe("check-skip");
      // The diagnosable content: the ACTUAL underlying error, not a generic
      // "see stderr" pointer with zero content in the persisted record.
      expect(event?.message).toContain("write CONNECT_TIMEOUT 192.0.2.1:5432");
      expect(event?.message).not.toBe(
        "tasks_search failed or returned unparseable output — the standalone-duplicate probe is " +
          "SKIPPED for this create (see stderr for the CLI failure detail)"
      );
      expect(event?.causeClass).toBe("infra");
      expect(event?.sessionId).toBe("mt3072-repro-session");
    } finally {
      if (prevStateDir === undefined) delete process.env.MINSKY_STATE_DIR;
      else process.env.MINSKY_STATE_DIR = prevStateDir;
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  test("a probe-logic failure (unanticipated) lands causeClass 'logic'", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "mt3072-standalone-health-log-logic-"));
    const prevStateDir = process.env.MINSKY_STATE_DIR;
    process.env.MINSKY_STATE_DIR = scratchDir;
    try {
      await runStandaloneDuplicateGuardInner(tasksCreateInput(), {
        fetchSimilar: () => ({
          failed: "Cannot read properties of undefined (reading 'id')",
          causeClass: "logic",
        }),
      });

      const events = readGuardHealthEvents();
      expect(events).toHaveLength(1);
      expect(events[0]?.causeClass).toBe("logic");
    } finally {
      if (prevStateDir === undefined) delete process.env.MINSKY_STATE_DIR;
      else process.env.MINSKY_STATE_DIR = prevStateDir;
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  test("a warn/permit decision records NOTHING to the health log (only skips are health events)", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "mt3072-standalone-health-log-permit-"));
    const prevStateDir = process.env.MINSKY_STATE_DIR;
    process.env.MINSKY_STATE_DIR = scratchDir;
    try {
      await runStandaloneDuplicateGuardInner(tasksCreateInput(), {
        fetchSimilar: () => ({ results: [], degraded: false }),
      });
      expect(readGuardHealthEvents()).toHaveLength(0);
    } finally {
      if (prevStateDir === undefined) delete process.env.MINSKY_STATE_DIR;
      else process.env.MINSKY_STATE_DIR = prevStateDir;
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
