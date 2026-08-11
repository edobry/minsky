// Tests for .minsky/hooks/merge-gate-fire-log.ts — mt#3084 (evaluation-loop
// Phase 3 build-out), restructured by mt#3630.
//
// Two layers, matching the module's own split:
//   - `makeMergeGateDecider` is PURE — every record-construction assertion below is a
//     plain assertion on its return value. No fs, no exit, nothing to restore.
//   - `dispatchMergeGateDecision` is the write-and-exit shell — exercised with an
//     in-memory fs fixture (mirrors fire-log.test.ts's own pattern) and an INJECTED
//     exit impl. Before mt#3630 this file patched the real `process.exit` with a spy,
//     which mutates the runner process globally and must be hand-restored; the
//     injected impl is scoped to the one call that receives it.

import { describe, test, expect } from "bun:test";
import {
  makeRecordAndExit,
  makeMergeGateDecider,
  dispatchMergeGateDecision,
  type MergeGateDecision,
  type MergeGateHookInput,
  type MergeGateOverrideFields,
} from "./merge-gate-fire-log";
import {
  readFireLogEntries,
  type FireLogDecision,
  type FireLogFsDeps,
  type FireLogRecordOptions,
} from "./fire-log";

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
const AUTHORIZED_EXCEPTION = "authorized_exception";
const REVIEW_GATE = "require-review-before-merge";
const DEPLOY_VERIFY_SKIP_VAR = "MINSKY_SKIP_DEPLOY_VERIFY";
/** A fixed invocation start time — nothing here needs a real clock, and a fixed value
 * keeps `durationMs` deterministic. */
const FIXED_START_MS = 1_000;

function input(sessionId: string): MergeGateHookInput {
  return { tool_name: SESSION_PR_MERGE_TOOL, session_id: sessionId };
}

/**
 * An injectable stand-in for `process.exit`: records the code, then unwinds by throwing
 * so the `never` contract holds without terminating the test-runner process.
 */
class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

function makeExitRecorder(): { codes: number[]; exitImpl: (code: number) => never } {
  const codes: number[] = [];
  return {
    codes,
    exitImpl: (code: number): never => {
      codes.push(code);
      throw new ExitCalled(code);
    },
  };
}

/**
 * Run one gate exit point exactly as production composes it — decide, then dispatch
 * through the `never`-typed shell — with the real exit swapped for a recorder. Returns
 * the exit code the shell actually reached.
 */
function runExitPoint(
  guardName: string,
  startMs: number,
  hookInput: MergeGateHookInput,
  decision: FireLogDecision,
  recordOptions: FireLogRecordOptions,
  overrideFields?: MergeGateOverrideFields
): number | undefined {
  const exit = makeExitRecorder();
  const decide = makeMergeGateDecider(guardName, startMs, hookInput);
  try {
    dispatchMergeGateDecision(decide(decision, overrideFields), recordOptions, exit.exitImpl);
  } catch (err) {
    if (!(err instanceof ExitCalled)) throw err;
  }
  return exit.codes[0];
}

// ---------------------------------------------------------------------------
// The PURE half — record construction, asserted by return value (mt#3630)
// ---------------------------------------------------------------------------

describe("makeMergeGateDecider (pure)", () => {
  test("builds an allow record with guardName/event/toolName/sessionId/durationMs", () => {
    // Injected clock: durationMs is then an exact assertion, not a `typeof number`.
    const startMs = 1_000;
    const decide = makeMergeGateDecider(
      REVIEW_GATE,
      startMs,
      input("sess-abc"),
      undefined,
      () => startMs + 12
    );

    const { exitCode, record } = decide("allow");

    expect(exitCode).toBe(0);
    expect(record).toEqual({
      guardName: REVIEW_GATE,
      event: "PreToolUse",
      decision: "allow",
      // mt#3920: no `guardOutcome` — the field is UNSET unless an exit point names it. This
      // exact-shape assertion is what makes this test the regression guard for that default:
      // a change to it fails HERE, not silently in guard-health weeks later.
      durationMs: 12,
      toolName: SESSION_PR_MERGE_TOOL,
      sessionId: "sess-abc",
    });
  });

  test("mt#3920: the outcome is UNSET unless the exit point names it", () => {
    const decide = makeMergeGateDecider(REVIEW_GATE, Date.now(), input("s"));

    // Unset by default, for EVERY decision value. A merge gate exits early on unrelated
    // tool calls and on non-merge commands; none of that is evidence its probe works, and
    // counting it would let the guard read `recovered` on traffic it never inspected.
    expect(decide("allow").record.guardOutcome).toBeUndefined();
    expect(decide("deny").record.guardOutcome).toBeUndefined();
    expect(decide("warn").record.guardOutcome).toBeUndefined();

    // An exit downstream of the check claims it explicitly.
    expect(decide("deny", undefined, "decided").record.guardOutcome).toBe("decided");

    // A fail-open exit passes `crashed` explicitly. This is the one that matters: an
    // `allow` emitted because the probe BROKE must not read as a clean run, or
    // guard-health reports a guard whose probe is dead as recovered.
    expect(decide("allow", undefined, "crashed").record.guardOutcome).toBe("crashed");

    // The outcome is independent of the override fields — a guard can fail open while
    // an override is also present.
    expect(
      decide("allow", { overrideClassification: "authorized_exception" }, "crashed").record
        .guardOutcome
    ).toBe("crashed");
  });

  test("builds deny and warn records, both still exiting 0", () => {
    // A PreToolUse hook signals its decision in stdout JSON, never in its exit status —
    // a non-zero exit reads to the harness as "the hook itself broke" (fail-open).
    const decide = makeMergeGateDecider("block-out-of-band-merge", Date.now(), input("s"));
    expect(decide("deny").record.decision).toBe("deny");
    expect(decide("deny").exitCode).toBe(0);
    expect(decide("warn").record.decision).toBe("warn");
    expect(decide("warn").exitCode).toBe(0);
  });

  test("carries overrideEnvVar/overrideClassification through when an escape hatch fired", () => {
    const decide = makeMergeGateDecider(
      "require-deploy-verification-before-merge",
      Date.now(),
      input("sess-override")
    );

    const { record } = decide("allow", {
      overrideEnvVar: DEPLOY_VERIFY_SKIP_VAR,
      overrideClassification: AUTHORIZED_EXCEPTION,
    });

    expect(record).toMatchObject({
      decision: "allow",
      overrideEnvVar: DEPLOY_VERIFY_SKIP_VAR,
      overrideClassification: AUTHORIZED_EXCEPTION,
    });
  });

  test("omits overrideEnvVar entirely for a grant-channel override (D8 grant, no env var)", () => {
    const decide = makeMergeGateDecider(
      "require-checks-on-bypass-merge",
      Date.now(),
      input("sess-grant")
    );

    const { record } = decide("allow", {
      overrideClassification: AUTHORIZED_EXCEPTION,
      overrideSource: "grant",
    });

    expect(record).toMatchObject({
      decision: "allow",
      overrideClassification: AUTHORIZED_EXCEPTION,
      overrideSource: "grant",
    });
    expect(record.overrideEnvVar).toBeUndefined();
  });

  test("carries overrideGrantAsk (the authorizing Ask id) for a grant override (mt#2989)", () => {
    const decide = makeMergeGateDecider(REVIEW_GATE, Date.now(), input("sess-req-changes"));

    const { record } = decide("allow", {
      overrideClassification: AUTHORIZED_EXCEPTION,
      overrideSource: "grant",
      overrideGrantAsk: "7fee3742-53c4-4259-ac2a-dd4b9dfdb690",
    });

    expect(record).toMatchObject({
      decision: "allow",
      overrideSource: "grant",
      overrideGrantAsk: "7fee3742-53c4-4259-ac2a-dd4b9dfdb690",
    });
  });

  test("builds a fresh record per call — no state accumulates in the decider", () => {
    let clock = 100;
    const decide = makeMergeGateDecider("guard-a", 0, input("s1"), undefined, () => clock);
    const first = decide("allow");
    clock = 250;
    const second = decide("deny");
    expect(first.record.durationMs).toBe(100);
    expect(second.record.durationMs).toBe(250);
    expect(first.record.decision).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// The IMPERATIVE half — write-record-and-exit (mt#3630)
// ---------------------------------------------------------------------------

describe("dispatchMergeGateDecision", () => {
  test("writes the decision's record to the fire log, then exits with its code", () => {
    const fs = makeInMemoryFs();
    const exit = makeExitRecorder();
    const decision: MergeGateDecision = {
      exitCode: 0,
      record: {
        guardName: REVIEW_GATE,
        event: "PreToolUse",
        decision: "deny",
        durationMs: 7,
        toolName: SESSION_PR_MERGE_TOOL,
        sessionId: "sess-dispatch",
      },
    };

    expect(() =>
      dispatchMergeGateDecision(decision, { logPath: LOG_PATH, fs }, exit.exitImpl)
    ).toThrow(ExitCalled);
    expect(exit.codes).toEqual([0]);

    const entries = readFireLogEntries({ logPath: LOG_PATH, fs });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      guardName: REVIEW_GATE,
      event: "PreToolUse",
      decision: "deny",
      toolName: SESSION_PR_MERGE_TOOL,
      sessionId: "sess-dispatch",
    });
  });

  test("a fire-log write failure never prevents the exit (fail-safe, mt#3084 hard constraint #2)", () => {
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
    const exit = makeExitRecorder();
    const decide = makeMergeGateDecider(
      "require-checks-on-bypass-merge",
      Date.now(),
      input("sess-fail")
    );

    // Must still reach the exit — a broken log destination must never turn into a gate
    // failure or a thrown error escaping the hook.
    try {
      dispatchMergeGateDecision(
        decide("deny"),
        { logPath: LOG_PATH, fs: throwingFs, stderrWrite: () => {} },
        exit.exitImpl
      );
    } catch (err) {
      if (!(err instanceof ExitCalled)) throw err;
    }
    expect(exit.codes).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// The composed factory guards actually call — unchanged shape (mt#3630)
// ---------------------------------------------------------------------------

describe("makeRecordAndExit", () => {
  test("still returns a never-typed closure that records then exits 0", () => {
    const fs = makeInMemoryFs();
    const exitCode = runExitPoint(REVIEW_GATE, FIXED_START_MS, input("sess-abc"), "allow", {
      logPath: LOG_PATH,
      fs,
    });
    expect(exitCode).toBe(0);

    const entries = readFireLogEntries({ logPath: LOG_PATH, fs });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      guardName: REVIEW_GATE,
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
    runExitPoint("block-out-of-band-merge", Date.now(), input("sess-deny"), "deny", {
      logPath: LOG_PATH,
      fs,
    });
    expect(readFireLogEntries({ logPath: LOG_PATH, fs })[0]?.decision).toBe("deny");
  });

  test("records a warn decision (additionalContext-only outcome)", () => {
    const fs = makeInMemoryFs();
    runExitPoint(
      "require-growth-justification-before-merge",
      Date.now(),
      input("sess-warn"),
      "warn",
      { logPath: LOG_PATH, fs }
    );
    expect(readFireLogEntries({ logPath: LOG_PATH, fs })[0]?.decision).toBe("warn");
  });

  test("passes override fields through to the recorded entry", () => {
    const fs = makeInMemoryFs();
    runExitPoint(
      "require-deploy-verification-before-merge",
      Date.now(),
      input("sess-override"),
      "allow",
      { logPath: LOG_PATH, fs },
      {
        overrideEnvVar: DEPLOY_VERIFY_SKIP_VAR,
        overrideClassification: AUTHORIZED_EXCEPTION,
      }
    );

    expect(readFireLogEntries({ logPath: LOG_PATH, fs })[0]).toMatchObject({
      decision: "allow",
      overrideEnvVar: DEPLOY_VERIFY_SKIP_VAR,
      overrideClassification: AUTHORIZED_EXCEPTION,
    });
  });

  test("two closures from separate factory calls share no state", () => {
    // Confirms the closure is stateless per-call rather than accumulating
    // durationMs/records across invocations of the factory for two DIFFERENT guards.
    const fsA = makeInMemoryFs();
    const fsB = makeInMemoryFs();
    runExitPoint("guard-a", Date.now(), input("s1"), "allow", { logPath: LOG_PATH, fs: fsA });
    runExitPoint("guard-b", Date.now(), input("s2"), "deny", { logPath: LOG_PATH, fs: fsB });

    expect(readFireLogEntries({ logPath: LOG_PATH, fs: fsA })).toHaveLength(1);
    expect(readFireLogEntries({ logPath: LOG_PATH, fs: fsB })).toHaveLength(1);
  });

  test("the exported factory is still the never-typed shape guard call sites rely on", () => {
    // The ~10 guard entry points annotate their closure `const recordAndExit: RecordAndExit`
    // and call it in place of a bare `process.exit(0)`; a fall-through-able return type
    // would silently break that can't-forget-to-exit ergonomic. Compile-time assertion —
    // paired with the runtime assertions above, per the placeholder-test rule.
    const fs = makeInMemoryFs();
    const recordAndExit = makeRecordAndExit(REVIEW_GATE, Date.now(), input("sess-never"), {
      logPath: LOG_PATH,
      fs,
    });
    const assertNever: (fn: (d: FireLogDecision) => never) => void = () => {};
    assertNever(recordAndExit);
    expect(typeof recordAndExit).toBe("function");
  });
});
