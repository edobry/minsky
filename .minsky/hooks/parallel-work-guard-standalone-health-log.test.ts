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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runStandaloneDuplicateGuard,
  runStandaloneDuplicateGuardInner,
} from "./parallel-work-guard-standalone";
import { STANDALONE_DUP_PROBE_TIMEOUT_MS } from "./standalone-dup-probe";
import { readGuardHealthEvents, readCleanGuardInvocations } from "./guard-health";
import { readFireLogEntries } from "./fire-log";
import type { ToolHookInput } from "./types";

/** The canonical infra-class probe failure these tests simulate. */
const CONNECT_TIMEOUT_ERROR = "write CONNECT_TIMEOUT 192.0.2.1:5432";

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
          failed: CONNECT_TIMEOUT_ERROR,
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
      expect(event?.message).toContain(CONNECT_TIMEOUT_ERROR);
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

// ---------------------------------------------------------------------------
// mt#3358 — a fail-open skip must be diagnosable AFTER the fact (SC3) and
// visible AT the create (SC2).
// ---------------------------------------------------------------------------

/**
 * Run `fn` with stdout captured, so `writeOutput`'s JSON can be asserted on.
 *
 * The shim accepts `write`'s FULL signature — `(chunk, encoding?, cb?)` — rather
 * than just `(chunk)` (mt#3439). A single-argument shim silently drops a trailing
 * completion callback, so a caller that passes one waits on a callback that never
 * fires: the failure is a hang or a swallowed write, neither of which points at
 * this helper. `encoding` is deliberately ignored (every write under test is a
 * string), but the callback is always invoked.
 */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, encodingOrCb?: unknown, maybeCb?: unknown): boolean => {
    chunks.push(String(chunk));
    const cb = typeof encodingOrCb === "function" ? encodingOrCb : maybeCb;
    if (typeof cb === "function") (cb as (err?: Error | null) => void)(null);
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

/** Run `fn` against an isolated MINSKY_STATE_DIR, cleaning up after. */
async function withScratchStateDir(label: string, fn: () => Promise<void>): Promise<void> {
  const scratchDir = mkdtempSync(join(tmpdir(), label));
  const prevStateDir = process.env.MINSKY_STATE_DIR;
  process.env.MINSKY_STATE_DIR = scratchDir;
  try {
    await fn();
  } finally {
    if (prevStateDir === undefined) delete process.env.MINSKY_STATE_DIR;
    else process.env.MINSKY_STATE_DIR = prevStateDir;
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

/**
 * The deadline fragment both the fixture and its assertions are built from
 * (mt#3439). Derived from `STANDALONE_DUP_PROBE_TIMEOUT_MS` rather than written
 * as a literal: that constant is expected to be re-grounded again as the probe's
 * latency profile changes (mt#3358 already moved it 8000 -> 20000). A literal
 * would leave the production reason string moving while these assertions stayed
 * behind, failing spuriously and pointing at the test instead of at anything real.
 */
const DEADLINE_FRAGMENT = `${STANDALONE_DUP_PROBE_TIMEOUT_MS}ms deadline`;

const TIMED_OUT_PROBE = {
  failed: `in-process probe exceeded the ${DEADLINE_FRAGMENT}`,
  causeClass: "infra" as const,
};

describe("captureStdout shim (mt#3439)", () => {
  test("invokes a trailing completion callback instead of dropping it", async () => {
    let fired = false;
    const out = await captureStdout(async () => {
      process.stdout.write("payload", () => {
        fired = true;
      });
    });

    // A single-argument shim would swallow the callback: the write still lands,
    // so the only symptom is a caller waiting forever on a callback that never
    // fires — which looks like a hang anywhere but here.
    expect(fired).toBe(true);
    expect(out).toBe("payload");
  });

  test("invokes the callback when an encoding is passed between chunk and callback", async () => {
    let fired = false;
    const out = await captureStdout(async () => {
      process.stdout.write("encoded", "utf8", () => {
        fired = true;
      });
    });

    expect(fired).toBe(true);
    expect(out).toBe("encoded");
  });
});

describe("standalone-duplicate guard — fail-open visibility (mt#3358)", () => {
  test("SC3: the check-skip event names WHICH create went unchecked", async () => {
    await withScratchStateDir("mt3358-subject-", async () => {
      await runStandaloneDuplicateGuardInner(tasksCreateInput(), {
        fetchSimilar: () => TIMED_OUT_PROBE,
      });

      const [event] = readGuardHealthEvents();
      // Before this, the log recorded only toolName + sessionId — enough to say
      // "some create in this session went unchecked", not WHICH one.
      expect(event?.subject).toBe("Some new standalone task");
    });
  });

  test("SC3: the subject is capped, since the health log is a diagnostic not an archive", async () => {
    await withScratchStateDir("mt3358-subject-cap-", async () => {
      const longTitle = "x".repeat(500);
      await runStandaloneDuplicateGuardInner(
        { ...tasksCreateInput(), tool_input: { title: longTitle } },
        { fetchSimilar: () => TIMED_OUT_PROBE }
      );

      const [event] = readGuardHealthEvents();
      expect(event?.subject?.length).toBeLessThanOrEqual(120);
      expect(event?.subject?.endsWith("…")).toBe(true);
    });
  });

  test("SC2: a degraded skip surfaces additionalContext at the create", async () => {
    await withScratchStateDir("mt3358-visible-", async () => {
      const out = await captureStdout(async () => {
        await runStandaloneDuplicateGuardInner(tasksCreateInput(), {
          fetchSimilar: () => TIMED_OUT_PROBE,
        });
      });

      // stderr does not reach the agent and the health banner may not fire until
      // a later session — additionalContext is the only channel that reaches the
      // caller in the same turn as the create.
      expect(out).toContain("additionalContext");
      expect(out).toContain("SKIPPED");
      expect(out).toContain(DEADLINE_FRAGMENT);
    });
  });

  test("SC2: silence is meaningful — a probe that RAN emits no skip notice", async () => {
    await withScratchStateDir("mt3358-silence-", async () => {
      const out = await captureStdout(async () => {
        await runStandaloneDuplicateGuardInner(tasksCreateInput(), {
          fetchSimilar: () => ({ results: [], degraded: false }),
        });
      });

      // This is the pair that makes the skip notice load-bearing: because a
      // completed probe says nothing, the PRESENCE of the notice means "not
      // checked" and its ABSENCE means "checked". Emitting a positive
      // "check ran" line here would put a notification on every create.
      expect(out).not.toContain("SKIPPED");
    });
  });
});

describe("mt#3892 / PR #2762 R2: a non-degraded skip is not clean-run evidence", () => {
  // `decideStandaloneDuplicateGuard` returns a non-degraded skip for a
  // title-less create BEFORE it ever calls `fetchSimilar`. So that path never
  // exercises the probe — the thing that actually breaks — and marking it
  // `decided` would let one title-less create clear a failure streak caused by
  // a probe that is still broken. Unset, like the dispatcher's override record:
  // evidence of neither a clean decision nor a crash.
  test("a title-less create records no guardOutcome", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "mt3892-r2-skip-"));
    const prevStateDir = process.env.MINSKY_STATE_DIR;
    process.env.MINSKY_STATE_DIR = scratchDir;
    try {
      await runStandaloneDuplicateGuard({ ...tasksCreateInput(), tool_input: {} });

      const entries = readFireLogEntries().filter(
        (e) => e.guardName === "standalone-duplicate-matcher"
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]?.guardOutcome).toBeUndefined();
      // And so it contributes nothing to the recovery join.
      expect(readCleanGuardInvocations()).toEqual([]);
    } finally {
      if (prevStateDir === undefined) delete process.env.MINSKY_STATE_DIR;
      else process.env.MINSKY_STATE_DIR = prevStateDir;
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

describe("mt#3892: the inner function writes NO fire-log record", () => {
  // PR #2762 R1 found a real double-write: the fire-log call originally sat in
  // the inner function, before its output switch, so a throw AFTER that write
  // produced two records for one evaluation — a `decided` one and then a
  // `crashed` one from the outer catch. The `decided` record would have made a
  // run that ultimately crashed read as a clean run, which is precisely the
  // reading the `guardOutcome` marker exists to prevent.
  //
  // The fix is structural: exactly one call site, in the outer function's
  // `finally`. This pins the half that a structural fix can silently lose — if
  // anyone moves a write back into the inner function, the outer `finally`
  // makes it a duplicate again, and this goes red.
  const cases: ReadonlyArray<{
    name: string;
    fetchSimilar: () =>
      | { results: []; degraded: boolean }
      | { failed: string; causeClass: "infra" };
  }> = [
    { name: "a completed probe", fetchSimilar: () => ({ results: [], degraded: false }) },
    {
      name: "a degraded probe",
      fetchSimilar: () => ({ failed: CONNECT_TIMEOUT_ERROR, causeClass: "infra" }),
    },
  ];

  for (const { name, fetchSimilar } of cases) {
    test(`${name} leaves the fire-log untouched`, async () => {
      const scratchDir = mkdtempSync(join(tmpdir(), "mt3892-inner-firelog-"));
      const prevStateDir = process.env.MINSKY_STATE_DIR;
      process.env.MINSKY_STATE_DIR = scratchDir;
      try {
        await runStandaloneDuplicateGuardInner(tasksCreateInput(), { fetchSimilar });
        expect(existsSync(join(scratchDir, "fire-log.jsonl"))).toBe(false);
      } finally {
        if (prevStateDir === undefined) delete process.env.MINSKY_STATE_DIR;
        else process.env.MINSKY_STATE_DIR = prevStateDir;
        rmSync(scratchDir, { recursive: true, force: true });
      }
    });
  }
});
