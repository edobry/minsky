/* eslint-disable custom/no-real-fs-in-tests -- this file's real fs use is
   (a) the isolated MINSKY_STATE_DIR temp directory required by the *default*
   recordFireLogEntry wiring under test (see beforeAll below; mirrors the
   exemption in guard-health-dispatcher-integration.test.ts and
   dispatch-userpromptsubmit.e2e.test.ts), and (b) the real mkdtemp scratch
   directories used by the guard-health write-path tests (mt#2875 — replacing
   the assumed-unwritable "/nonexistent/..." trick that leaked fixture rows,
   guardName "throws" / sessionId "sess-1", into the operator's live
   ~/.local/state/minsky/guard-health-log.jsonl). Neither touches the
   developer's actual ~/.local/state/minsky/. */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkOverride,
  buildOverrideAuditLine,
  buildOverrideFireLogFields,
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
import type { RecordFireLogInput } from "./fire-log";

/** The dispatcher's own compiled filename, used throughout as `hookFilename`. */
const DISPATCH_HOOK_FILENAME = "dispatch-pretooluse.ts";

// mt#2597: runDispatcher now fire-logs EVERY matched guard's outcome via the
// real `recordFireLogEntry` default when a test doesn't inject
// `recordFireLogFn`. Point MINSKY_STATE_DIR at an isolated temp dir for the
// WHOLE file's duration (rather than adding `recordFireLogFn: () => {}` to
// every pre-existing call site) so no test in this file — new or
// pre-existing — can ever write through the developer's real
// `~/.local/state/minsky/fire-log.jsonl` (the mt#2876 class this task's
// coordination brief calls out explicitly).
let fireLogTestStateDir: string;
let prevMinskyStateDir: string | undefined;

beforeAll(() => {
  fireLogTestStateDir = mkdtempSync(join(tmpdir(), "mt2597-dispatcher-fire-log-isolation-"));
  prevMinskyStateDir = process.env.MINSKY_STATE_DIR;
  process.env.MINSKY_STATE_DIR = fireLogTestStateDir;
});

afterAll(() => {
  if (prevMinskyStateDir === undefined) delete process.env.MINSKY_STATE_DIR;
  else process.env.MINSKY_STATE_DIR = prevMinskyStateDir;
  rmSync(fireLogTestStateDir, { recursive: true, force: true });
});

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

/** mt#2597 R1 — extracted to satisfy custom/no-magic-string-duplication across
 * the `buildOverrideFireLogFields` test cases below. */
const AUTHORIZED_EXCEPTION = "authorized_exception";

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

  // mt#2710: real-fs regression for the hooks-resolve-input.cwd-raw fix.
  // Sets `CLAUDE_PROJECT_DIR` to a repo SUBDIRECTORY rather than calling
  // `process.chdir()` — this exercises the SAME fallback chain production
  // hits at the real `runDispatcher` call site (`logCalibration(reg.
  // calibrationLog, outcome.calibration)`, which passes no `projectDir`)
  // without mutating the shared `process.cwd()` for the rest of this test
  // file's (possibly concurrent) suite. Uses a REAL temp directory (not the
  // injectable `MergeDetectFs`) because `findRepoRoot`'s default fs
  // parameter is real fs — this file already exempts
  // `custom/no-real-fs-in-tests` at the top for the same class of
  // real-directory-structure need (see file-header comment).
  test("walks up from a repo SUBDIRECTORY to the real repo root (mt#2710 acceptance test)", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "mt2710-calibration-log-path-"));
    try {
      mkdirSync(join(repoRoot, ".git"));
      const subDir = join(repoRoot, "cockpit-tray", "src-tauri");
      mkdirSync(subDir, { recursive: true });

      const prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
      process.env.CLAUDE_PROJECT_DIR = subDir;
      try {
        // No `projectDir` argument — matches the real `runDispatcher` call
        // site.
        const result = calibrationLogPath("causal-premise");
        expect(result).toBe(join(repoRoot, ".minsky", "causal-premise-calibration.jsonl"));
        // The stray-subdirectory bug this fix closes: no `.minsky/` under
        // the subdirectory `CLAUDE_PROJECT_DIR` pointed at.
        expect(result.startsWith(subDir)).toBe(false);
      } finally {
        if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
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
      // Recording is not this test's subject — stub it so the throwing guard
      // never reaches the real guard-health log (mt#2872: this test's default
      // recorder wrote fixture "throws"/"boom" rows into the operator's real
      // state and fired a CRITICAL escalation; tests/setup.ts now also
      // isolates MINSKY_STATE_DIR globally as the class-level backstop).
      recordGuardErrorFn: () => {},
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
    // run normally"). Points MINSKY_STATE_DIR at a real mkdtemp scratch
    // directory (mt#2875 fix) — NOT an assumed-unwritable literal path — so
    // the real write path lands somewhere hermetically isolated and cleaned
    // up afterward, rather than depending on the OS rejecting a write to a
    // hardcoded "/nonexistent/..." path (that reliance is the mt#2875
    // root-cause candidate for the "throws"/"boom"/"sess-1" fixture rows
    // found in the operator's live guard-health-log.jsonl on 2026-07-16).
    const scratchDir = mkdtempSync(join(tmpdir(), "mt2875-dispatcher-default-recording-test-"));
    const prevStateDir = process.env.MINSKY_STATE_DIR;
    process.env.MINSKY_STATE_DIR = scratchDir;
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

      // Confirm the real write actually landed in the scratch dir (proves
      // MINSKY_STATE_DIR scoping isolates the write, rather than the prior
      // test merely hoping the write silently failed).
      const scratchLogPath = join(scratchDir, "guard-health-log.jsonl");
      const scratchContent = readFileSync(scratchLogPath, "utf-8");
      expect(scratchContent).toContain('"guardName":"throws"');
      expect(scratchContent).toContain('"message":"boom"');
    } finally {
      if (prevStateDir === undefined) delete process.env.MINSKY_STATE_DIR;
      else process.env.MINSKY_STATE_DIR = prevStateDir;
      rmSync(scratchDir, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// Fire-log integration (mt#2597, evaluation-loop Phase 1)
// ---------------------------------------------------------------------------

describe("runDispatcher fire-log integration (mt#2597)", () => {
  function makeFireLogSpy(): {
    records: RecordFireLogInput[];
    fn: (i: RecordFireLogInput) => void;
  } {
    const records: RecordFireLogInput[] = [];
    return { records, fn: (i) => records.push(i) };
  }

  test("a silently-allowed guard (null outcome) is still fire-logged as allow — 'including silent-allow'", async () => {
    const spy = makeFireLogSpy();
    const registrations: GuardRegistration[] = [
      {
        name: "silent",
        event: "PreToolUse",
        matcher: "Bash",
        module: () => Promise.resolve({ run: () => null }),
        timeoutMs: 1000,
        denyCapable: false,
      },
    ];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations,
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: () => {},
      resolveDispatchContextFn: () => stubContext(),
      recordFireLogFn: spy.fn,
    });
    expect(spy.records.length).toBe(1);
    expect(spy.records[0]?.guardName).toBe("silent");
    expect(spy.records[0]?.decision).toBe("allow");
    expect(spy.records[0]?.overrideEnvVar).toBeUndefined();
    expect(typeof spy.records[0]?.durationMs).toBe("number");
  });

  test("a denying guard is fire-logged as deny", async () => {
    const spy = makeFireLogSpy();
    const registrations: GuardRegistration[] = [
      {
        name: "denier",
        event: "PreToolUse",
        matcher: "Bash",
        module: () => Promise.resolve({ run: () => ({ deny: { reason: "nope" } }) }),
        timeoutMs: 1000,
        denyCapable: true,
      },
    ];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations,
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: () => {},
      resolveDispatchContextFn: () => stubContext(),
      recordFireLogFn: spy.fn,
    });
    expect(spy.records.length).toBe(1);
    expect(spy.records[0]?.decision).toBe("deny");
  });

  test("a guard contributing additionalContext (no deny) is fire-logged as warn", async () => {
    const spy = makeFireLogSpy();
    const registrations: GuardRegistration[] = [
      {
        name: "informer",
        event: "PreToolUse",
        matcher: "Bash",
        module: () => Promise.resolve({ run: () => ({ additionalContext: "fyi" }) }),
        timeoutMs: 1000,
        denyCapable: false,
      },
    ];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations,
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: () => {},
      resolveDispatchContextFn: () => stubContext(),
      recordFireLogFn: spy.fn,
    });
    expect(spy.records.length).toBe(1);
    expect(spy.records[0]?.decision).toBe("warn");
  });

  test("a guard that throws is still fire-logged as allow (fail-open) in addition to guard-health's error record", async () => {
    const spy = makeFireLogSpy();
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
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: () => {},
      stderrWrite: () => {},
      resolveDispatchContextFn: () => stubContext(),
      recordGuardErrorFn: () => {},
      recordFireLogFn: spy.fn,
    });
    expect(spy.records.length).toBe(1);
    expect(spy.records[0]?.guardName).toBe("throws");
    expect(spy.records[0]?.decision).toBe("allow");
  });

  test("an env-var override is fire-logged with overrideEnvVar=MINSKY_HOOK_OVERRIDE, classification=authorized_exception — the guard itself is never invoked", async () => {
    const spy = makeFireLogSpy();
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
    process.env[HOOK_OVERRIDE_ENV_VAR] = "pilot";
    try {
      await runDispatcher("PreToolUse", {
        hookFilename: DISPATCH_HOOK_FILENAME,
        registrations,
        readInputFn: () => Promise.resolve(baseInput()),
        writeOutputFn: () => {},
        stdoutWrite: () => {},
        resolveDispatchContextFn: () => stubContext(),
        recordFireLogFn: spy.fn,
      });
    } finally {
      delete process.env[HOOK_OVERRIDE_ENV_VAR];
    }
    expect(guardInvoked).toBe(false);
    expect(spy.records.length).toBe(1);
    expect(spy.records[0]?.decision).toBe("allow");
    expect(spy.records[0]?.overrideEnvVar).toBe(HOOK_OVERRIDE_ENV_VAR);
    expect(spy.records[0]?.overrideClassification).toBe("authorized_exception");
    expect(spy.records[0]?.overrideSource).toBe("env");
  });

  // NOTE: a grant-file-channel override (mt#2658 Phase-7 adjunct — `checkOverride`
  // consulting the grant store instead of the `MINSKY_HOOK_OVERRIDE` env var) is
  // NOT reachable through a full `runDispatcher()` call today — that call site
  // never passes a `scope` to `checkOverride` (grant-file consultation is a
  // per-guard concern, e.g. `parallel-work-guard.ts`, not a dispatcher-loop one).
  // The env->grant attribution logic itself (`buildOverrideFireLogFields`,
  // covering grant-only/env-only/both-channels-present) is unit-tested directly
  // below, and `classifyOverride`'s own three-way split is covered in
  // fire-log.test.ts's `classifyOverride` suite.
  describe("buildOverrideFireLogFields (mt#2597 R1 — env/grant attribution)", () => {
    test("grant-only override (no raw env-var involved at all) -> source=grant, classification=authorized_exception, no overrideEnvVar", () => {
      const fields = buildOverrideFireLogFields({ overridden: true, grantReason: GRANT_REASON });
      expect(fields).toEqual({
        overrideSource: "grant",
        overrideClassification: AUTHORIZED_EXCEPTION,
      });
    });

    test("env-only override (no grant involved) -> source=env, overrideEnvVar=MINSKY_HOOK_OVERRIDE, classification=authorized_exception", () => {
      const fields = buildOverrideFireLogFields({ overridden: true, raw: "pilot" });
      expect(fields).toEqual({
        overrideSource: "env",
        overrideEnvVar: HOOK_OVERRIDE_ENV_VAR,
        overrideClassification: AUTHORIZED_EXCEPTION,
      });
    });

    test("both raw and grantReason present (env var set for a DIFFERENT guard/token, this guard's override came from a grant) -> attributes to grant, mirroring checkOverride's own precedence rather than re-deriving it", () => {
      // checkOverride() only ever returns BOTH `raw` and `grantReason` together
      // when the grant channel is what decided — the env channel returns early
      // (before the grant branch runs) whenever IT decides. So "both present"
      // here means "grant decided while an unrelated env token happened to be
      // set," not "env decided."
      const fields = buildOverrideFireLogFields({
        overridden: true,
        raw: "some-other-guard",
        grantReason: GRANT_REASON,
      });
      expect(fields).toEqual({
        overrideSource: "grant",
        overrideClassification: AUTHORIZED_EXCEPTION,
      });
    });
  });

  test("multiple matched guards each produce exactly one fire-log record, in registry order", async () => {
    const spy = makeFireLogSpy();
    const registrations: GuardRegistration[] = [
      {
        name: "a",
        event: "PreToolUse",
        matcher: "Bash",
        module: () => Promise.resolve({ run: () => ({ additionalContext: "A" }) }),
        timeoutMs: 1000,
        denyCapable: false,
      },
      {
        name: "b",
        event: "PreToolUse",
        matcher: "Bash",
        module: () => Promise.resolve({ run: () => null }),
        timeoutMs: 1000,
        denyCapable: false,
      },
    ];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations,
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: () => {},
      resolveDispatchContextFn: () => stubContext(),
      recordFireLogFn: spy.fn,
    });
    expect(spy.records.map((r) => r.guardName)).toEqual(["a", "b"]);
    expect(spy.records.map((r) => r.decision)).toEqual(["warn", "allow"]);
  });

  test("a deny-capable guard's deny short-circuits later guards, but the denying guard's own fire-log record is still written", async () => {
    const spy = makeFireLogSpy();
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
      writeOutputFn: () => {},
      resolveDispatchContextFn: () => stubContext(),
      recordFireLogFn: spy.fn,
    });
    expect(secondGuardCalled).toBe(false);
    expect(spy.records.length).toBe(1);
    expect(spy.records[0]?.guardName).toBe("first");
    expect(spy.records[0]?.decision).toBe("deny");
  });

  test("the default recordFireLogFn (real recordFireLogEntry) never throws end-to-end — isolated MINSKY_STATE_DIR (file-level beforeAll) is honored", async () => {
    const written: HookOutput[] = [];
    const registrations: GuardRegistration[] = [
      {
        name: "g",
        event: "PreToolUse",
        matcher: "Bash",
        module: () => Promise.resolve({ run: () => ({ additionalContext: "ok" }) }),
        timeoutMs: 1000,
        denyCapable: false,
      },
    ];
    // No recordFireLogFn override — exercises the real default wiring,
    // writing into fireLogTestStateDir (set by this file's beforeAll), never
    // the developer's real ~/.local/state/minsky/fire-log.jsonl.
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations,
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: (o) => written.push(o),
      resolveDispatchContextFn: () => stubContext(),
    });
    expect(written[0]?.hookSpecificOutput?.additionalContext).toBe("ok");
  });
});
