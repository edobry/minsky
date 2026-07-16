import { describe, test, expect } from "bun:test";
import {
  checkOverride,
  buildOverrideAuditLine,
  calibrationLogPath,
  logCalibrationRecord,
  resolveDispatchContext,
  runDispatcher,
  HOOK_OVERRIDE_ENV_VAR,
  type CalibrationWriteDeps,
} from "./dispatcher";
import type { GuardRegistration } from "./registry";
import type { ToolHookInput, HookOutput, HostCapInfo } from "./types";
import type { TranscriptLine } from "./transcript";

/** The dispatcher's own compiled filename, used throughout as `hookFilename`. */
const DISPATCH_HOOK_FILENAME = "dispatch-pretooluse.ts";

// ---------------------------------------------------------------------------
// checkOverride (D3)
// ---------------------------------------------------------------------------

/** Collects stderr writes for assertion without touching the real process.stderr. */
function makeStderrSpy(): { writes: string[]; write: (s: string) => void } {
  const writes: string[] = [];
  return { writes, write: (s) => writes.push(s) };
}

/** Known-guard-name universe used by the checkOverride tests below — decoupled from the
 * real (growing) GUARD_REGISTRY so these tests don't need updating as guards migrate. */
const KNOWN_GUARDS = ["some-guard", "other-guard", "a", "b", "c"];

/** The real pilot guard's canonical name — used where tests intentionally exercise the
 * live GUARD_REGISTRY default rather than a synthetic KNOWN_GUARDS universe. */
const PILOT_GUARD_NAME = "check-guessed-session-path";

/** Shared grant-reason fixture (Phase-7 adjunct, mt#2658) — extracted to satisfy
 * custom/no-magic-string-duplication. */
const GRANT_REASON = "concurrent decomposition — distinct sibling";

describe("checkOverride", () => {
  test("no env var set -> not overridden", () => {
    expect(checkOverride("some-guard", {})).toEqual({ overridden: false });
  });

  test("env var names exactly this guard -> overridden", () => {
    const result = checkOverride(
      "some-guard",
      { [HOOK_OVERRIDE_ENV_VAR]: "some-guard" },
      { knownGuardNames: KNOWN_GUARDS }
    );
    expect(result.overridden).toBe(true);
    expect(result.raw).toBe("some-guard");
  });

  test("env var names a different guard -> not overridden", () => {
    const result = checkOverride(
      "some-guard",
      { [HOOK_OVERRIDE_ENV_VAR]: "other-guard" },
      { knownGuardNames: KNOWN_GUARDS }
    );
    expect(result.overridden).toBe(false);
  });

  test("comma-separated list -> matches any listed guard", () => {
    const result = checkOverride(
      "b",
      { [HOOK_OVERRIDE_ENV_VAR]: "a,b,c" },
      { knownGuardNames: KNOWN_GUARDS }
    );
    expect(result.overridden).toBe(true);
  });

  test("whitespace around list entries is tolerated", () => {
    const result = checkOverride(
      "b",
      { [HOOK_OVERRIDE_ENV_VAR]: " a , b , c " },
      { knownGuardNames: KNOWN_GUARDS }
    );
    expect(result.overridden).toBe(true);
  });

  test("literal 'all' overrides any guard name", () => {
    expect(
      checkOverride(
        "anything",
        { [HOOK_OVERRIDE_ENV_VAR]: "all" },
        { knownGuardNames: KNOWN_GUARDS }
      ).overridden
    ).toBe(true);
    expect(
      checkOverride(
        "other",
        { [HOOK_OVERRIDE_ENV_VAR]: "x,all" },
        { knownGuardNames: KNOWN_GUARDS, stderrWrite: () => {} }
      ).overridden
    ).toBe(true);
  });

  test("empty string env var -> not overridden", () => {
    expect(
      checkOverride(
        "some-guard",
        { [HOOK_OVERRIDE_ENV_VAR]: "" },
        { knownGuardNames: KNOWN_GUARDS }
      ).overridden
    ).toBe(false);
  });

  test("mixed-case env value matches a lowercase-canonical guard name", () => {
    const result = checkOverride(
      PILOT_GUARD_NAME,
      { [HOOK_OVERRIDE_ENV_VAR]: "Check-Guessed-Session-Path" },
      { knownGuardNames: [PILOT_GUARD_NAME] }
    );
    expect(result.overridden).toBe(true);
  });

  test("mixed-case guardName argument still matches a lowercase env token", () => {
    const result = checkOverride(
      "Some-Guard",
      { [HOOK_OVERRIDE_ENV_VAR]: "some-guard" },
      { knownGuardNames: KNOWN_GUARDS }
    );
    expect(result.overridden).toBe(true);
  });

  test("'ALL' (uppercase) overrides any guard name", () => {
    const result = checkOverride(
      "some-guard",
      { [HOOK_OVERRIDE_ENV_VAR]: "ALL" },
      { knownGuardNames: KNOWN_GUARDS }
    );
    expect(result.overridden).toBe(true);
  });

  test("unknown token warns to stderr and does NOT suppress any guard", () => {
    const spy = makeStderrSpy();
    const result = checkOverride(
      "some-guard",
      { [HOOK_OVERRIDE_ENV_VAR]: "some-gaurd" }, // typo
      { knownGuardNames: KNOWN_GUARDS, stderrWrite: spy.write }
    );
    expect(result.overridden).toBe(false);
    expect(spy.writes.length).toBe(1);
    expect(spy.writes[0]).toContain("some-gaurd");
    expect(spy.writes[0]).toContain("does not match any registered guard name");
  });

  test("known token alongside an unknown token: known one still overrides, unknown one still warns", () => {
    const spy = makeStderrSpy();
    const result = checkOverride(
      "b",
      { [HOOK_OVERRIDE_ENV_VAR]: "typo-name,b" },
      { knownGuardNames: KNOWN_GUARDS, stderrWrite: spy.write }
    );
    expect(result.overridden).toBe(true);
    expect(spy.writes.length).toBe(1);
    expect(spy.writes[0]).toContain("typo-name");
  });

  test("'all' and known tokens never trigger the unknown-token warning", () => {
    const spy = makeStderrSpy();
    checkOverride(
      "b",
      { [HOOK_OVERRIDE_ENV_VAR]: "all,b" },
      { knownGuardNames: KNOWN_GUARDS, stderrWrite: spy.write }
    );
    expect(spy.writes).toEqual([]);
  });

  test("defaults knownGuardNames to the live GUARD_REGISTRY when not supplied", () => {
    const spy = makeStderrSpy();
    const result = checkOverride(
      PILOT_GUARD_NAME,
      { [HOOK_OVERRIDE_ENV_VAR]: PILOT_GUARD_NAME },
      { stderrWrite: spy.write }
    );
    expect(result.overridden).toBe(true);
    expect(spy.writes).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Grant-file channel (Phase-7 adjunct, mt#2658)
  // -------------------------------------------------------------------------

  test("no scope supplied -> grant lookup is never invoked (back-compat default)", () => {
    let called = false;
    const result = checkOverride(
      "some-guard",
      {},
      {
        knownGuardNames: KNOWN_GUARDS,
        findGuardGrant: () => {
          called = true;
          return null;
        },
      }
    );
    expect(result).toEqual({ overridden: false });
    expect(called).toBe(false);
  });

  test("scope supplied, no matching grant -> not overridden", () => {
    const result = checkOverride(
      "some-guard",
      {},
      {
        knownGuardNames: KNOWN_GUARDS,
        scope: "mt#2581",
        findGuardGrant: () => null,
      }
    );
    expect(result.overridden).toBe(false);
  });

  test("scope supplied, matching grant -> overridden with grantReason", () => {
    let seenArgs: [string, string, number] | null = null;
    const result = checkOverride(
      "duplicate-child-matcher",
      {},
      {
        knownGuardNames: KNOWN_GUARDS,
        scope: "mt#2581",
        now: () => 1000,
        findGuardGrant: (guardName, scope, nowMs) => {
          seenArgs = [guardName, scope, nowMs];
          return {
            guardName,
            scope,
            issuedAt: "2026-07-08T00:00:00.000Z",
            ttlMs: 1000,
            reason: GRANT_REASON,
          };
        },
      }
    );
    expect(result).toEqual({
      overridden: true,
      grantReason: GRANT_REASON,
    });
    expect(seenArgs).toEqual(["duplicate-child-matcher", "mt#2581", 1000]);
  });

  test("env-var override takes precedence over a grant match (grant lookup never invoked)", () => {
    let called = false;
    const result = checkOverride(
      "b",
      { [HOOK_OVERRIDE_ENV_VAR]: "b" },
      {
        knownGuardNames: KNOWN_GUARDS,
        scope: "mt#2581",
        findGuardGrant: () => {
          called = true;
          return { guardName: "b", scope: "mt#2581", issuedAt: "x", ttlMs: 1, reason: "unused" };
        },
      }
    );
    expect(result.overridden).toBe(true);
    expect(result.raw).toBe("b");
    expect(result.grantReason).toBeUndefined();
    expect(called).toBe(false);
  });

  test("env var set but doesn't match this guard, scope supplied and grant matches -> overridden via grant, raw preserved", () => {
    const result = checkOverride(
      "b",
      { [HOOK_OVERRIDE_ENV_VAR]: "other-guard" },
      {
        knownGuardNames: KNOWN_GUARDS,
        scope: "mt#2581",
        findGuardGrant: () => ({
          guardName: "b",
          scope: "mt#2581",
          issuedAt: "x",
          ttlMs: 1,
          reason: "grant reason here",
        }),
      }
    );
    expect(result.overridden).toBe(true);
    expect(result.raw).toBe("other-guard");
    expect(result.grantReason).toBe("grant reason here");
  });
});

// ---------------------------------------------------------------------------
// buildOverrideAuditLine (D3)
// ---------------------------------------------------------------------------

describe("buildOverrideAuditLine", () => {
  test("matches the documented format exactly", () => {
    const line = buildOverrideAuditLine(
      "PreToolUse",
      PILOT_GUARD_NAME,
      "sess-123",
      () => "2026-07-07T00:00:00.000Z"
    );
    expect(line).toBe(
      `[dispatcher:PreToolUse] OVERRIDE: guard=${PILOT_GUARD_NAME} session=sess-123 ts=2026-07-07T00:00:00.000Z\n`
    );
  });

  test("missing session id falls back to 'unknown'", () => {
    const line = buildOverrideAuditLine("PreToolUse", "g", undefined, () => "TS");
    expect(line).toContain("session=unknown");
  });

  test("reason (Phase-7 adjunct, mt#2658), when supplied, is included as a quoted segment", () => {
    const line = buildOverrideAuditLine(
      "PreToolUse",
      PILOT_GUARD_NAME,
      "sess-123",
      () => "2026-07-07T00:00:00.000Z",
      GRANT_REASON
    );
    expect(line).toBe(
      `[dispatcher:PreToolUse] OVERRIDE: guard=${PILOT_GUARD_NAME} session=sess-123 reason="${GRANT_REASON}" ts=2026-07-07T00:00:00.000Z\n`
    );
  });

  test("omitted reason produces the exact same format as before (no trailing space/segment)", () => {
    const withReason = buildOverrideAuditLine("PreToolUse", "g", "s", () => "TS", undefined);
    const withoutReasonParam = buildOverrideAuditLine("PreToolUse", "g", "s", () => "TS");
    expect(withReason).toBe(withoutReasonParam);
  });
});

// ---------------------------------------------------------------------------
// calibrationLogPath / logCalibrationRecord (D4)
// ---------------------------------------------------------------------------

describe("calibrationLogPath", () => {
  test("preserves the existing CALIBRATION_LOG_REGISTRY filename convention", () => {
    expect(calibrationLogPath("causal-premise", "/repo")).toBe(
      "/repo/.minsky/causal-premise-calibration.jsonl"
    );
  });
});

function makeFakeDeps(): CalibrationWriteDeps & {
  files: Map<string, string>;
  dirsCreated: string[];
} {
  const files = new Map<string, string>();
  const dirsCreated: string[] = [];
  return {
    files,
    dirsCreated,
    existsSync: (p) => dirsCreated.includes(p),
    mkdirSync: (p) => {
      dirsCreated.push(p);
    },
    appendFileSync: (p, data) => {
      files.set(p, (files.get(p) ?? "") + data);
    },
  };
}

describe("logCalibrationRecord", () => {
  test("appends a JSONL line to the resolved path", () => {
    const deps = makeFakeDeps();
    logCalibrationRecord(
      "causal-premise",
      { timestamp: "T", matchedPhrases: ["x"] },
      { projectDir: "/repo", deps }
    );
    const content = deps.files.get("/repo/.minsky/causal-premise-calibration.jsonl");
    expect(content).toBeDefined();
    expect(JSON.parse((content ?? "").trim())).toEqual({ timestamp: "T", matchedPhrases: ["x"] });
  });

  test("creates the parent dir when missing", () => {
    const deps = makeFakeDeps();
    logCalibrationRecord("x", { a: 1 }, { projectDir: "/repo", deps });
    expect(deps.dirsCreated).toContain("/repo/.minsky");
  });

  test("does not recreate an already-existing dir", () => {
    const deps = makeFakeDeps();
    deps.dirsCreated.push("/repo/.minsky");
    let mkdirCalls = 0;
    const wrapped: CalibrationWriteDeps = {
      ...deps,
      mkdirSync: (p) => {
        mkdirCalls++;
        deps.mkdirSync(p);
      },
    };
    logCalibrationRecord("x", { a: 1 }, { projectDir: "/repo", deps: wrapped });
    expect(mkdirCalls).toBe(0);
  });

  test("swallows write failures (best-effort, never throws)", () => {
    const deps = makeFakeDeps();
    const throwing: CalibrationWriteDeps = {
      ...deps,
      appendFileSync: () => {
        throw new Error("disk full");
      },
    };
    expect(() =>
      logCalibrationRecord("x", { a: 1 }, { projectDir: "/repo", deps: throwing })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveDispatchContext (D6)
// ---------------------------------------------------------------------------

describe("resolveDispatchContext", () => {
  const fakeHostCap: HostCapInfo = { hostCapSec: 20, source: "settings.json" };

  test("no transcript_path -> empty candidates/lines, budgets still derived", () => {
    const ctx = resolveDispatchContext(
      "PreToolUse",
      { transcript_path: undefined, agent_id: undefined },
      {
        hookFilename: DISPATCH_HOOK_FILENAME,
        readHostCapFn: () => fakeHostCap,
      }
    );
    expect(ctx.transcriptCandidates).toEqual([]);
    expect(ctx.transcriptLines).toEqual([]);
    expect(ctx.hostCapSec).toBe(20);
    expect(ctx.budgets.overallBudgetMs).toBeGreaterThan(0);
    expect(ctx.event).toBe("PreToolUse");
  });

  test("with transcript_path -> resolves candidates once and parses each", () => {
    const resolvedCandidates = ["/t/a.jsonl", "/t/b.jsonl"];
    const parsedByPath: Record<string, TranscriptLine[]> = {
      "/t/a.jsonl": [{ type: "user" }],
      "/t/b.jsonl": [{ type: "assistant" }],
    };
    let resolveCallCount = 0;
    let parseCallCount = 0;
    const ctx = resolveDispatchContext(
      "PreToolUse",
      { transcript_path: "/t/main.jsonl", agent_id: "agent-1" },
      {
        hookFilename: DISPATCH_HOOK_FILENAME,
        readHostCapFn: () => fakeHostCap,
        resolveTranscriptCandidatesFn: (path, agentId) => {
          resolveCallCount++;
          expect(path).toBe("/t/main.jsonl");
          expect(agentId).toBe("agent-1");
          return resolvedCandidates;
        },
        parseTranscriptFn: (p) => {
          parseCallCount++;
          return parsedByPath[p] ?? [];
        },
      }
    );
    expect(resolveCallCount).toBe(1);
    expect(parseCallCount).toBe(2);
    expect(ctx.transcriptCandidates).toEqual(resolvedCandidates);
    expect(ctx.transcriptLines).toEqual([{ type: "user" }, { type: "assistant" }]);
  });

  test("passes hookFilename and events through to readHostCapFn", () => {
    let seenFilename = "";
    let seenEvents: readonly string[] | undefined;
    resolveDispatchContext(
      "PostToolUse",
      {},
      {
        hookFilename: "dispatch-posttooluse.ts",
        readHostCapFn: (filename, _dir, opts) => {
          seenFilename = filename;
          seenEvents = opts?.events;
          return fakeHostCap;
        },
      }
    );
    expect(seenFilename).toBe("dispatch-posttooluse.ts");
    expect(seenEvents).toEqual(["PostToolUse"]);
  });
});

// ---------------------------------------------------------------------------
// runDispatcher (D1 core loop)
// ---------------------------------------------------------------------------

function baseInput(overrides: Partial<ToolHookInput> = {}): ToolHookInput {
  return {
    session_id: "sess-1",
    cwd: "/tmp",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    ...overrides,
  };
}

function stubContext() {
  return {
    event: "PreToolUse" as const,
    hostCapSec: 15,
    budgets: { overallBudgetMs: 9000, fetchTimeoutMs: 4950, gitTimeoutMs: 1530 },
    transcriptCandidates: [],
    transcriptLines: [],
  };
}

describe("runDispatcher", () => {
  test("no guards match -> writeOutputFn never called, no stdout", async () => {
    const written: HookOutput[] = [];
    const stdout: string[] = [];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations: [
        {
          name: "g",
          event: "PreToolUse",
          matcher: "Edit",
          module: () => Promise.resolve({ run: () => ({ deny: { reason: "x" } }) }),
          timeoutMs: 1000,
          denyCapable: true,
        },
      ],
      readInputFn: () => Promise.resolve(baseInput({ tool_name: "Bash" })),
      writeOutputFn: (o) => written.push(o),
      stdoutWrite: (s) => stdout.push(s),
      resolveDispatchContextFn: () => stubContext(),
    });
    expect(written).toEqual([]);
    expect(stdout).toEqual([]);
  });

  test("deny-capable guard denies -> writeOutputFn called once, short-circuits later guards", async () => {
    const written: HookOutput[] = [];
    let secondGuardCalled = false;
    const registrations: GuardRegistration[] = [
      {
        name: "first",
        event: "PreToolUse",
        matcher: "Bash",
        module: () => Promise.resolve({ run: () => ({ deny: { reason: "nope" } }) }),
        timeoutMs: 1000,
        denyCapable: true,
      },
      {
        name: "second",
        event: "PreToolUse",
        matcher: "Bash",
        module: () =>
          Promise.resolve({
            run: () => {
              secondGuardCalled = true;
              return null;
            },
          }),
        timeoutMs: 1000,
        denyCapable: true,
      },
    ];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations,
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: (o) => written.push(o),
      resolveDispatchContextFn: () => stubContext(),
    });
    expect(written.length).toBe(1);
    expect(written[0]?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(written[0]?.hookSpecificOutput?.permissionDecisionReason).toBe("nope");
    expect(secondGuardCalled).toBe(false);
  });

  test("multiple guards contribute additionalContext -> concatenated into one output", async () => {
    const written: HookOutput[] = [];
    const registrations: GuardRegistration[] = [
      {
        name: "a",
        event: "PreToolUse",
        matcher: "Bash",
        module: () => Promise.resolve({ run: () => ({ additionalContext: "fragment A" }) }),
        timeoutMs: 1000,
        denyCapable: false,
      },
      {
        name: "b",
        event: "PreToolUse",
        matcher: "Bash",
        module: () => Promise.resolve({ run: () => ({ additionalContext: "fragment B" }) }),
        timeoutMs: 1000,
        denyCapable: false,
      },
    ];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations,
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: (o) => written.push(o),
      resolveDispatchContextFn: () => stubContext(),
    });
    expect(written.length).toBe(1);
    expect(written[0]?.hookSpecificOutput?.additionalContext).toBe("fragment A\n\nfragment B");
    expect(written[0]?.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  test("override suppresses the guard entirely — run() never invoked, audit line emitted", async () => {
    const written: HookOutput[] = [];
    const stdout: string[] = [];
    let guardInvoked = false;
    const registrations: GuardRegistration[] = [
      {
        name: "pilot",
        event: "PreToolUse",
        matcher: "Bash",
        module: () =>
          Promise.resolve({
            run: () => {
              guardInvoked = true;
              return { deny: { reason: "would have denied" } };
            },
          }),
        timeoutMs: 1000,
        denyCapable: true,
      },
    ];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations,
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: (o) => written.push(o),
      stdoutWrite: (s) => stdout.push(s),
      resolveDispatchContextFn: () => stubContext(),
    });
    // Simulate the override by setting env for a second run — checkOverride
    // reads process.env directly, so exercise it via a real env mutation
    // scoped to this test.
    process.env[HOOK_OVERRIDE_ENV_VAR] = "pilot";
    try {
      guardInvoked = false;
      written.length = 0;
      stdout.length = 0;
      await runDispatcher("PreToolUse", {
        hookFilename: DISPATCH_HOOK_FILENAME,
        registrations,
        readInputFn: () => Promise.resolve(baseInput()),
        writeOutputFn: (o) => written.push(o),
        stdoutWrite: (s) => stdout.push(s),
        resolveDispatchContextFn: () => stubContext(),
      });
      expect(guardInvoked).toBe(false);
      expect(written).toEqual([]);
      expect(stdout.length).toBe(1);
      expect(stdout[0]).toContain("OVERRIDE: guard=pilot");
    } finally {
      delete process.env[HOOK_OVERRIDE_ENV_VAR];
    }
  });

  test("a guard that throws is caught, logged to stderr, and does not disable other guards", async () => {
    const written: HookOutput[] = [];
    const stderr: string[] = [];
    let secondGuardCalled = false;
    const registrations: GuardRegistration[] = [
      {
        name: "throws",
        event: "PreToolUse",
        matcher: "Bash",
        module: () =>
          Promise.resolve({
            run: () => {
              throw new Error("boom");
            },
          }),
        timeoutMs: 1000,
        denyCapable: true,
      },
      {
        name: "second",
        event: "PreToolUse",
        matcher: "Bash",
        module: () =>
          Promise.resolve({
            run: () => {
              secondGuardCalled = true;
              return { additionalContext: "ok" };
            },
          }),
        timeoutMs: 1000,
        denyCapable: false,
      },
    ];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations,
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: (o) => written.push(o),
      stderrWrite: (s) => stderr.push(s),
      resolveDispatchContextFn: () => stubContext(),
    });
    expect(stderr.length).toBe(1);
    expect(stderr[0]).toContain("guard=throws threw: boom");
    expect(secondGuardCalled).toBe(true);
    expect(written[0]?.hookSpecificOutput?.additionalContext).toBe("ok");
  });

  // mt#2812: a thrown guard error is recorded for guard-health aggregation,
  // IN ADDITION to the existing stderr line, and never disables the guard
  // loop even if the recording itself misbehaves.
  test("a guard that throws is recorded via recordGuardErrorFn with guard name, event, error, and tool context", async () => {
    const recorded: Array<{
      guardName: string;
      event: string;
      error: unknown;
      toolName?: string;
      sessionId?: string;
    }> = [];
    const registrations: GuardRegistration[] = [
      {
        name: "throws",
        event: "PreToolUse",
        matcher: "Bash",
        module: () =>
          Promise.resolve({
            run: () => {
              throw new Error("boom");
            },
          }),
        timeoutMs: 1000,
        denyCapable: true,
      },
    ];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations,
      readInputFn: () =>
        Promise.resolve({ ...baseInput(), tool_name: "Bash", session_id: "sess-42" }),
      writeOutputFn: () => {},
      stderrWrite: () => {},
      resolveDispatchContextFn: () => stubContext(),
      recordGuardErrorFn: (input) => recorded.push(input),
    });
    expect(recorded.length).toBe(1);
    expect(recorded[0]?.guardName).toBe("throws");
    expect(recorded[0]?.event).toBe("PreToolUse");
    expect(recorded[0]?.error).toBeInstanceOf(Error);
    expect((recorded[0]?.error as Error).message).toBe("boom");
    expect(recorded[0]?.toolName).toBe("Bash");
    expect(recorded[0]?.sessionId).toBe("sess-42");
  });

  test("the default recordGuardErrorFn (real recordGuardError) never throws — guard loop is fail-safe by contract, no redundant dispatcher-side try/catch needed", async () => {
    // recordGuardError's own internal swallow-all is covered directly in
    // guard-health.test.ts ("NEVER throws even when the fs seam throws").
    // This test confirms the DEFAULT wiring (no recordGuardErrorFn override)
    // runs to completion end-to-end when a guard throws — i.e. the real
    // production capture path never disables the dispatcher, matching the
    // mt#2812 acceptance test ("Tracker DB/log unavailable -> guards still
    // run normally"). Points MINSKY_STATE_DIR at a throwaway path so this
    // test never touches the developer's real guard-health log.
    const prevStateDir = process.env.MINSKY_STATE_DIR;
    process.env.MINSKY_STATE_DIR = "/nonexistent/mt2812-dispatcher-default-recording-test";
    try {
      const written: HookOutput[] = [];
      let secondGuardCalled = false;
      const registrations: GuardRegistration[] = [
        {
          name: "throws",
          event: "PreToolUse",
          matcher: "Bash",
          module: () =>
            Promise.resolve({
              run: () => {
                throw new Error("boom");
              },
            }),
          timeoutMs: 1000,
          denyCapable: true,
        },
        {
          name: "second",
          event: "PreToolUse",
          matcher: "Bash",
          module: () =>
            Promise.resolve({
              run: () => {
                secondGuardCalled = true;
                return { additionalContext: "ok" };
              },
            }),
          timeoutMs: 1000,
          denyCapable: false,
        },
      ];
      await runDispatcher("PreToolUse", {
        hookFilename: DISPATCH_HOOK_FILENAME,
        registrations,
        readInputFn: () => Promise.resolve(baseInput()),
        writeOutputFn: (o) => written.push(o),
        stderrWrite: () => {},
        resolveDispatchContextFn: () => stubContext(),
        // No recordGuardErrorFn override — exercises the real default.
      });
      expect(secondGuardCalled).toBe(true);
      expect(written[0]?.hookSpecificOutput?.additionalContext).toBe("ok");
    } finally {
      if (prevStateDir === undefined) delete process.env.MINSKY_STATE_DIR;
      else process.env.MINSKY_STATE_DIR = prevStateDir;
    }
  });

  test("calibration outcome is logged via logCalibrationRecordFn when the registration declares calibrationLog", async () => {
    const logged: Array<{ name: string; record: Record<string, unknown> }> = [];
    const registrations: GuardRegistration[] = [
      {
        name: "detector",
        event: "PreToolUse",
        matcher: "Bash",
        module: () =>
          Promise.resolve({
            run: () => ({ calibration: { matched: true } }),
          }),
        timeoutMs: 1000,
        denyCapable: false,
        calibrationLog: "detector-log",
      },
    ];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations,
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: () => {},
      logCalibrationRecordFn: (name, record) => logged.push({ name, record }),
      resolveDispatchContextFn: () => stubContext(),
    });
    expect(logged).toEqual([{ name: "detector-log", record: { matched: true } }]);
  });

  test("calibration outcome without a registered calibrationLog is not logged", async () => {
    let called = false;
    const registrations: GuardRegistration[] = [
      {
        name: "detector",
        event: "PreToolUse",
        matcher: "Bash",
        module: () => Promise.resolve({ run: () => ({ calibration: { matched: true } }) }),
        timeoutMs: 1000,
        denyCapable: false,
      },
    ];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations,
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: () => {},
      logCalibrationRecordFn: () => {
        called = true;
      },
      resolveDispatchContextFn: () => stubContext(),
    });
    expect(called).toBe(false);
  });

  test("guard-emitted auditLines are written to stdout verbatim", async () => {
    const stdout: string[] = [];
    const registrations: GuardRegistration[] = [
      {
        name: "g",
        event: "PreToolUse",
        matcher: "Bash",
        module: () =>
          Promise.resolve({ run: () => ({ auditLines: ["[g] legacy override active\n"] }) }),
        timeoutMs: 1000,
        denyCapable: false,
      },
    ];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations,
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: () => {},
      stdoutWrite: (s) => stdout.push(s),
      resolveDispatchContextFn: () => stubContext(),
    });
    expect(stdout).toEqual(["[g] legacy override active\n"]);
  });
});
