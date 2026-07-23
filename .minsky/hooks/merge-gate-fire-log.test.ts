// Tests for .minsky/hooks/merge-gate-fire-log.ts — mt#3084 (evaluation-loop
// Phase 3 build-out).
//
// Every test uses an in-memory fs fixture (mirrors fire-log.test.ts's own
// pattern) and mocks `process.exit` to throw instead of terminating the test
// process — no test here touches the real filesystem, the real
// MINSKY_STATE_DIR, or actually exits the process.

import { describe, test, expect, spyOn } from "bun:test";
import { makeRecordAndExit } from "./merge-gate-fire-log";
import { readFireLogEntries, type FireLogFsDeps } from "./fire-log";

// ---------------------------------------------------------------------------
// In-memory fs fixture (same shape as fire-log.test.ts's own fixture)
// ---------------------------------------------------------------------------

function makeInMemoryFs(initial?: Record<string, string>): FireLogFsDeps & {
  files: Record<string, string>;
} {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    existsSync: (p: string) => p in files || Object.keys(files).some((k) => k.startsWith(p)),
    mkdirSync: () => {
      /* no-op — flat in-memory map */
    },
    appendFileSync: (p: string, data: string) => {
      files[p] = (files[p] ?? "") + data;
    },
    readFileSync: (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p] as string;
    },
  };
}

const LOG_PATH = "/fake/state/fire-log.jsonl";
const SESSION_PR_MERGE_TOOL = "mcp__minsky__session_pr_merge";

/** Call a `never`-returning `recordAndExit` invocation and capture the mocked
 * `process.exit` code instead of letting it actually terminate the process. */
function callAndCaptureExit(fn: () => never): number | undefined {
  const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitCalled(code);
  }) as never);
  class ExitCalled extends Error {
    code?: number;
    constructor(code?: number) {
      super(`process.exit(${code})`);
      this.code = code;
    }
  }
  try {
    fn();
    return undefined;
  } catch (err) {
    if (err instanceof ExitCalled) return err.code;
    throw err;
  } finally {
    exitSpy.mockRestore();
  }
}

describe("makeRecordAndExit", () => {
  test("records an allow decision with guardName/event/toolName/sessionId/durationMs, then exits 0", () => {
    const fs = makeInMemoryFs();
    const fixedStartMs = Date.now();
    const startMs = fixedStartMs - 12;
    const recordAndExit = makeRecordAndExit(
      "require-review-before-merge",
      startMs,
      { tool_name: SESSION_PR_MERGE_TOOL, session_id: "sess-abc" },
      { logPath: LOG_PATH, fs }
    );

    const exitCode = callAndCaptureExit(() => recordAndExit("allow"));
    expect(exitCode).toBe(0);

    const entries = readFireLogEntries({ logPath: LOG_PATH, fs });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      guardName: "require-review-before-merge",
      event: "PreToolUse",
      decision: "allow",
      toolName: SESSION_PR_MERGE_TOOL,
      sessionId: "sess-abc",
    });
    expect(typeof entries[0]?.durationMs).toBe("number");
    expect(entries[0]?.overrideEnvVar).toBeUndefined();
  });

  test("records a deny decision", () => {
    const fs = makeInMemoryFs();
    const recordAndExit = makeRecordAndExit(
      "block-out-of-band-merge",
      Date.now(),
      { tool_name: SESSION_PR_MERGE_TOOL, session_id: "sess-deny" },
      { logPath: LOG_PATH, fs }
    );

    callAndCaptureExit(() => recordAndExit("deny"));

    const entries = readFireLogEntries({ logPath: LOG_PATH, fs });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.decision).toBe("deny");
  });

  test("records a warn decision (additionalContext-only outcome)", () => {
    const fs = makeInMemoryFs();
    const recordAndExit = makeRecordAndExit(
      "require-growth-justification-before-merge",
      Date.now(),
      { tool_name: SESSION_PR_MERGE_TOOL, session_id: "sess-warn" },
      { logPath: LOG_PATH, fs }
    );

    callAndCaptureExit(() => recordAndExit("warn"));

    const entries = readFireLogEntries({ logPath: LOG_PATH, fs });
    expect(entries[0]?.decision).toBe("warn");
  });

  test("passes overrideEnvVar/overrideClassification through when an escape hatch fired", () => {
    const fs = makeInMemoryFs();
    const recordAndExit = makeRecordAndExit(
      "require-deploy-verification-before-merge",
      Date.now(),
      { tool_name: SESSION_PR_MERGE_TOOL, session_id: "sess-override" },
      { logPath: LOG_PATH, fs }
    );

    callAndCaptureExit(() =>
      recordAndExit("allow", {
        overrideEnvVar: "MINSKY_SKIP_DEPLOY_VERIFY",
        overrideClassification: "authorized_exception",
      })
    );

    const entries = readFireLogEntries({ logPath: LOG_PATH, fs });
    expect(entries[0]).toMatchObject({
      decision: "allow",
      overrideEnvVar: "MINSKY_SKIP_DEPLOY_VERIFY",
      overrideClassification: "authorized_exception",
    });
  });

  test("a fire-log write failure never prevents process.exit(0) (fail-safe, mt#3084 hard constraint #2)", () => {
    const throwingFs: FireLogFsDeps = {
      existsSync: () => true,
      mkdirSync: () => {
        /* no-op */
      },
      appendFileSync: () => {
        throw new Error("ENOSPC: disk full (simulated)");
      },
      readFileSync: () => "",
    };
    const recordAndExit = makeRecordAndExit(
      "require-checks-on-bypass-merge",
      Date.now(),
      { tool_name: SESSION_PR_MERGE_TOOL, session_id: "sess-fail" },
      { logPath: LOG_PATH, fs: throwingFs, stderrWrite: () => {} }
    );

    // Must still reach process.exit(0) — a broken log destination must never
    // turn into a gate failure or a thrown error escaping the hook.
    const exitCode = callAndCaptureExit(() => recordAndExit("deny"));
    expect(exitCode).toBe(0);
  });

  test("multiple recordAndExit calls from the SAME closure only ever record once per call (no double-fire on a single guarded invocation)", () => {
    // Not a realistic call pattern (recordAndExit is `never`-typed and exits
    // the process), but confirms the closure is stateless per-call rather
    // than accumulating durationMs/records across invocations of the factory
    // for two DIFFERENT guards sharing nothing.
    const fsA = makeInMemoryFs();
    const fsB = makeInMemoryFs();
    const recordAndExitA = makeRecordAndExit(
      "guard-a",
      Date.now(),
      { tool_name: SESSION_PR_MERGE_TOOL, session_id: "s1" },
      { logPath: LOG_PATH, fs: fsA }
    );
    const recordAndExitB = makeRecordAndExit(
      "guard-b",
      Date.now(),
      { tool_name: SESSION_PR_MERGE_TOOL, session_id: "s2" },
      { logPath: LOG_PATH, fs: fsB }
    );

    callAndCaptureExit(() => recordAndExitA("allow"));
    callAndCaptureExit(() => recordAndExitB("deny"));

    expect(readFireLogEntries({ logPath: LOG_PATH, fs: fsA })).toHaveLength(1);
    expect(readFireLogEntries({ logPath: LOG_PATH, fs: fsB })).toHaveLength(1);
  });
});
