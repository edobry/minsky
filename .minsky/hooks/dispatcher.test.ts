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
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMinskyStateDir } from "@minsky/shared/paths";
import {
  checkOverride,
  buildOverrideAuditLine,
  buildOverrideFireLogFields,
  calibrationLogPath,
  logCalibrationRecord,
  evaluationLogPath,
  logEvaluationRecord,
  projectStateKey,
  resolveDispatchContext,
  runDispatcher,
  composeAdditionalContext,
  DEFAULT_CONTEXT_PRIORITY,
  MERGED_CONTEXT_BUDGET_CHARS,
  HOOK_OVERRIDE_ENV_VAR,
  type CalibrationWriteDeps,
  type ContextFragment,
} from "./dispatcher";
import { GUARD_REGISTRY } from "./registry";
import type { GuardRegistration, GuardEffectDeclaration } from "./registry";
import type { ToolHookInput, HookOutput, HostCapInfo } from "./types";
import type { TranscriptLine } from "./transcript";

/**
 * Shared placeholder `effects` declaration for this file's ad-hoc
 * `GuardRegistration` fixtures (mt#3981 made the field required). These
 * fixtures test dispatcher MECHANICS — deny short-circuiting, output
 * composition, timeout handling — not posture semantics, so one uniform
 * "deny" validator declaration satisfies the type everywhere without
 * repeating the object literal at each of this file's call sites.
 */
const FIXTURE_EFFECTS: [GuardEffectDeclaration, ...GuardEffectDeclaration[]] = [
  {
    effect: "deny",
    verdictShape: "validator",
    failurePolicy: { failurePolicy: "closed", degradedPolicy: "closed" },
  },
];
import type { RecordFireLogInput } from "./fire-log";
import {
  DISPATCH_HOOK_FILENAME,
  baseInput,
  stubContext,
  makeStderrSpy,
  useIsolatedStateDir,
} from "./test-support/dispatcher-harness";

const USER_PROMPT_SUBMIT = "UserPromptSubmit";

// mt#2597: runDispatcher now fire-logs EVERY matched guard's outcome via the
// real `recordFireLogEntry` default when a test doesn't inject
// `recordFireLogFn`. Point MINSKY_STATE_DIR at an isolated temp dir for the
// WHOLE file's duration (rather than adding `recordFireLogFn: () => {}` to
// every pre-existing call site) so no test in this file — new or
// pre-existing — can ever write through the developer's real
// `~/.local/state/minsky/fire-log.jsonl` (the mt#2876 class this task's
// coordination brief calls out explicitly).
useIsolatedStateDir("mt2597-dispatcher-fire-log-isolation-");

// ---------------------------------------------------------------------------
// checkOverride (D3)
// ---------------------------------------------------------------------------

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
    // Annotated alias: `seenArgs` is only ever assigned inside the findGuardGrant
    // callback, which control-flow analysis cannot see running, so it narrows to
    // `null` here and `toEqual` would then only accept `null` (mt#2900).
    const capturedArgs = seenArgs as [string, string, number] | null;
    expect(capturedArgs).toEqual(["duplicate-child-matcher", "mt#2581", 1000]);
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

// mt#4748: calibration/evaluation logs resolve under the state dir,
// project-keyed — not under the repo. Mirrors `calibrationLogPath` /
// `evaluationLogPath`'s own resolution so an exact-path assertion computes
// it rather than hardcoding a string that would silently drift.
function expectedStatePath(repoRoot: string, name: string, suffix: string): string {
  return join(getMinskyStateDir(), "projects", projectStateKey(repoRoot), `${name}${suffix}`);
}
const expectedCalibrationPath = (repoRoot: string, name: string) =>
  expectedStatePath(repoRoot, name, "-calibration.jsonl");
const expectedEvaluationPath = (repoRoot: string, name: string) =>
  expectedStatePath(repoRoot, name, "-evaluations.jsonl");

describe("calibrationLogPath", () => {
  test("preserves the existing CALIBRATION_LOG_REGISTRY filename convention; mt#4748 SC2 never under the repo root", () => {
    const result = calibrationLogPath("causal-premise", { projectDir: "/repo" });
    expect(result).toBe(expectedCalibrationPath("/repo", "causal-premise"));
    expect(result.startsWith("/repo")).toBe(false);
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
        expect(result).toBe(expectedCalibrationPath(repoRoot, "causal-premise"));
        // The stray-subdirectory bug this fix closes: no path under
        // the subdirectory `CLAUDE_PROJECT_DIR` pointed at.
        expect(result.startsWith(subDir)).toBe(false);
        // mt#4748 SC2: nor under the repo root itself anymore — the whole
        // point of the state-dir move.
        expect(result.startsWith(repoRoot)).toBe(false);
      } finally {
        if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// evaluationLogPath / logEvaluationRecord (mt#3745)
// ---------------------------------------------------------------------------

describe("evaluationLogPath", () => {
  test("uses the -evaluations.jsonl filename convention", () => {
    expect(evaluationLogPath("silent-stretch", { projectDir: "/repo" })).toBe(
      expectedEvaluationPath("/repo", "silent-stretch")
    );
  });

  // AT1 — the regression this task exists to pin. Two of the three hand-rolled
  // writers resolved `findRepoRoot(cwd)` directly, so with cwd pointing at a
  // session workspace the stream landed THERE while the calibration log —
  // routed through `calibrationLogPath` — landed in the repo. 12 stray files
  // across 6 workspaces; the one detector that already preferred
  // CLAUDE_PROJECT_DIR had zero.
  test("CLAUDE_PROJECT_DIR outranks a guard's raw cwd (mt#3745 acceptance test)", () => {
    const projectRepo = mkdtempSync(join(tmpdir(), "mt3745-project-"));
    const strayRepo = mkdtempSync(join(tmpdir(), "mt3745-stray-"));
    try {
      mkdirSync(join(projectRepo, ".git"));
      mkdirSync(join(strayRepo, ".git"));

      const prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
      process.env.CLAUDE_PROJECT_DIR = projectRepo;
      try {
        // `fallbackCwd` is what a guard passes from `input.cwd` — it must NOT win.
        const result = evaluationLogPath("silent-stretch", { fallbackCwd: strayRepo });
        expect(result).toBe(expectedEvaluationPath(projectRepo, "silent-stretch"));
        expect(result.startsWith(strayRepo)).toBe(false);
      } finally {
        if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
      }
    } finally {
      rmSync(projectRepo, { recursive: true, force: true });
      rmSync(strayRepo, { recursive: true, force: true });
    }
  });

  test("falls back to the guard's cwd when CLAUDE_PROJECT_DIR is unset", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "mt3745-fallback-"));
    try {
      mkdirSync(join(repoRoot, ".git"));
      const prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
      delete process.env.CLAUDE_PROJECT_DIR;
      try {
        expect(evaluationLogPath("stop-at-decision", { fallbackCwd: repoRoot })).toBe(
          expectedEvaluationPath(repoRoot, "stop-at-decision")
        );
      } finally {
        if (prevProjectDir !== undefined) process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("an explicit projectDir outranks CLAUDE_PROJECT_DIR", () => {
    const prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = "/env-dir";
    try {
      expect(evaluationLogPath("retrospective-trigger", { projectDir: "/explicit" })).toBe(
        expectedEvaluationPath("/explicit", "retrospective-trigger")
      );
    } finally {
      if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
    }
  });
});

describe("logEvaluationRecord", () => {
  test("writes one JSONL record to the resolved path", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "mt3745-write-"));
    try {
      mkdirSync(join(repoRoot, ".git"));
      logEvaluationRecord("silent-stretch", { hook: "x", fired: false }, { projectDir: repoRoot });
      const writtenPath = expectedEvaluationPath(repoRoot, "silent-stretch");
      const written = readFileSync(writtenPath, "utf-8");
      expect(JSON.parse(written.trim())).toEqual({ hook: "x", fired: false });
      // mt#4748: the write now lands under the shared state dir rather than
      // inside `repoRoot`, so `rmSync(repoRoot, ...)` below no longer cleans
      // it up — remove it explicitly.
      rmSync(writtenPath, { force: true });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  // The measurement stream must never be able to break the guard it measures.
  test("fails open when the write throws, and reports rather than swallowing", () => {
    const messages: string[] = [];
    const prevWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string) => {
      messages.push(String(chunk));
      return true;
    };
    try {
      expect(() =>
        logEvaluationRecord(
          "silent-stretch",
          { hook: "x" },
          {
            projectDir: "/repo",
            deps: {
              existsSync: () => false,
              mkdirSync: () => {
                throw new Error("EROFS: read-only file system");
              },
              appendFileSync: () => undefined,
            },
          }
        )
      ).not.toThrow();
    } finally {
      (process.stderr as any).write = prevWrite;
    }
    expect(messages.join("")).toContain("EROFS");
    expect(messages.join("")).toContain("silent-stretch");
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
    const content = deps.files.get(expectedCalibrationPath("/repo", "causal-premise"));
    expect(content).toBeDefined();
    expect(JSON.parse((content ?? "").trim())).toEqual({ timestamp: "T", matchedPhrases: ["x"] });
  });

  test("creates the parent dir when missing", () => {
    const deps = makeFakeDeps();
    logCalibrationRecord("x", { a: 1 }, { projectDir: "/repo", deps });
    expect(deps.dirsCreated).toContain(
      join(getMinskyStateDir(), "projects", projectStateKey("/repo"))
    );
  });

  test("does not recreate an already-existing dir", () => {
    const deps = makeFakeDeps();
    deps.dirsCreated.push(join(getMinskyStateDir(), "projects", projectStateKey("/repo")));
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

  /**
   * `resolveDispatchContext` takes a Pick of ToolHookInput in which `session_id`
   * is REQUIRED — these fixtures only ever vary transcript_path/agent_id, so the
   * id is supplied once here rather than repeated at every call site (mt#2900).
   */
  function dispatchInput(
    overrides: Partial<Pick<ToolHookInput, "agent_id" | "session_id" | "transcript_path">> = {}
  ): Pick<ToolHookInput, "agent_id" | "session_id" | "transcript_path"> {
    return {
      session_id: "dispatcher-test-session",
      transcript_path: undefined,
      agent_id: undefined,
      ...overrides,
    };
  }

  test("no transcript_path -> empty candidates/lines, budgets still derived", () => {
    const ctx = resolveDispatchContext("PreToolUse", dispatchInput(), {
      hookFilename: DISPATCH_HOOK_FILENAME,
      readHostCapFn: () => fakeHostCap,
    });
    expect(ctx.transcriptCandidates).toEqual([]);
    expect(ctx.transcriptLines).toEqual([]);
    expect(ctx.hostCapSec).toBe(20);
    expect(ctx.budgets.overallBudgetMs).toBeGreaterThan(0);
    expect(ctx.event).toBe("PreToolUse");
  });

  test("single candidate -> parses it and uses the flattened result as-is", () => {
    let resolveCallCount = 0;
    let parseCallCount = 0;
    const ctx = resolveDispatchContext(
      "PreToolUse",
      dispatchInput({ transcript_path: "/t/main.jsonl" }),
      {
        hookFilename: DISPATCH_HOOK_FILENAME,
        readHostCapFn: () => fakeHostCap,
        resolveTranscriptCandidatesFn: (path, agentId) => {
          resolveCallCount++;
          expect(path).toBe("/t/main.jsonl");
          expect(agentId).toBeUndefined();
          return ["/t/main.jsonl"];
        },
        parseTranscriptFn: (p) => {
          parseCallCount++;
          return p === "/t/main.jsonl" ? [{ type: "user" }, { type: "assistant" }] : [];
        },
      }
    );
    expect(resolveCallCount).toBe(1);
    expect(parseCallCount).toBe(1);
    expect(ctx.transcriptCandidates).toEqual(["/t/main.jsonl"]);
    expect(ctx.transcriptLines).toEqual([{ type: "user" }, { type: "assistant" }]);
  });

  // mt#3293 — `ctx.transcriptLines` is PARENT-ONLY by construction. Before the hoist this
  // field was `candidates.flatMap(parse)`, so a conversation that had dispatched subagents
  // handed every consumer the parent's lines with each completed subagent transcript
  // concatenated after them. Turn extraction over that array can anchor inside a static
  // subagent segment and re-measure the same frozen turn forever (mt#3003).
  test("parent + subagent candidates -> parses ONLY the parent, never the subagent", () => {
    const parentPath = "/t/main.jsonl";
    const subagentPath = "/t/subagents/agent-abc.jsonl";
    const parentLines: TranscriptLine[] = [{ type: "user" }, { type: "assistant" }];
    const parsedPaths: string[] = [];

    const ctx = resolveDispatchContext(
      USER_PROMPT_SUBMIT,
      dispatchInput({ transcript_path: parentPath }),
      {
        hookFilename: DISPATCH_HOOK_FILENAME,
        readHostCapFn: () => fakeHostCap,
        resolveTranscriptCandidatesFn: () => [parentPath, subagentPath],
        parseTranscriptFn: (p) => {
          parsedPaths.push(p);
          if (p === parentPath) return parentLines;
          throw new Error(`subagent transcript must never be parsed for ctx.transcriptLines: ${p}`);
        },
      }
    );

    expect(parsedPaths).toEqual([parentPath]);
    expect(ctx.transcriptLines).toEqual(parentLines);
    // The candidate list itself is unchanged — a guard that genuinely wants every
    // candidate can still walk it and parse them explicitly.
    expect(ctx.transcriptCandidates).toEqual([parentPath, subagentPath]);
  });

  // The candidate array is NOT positionally ordered parent-first: when the invocation's own
  // `transcript_path` is a per-agent file, `resolveTranscriptCandidates` puts that file FIRST
  // and the true parent later. Parent identification is structural, not positional.
  test("subagent candidate listed FIRST -> still resolves the parent's lines", () => {
    const parentPath = "/t/main.jsonl";
    const subagentPath = "/t/subagents/agent-abc.jsonl";
    const parentLines: TranscriptLine[] = [{ type: "user" }];

    const ctx = resolveDispatchContext(
      USER_PROMPT_SUBMIT,
      dispatchInput({ transcript_path: subagentPath, agent_id: "abc" }),
      {
        hookFilename: DISPATCH_HOOK_FILENAME,
        readHostCapFn: () => fakeHostCap,
        resolveTranscriptCandidatesFn: () => [subagentPath, parentPath],
        parseTranscriptFn: (p) => {
          if (p === parentPath) return parentLines;
          throw new Error(`must not parse the per-agent file: ${p}`);
        },
      }
    );

    expect(ctx.transcriptLines).toEqual(parentLines);
  });

  test("passes hookFilename and events through to readHostCapFn", () => {
    let seenFilename = "";
    let seenEvents: readonly string[] | undefined;
    resolveDispatchContext("PostToolUse", dispatchInput(), {
      hookFilename: "dispatch-posttooluse.ts",
      readHostCapFn: (filename, _dir, opts) => {
        seenFilename = filename;
        seenEvents = opts?.events;
        return fakeHostCap;
      },
    });
    expect(seenFilename).toBe("dispatch-posttooluse.ts");
    expect(seenEvents).toEqual(["PostToolUse"]);
  });
});

// ---------------------------------------------------------------------------
// runDispatcher (D1 core loop)
// ---------------------------------------------------------------------------

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
          effects: FIXTURE_EFFECTS,
        },
      ],
      readInputFn: () => Promise.resolve(baseInput({ tool_name: "Bash" })),
      writeOutputFn: (o) => written.push(o),
      stderrWrite: (s) => stdout.push(s),
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
        effects: FIXTURE_EFFECTS,
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
        effects: FIXTURE_EFFECTS,
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
        effects: FIXTURE_EFFECTS,
      },
      {
        name: "b",
        event: "PreToolUse",
        matcher: "Bash",
        module: () => Promise.resolve({ run: () => ({ additionalContext: "fragment B" }) }),
        timeoutMs: 1000,
        denyCapable: false,
        effects: FIXTURE_EFFECTS,
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
    const stderrLines: string[] = [];
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
        effects: FIXTURE_EFFECTS,
      },
    ];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations,
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: (o) => written.push(o),
      stderrWrite: (s) => stderrLines.push(s),
      resolveDispatchContextFn: () => stubContext(),
    });
    // Simulate the override by setting env for a second run — checkOverride
    // reads process.env directly, so exercise it via a real env mutation
    // scoped to this test.
    process.env[HOOK_OVERRIDE_ENV_VAR] = "pilot";
    try {
      guardInvoked = false;
      written.length = 0;
      stderrLines.length = 0;
      await runDispatcher("PreToolUse", {
        hookFilename: DISPATCH_HOOK_FILENAME,
        registrations,
        readInputFn: () => Promise.resolve(baseInput()),
        writeOutputFn: (o) => written.push(o),
        stderrWrite: (s) => stderrLines.push(s),
        resolveDispatchContextFn: () => stubContext(),
      });
      expect(guardInvoked).toBe(false);
      expect(written).toEqual([]);
      // mt#3625: the override audit line goes to STDERR. On stdout it sat ahead
      // of the dispatch's JSON and made Claude Code discard the whole output.
      expect(stderrLines.length).toBe(1);
      expect(stderrLines[0]).toContain("OVERRIDE: guard=pilot");
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
        effects: FIXTURE_EFFECTS,
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
        effects: FIXTURE_EFFECTS,
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
        effects: FIXTURE_EFFECTS,
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
          effects: FIXTURE_EFFECTS,
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
          effects: FIXTURE_EFFECTS,
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
        effects: FIXTURE_EFFECTS,
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
        effects: FIXTURE_EFFECTS,
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

  test("guard-emitted auditLines are written to stderr verbatim, never stdout", async () => {
    const stdout: string[] = [];
    const stderr = makeStderrSpy();
    const registrations: GuardRegistration[] = [
      {
        name: "g",
        event: "PreToolUse",
        matcher: "Bash",
        module: () =>
          Promise.resolve({ run: () => ({ auditLines: ["[g] legacy override active\n"] }) }),
        timeoutMs: 1000,
        denyCapable: false,
        effects: FIXTURE_EFFECTS,
      },
    ];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations,
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: () => {},
      stderrWrite: stderr.write,
      resolveDispatchContextFn: () => stubContext(),
    });
    expect(stderr.writes).toEqual(["[g] legacy override active\n"]);
    // The real `process.stdout` is untouched by this dispatch: the only stdout
    // writer left in the dispatcher is `writeOutputFn`, stubbed to a no-op here.
    expect(stdout).toEqual([]);
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
        effects: FIXTURE_EFFECTS,
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
        effects: FIXTURE_EFFECTS,
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
        effects: FIXTURE_EFFECTS,
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
        effects: FIXTURE_EFFECTS,
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
        effects: FIXTURE_EFFECTS,
      },
    ];
    process.env[HOOK_OVERRIDE_ENV_VAR] = "pilot";
    try {
      await runDispatcher("PreToolUse", {
        hookFilename: DISPATCH_HOOK_FILENAME,
        registrations,
        readInputFn: () => Promise.resolve(baseInput()),
        writeOutputFn: () => {},
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
        effects: FIXTURE_EFFECTS,
      },
      {
        name: "b",
        event: "PreToolUse",
        matcher: "Bash",
        module: () => Promise.resolve({ run: () => null }),
        timeoutMs: 1000,
        denyCapable: false,
        effects: FIXTURE_EFFECTS,
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
        effects: FIXTURE_EFFECTS,
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
        effects: FIXTURE_EFFECTS,
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
        effects: FIXTURE_EFFECTS,
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

// ---------------------------------------------------------------------------
// mt#3394 — merged-context priority ordering + size budget
// ---------------------------------------------------------------------------

function frag(guardName: string, priority: number, text: string): ContextFragment {
  return { guardName, priority, text };
}

describe("composeAdditionalContext (mt#3394)", () => {
  test("no fragments -> undefined, so the caller omits the key entirely", () => {
    expect(composeAdditionalContext([])).toBeUndefined();
  });

  // Acceptance test 1: higher declared priority is emitted first.
  test("orders by priority DESC regardless of arrival order", () => {
    const out = composeAdditionalContext([
      frag("low", 0, "LOW"),
      frag("high", 10, "HIGH"),
      frag("mid", 5, "MID"),
    ]);
    expect(out).toBe("HIGH\n\nMID\n\nLOW");
  });

  // Acceptance test 4: the single-guard case must not change at all.
  test("a single fragment is emitted verbatim — no separator, no notice", () => {
    expect(composeAdditionalContext([frag("only", 0, "just this")])).toBe("just this");
  });

  test("equal priorities keep arrival (registry) order — the stable-sort guarantee", () => {
    // This is what keeps an unannotated registry byte-identical to the
    // pre-mt#3394 `fragments.join("\n\n")`.
    const out = composeAdditionalContext([
      frag("a", DEFAULT_CONTEXT_PRIORITY, "A"),
      frag("b", DEFAULT_CONTEXT_PRIORITY, "B"),
      frag("c", DEFAULT_CONTEXT_PRIORITY, "C"),
    ]);
    expect(out).toBe("A\n\nB\n\nC");
  });

  // Acceptance test 2: over budget -> highest-priority intact + explicit notice.
  test("over budget: drops lowest-priority fragments and names them in a notice", () => {
    const out = composeAdditionalContext(
      [frag("keeper", 10, "K".repeat(40)), frag("dropped-guard", 0, "D".repeat(40))],
      50
    );
    expect(out).toContain("K".repeat(40));
    expect(out).not.toContain("D".repeat(40));
    expect(out).toContain("1 lower-priority reminder(s) omitted");
    expect(out).toContain("dropped-guard");
  });

  test("the highest-priority fragment is admitted intact even if it alone exceeds the budget", () => {
    const huge = "H".repeat(500);
    const out = composeAdditionalContext([frag("huge", 10, huge), frag("small", 0, "s")], 50);
    // Never truncated — a budget must not mutilate the most important reminder.
    expect(out).toContain(huge);
    expect(out).toContain("small");
  });

  // PR #2476 R1 (BLOCKING): the notice was appended AFTER the body was fitted
  // to the budget, so the emitted block could exceed the cap it advertises.
  test("the rendered block including its omission notice stays within budget", () => {
    const budget = 400;
    const fragments = [
      frag("keeper", 10, "K".repeat(120)),
      frag("dropped-one", 0, "A".repeat(120)),
      frag("dropped-two", 0, "B".repeat(120)),
      frag("dropped-three", 0, "C".repeat(120)),
    ];
    const out = composeAdditionalContext(fragments, budget) ?? "";
    expect(out).toContain("omitted");
    expect(out).toContain("K".repeat(120));
    // The whole string — notice included — must respect the budget. Before the
    // R1 fix the body alone was fitted and the notice appended on top, so this
    // came out over.
    expect(out.length).toBeLessThanOrEqual(budget);
  });

  test("floor case: a budget too small for one fragment PLUS its notice overshoots, not truncates", () => {
    // The single documented exception to the cap. With admittedCount already at
    // its floor of 1 there is nothing left to drop, so the block overshoots
    // rather than mutilating the highest-priority reminder. Pinned so the
    // exception stays deliberate and visible instead of being rediscovered.
    const out =
      composeAdditionalContext(
        [frag("keeper", 10, "K".repeat(120)), frag("dropped", 0, "D".repeat(120))],
        200
      ) ?? "";
    expect(out).toContain("K".repeat(120));
    expect(out).toContain("omitted");
    expect(out.length).toBeGreaterThan(200);
  });

  test("a lone over-budget fragment overshoots deliberately rather than being truncated", () => {
    // The one documented exception to the cap: with nothing left to drop, the
    // highest-priority fragment is emitted intact.
    const huge = "H".repeat(500);
    const out = composeAdditionalContext([frag("huge", 10, huge)], 50) ?? "";
    expect(out).toBe(huge);
  });

  test("under budget: no notice is appended", () => {
    const out = composeAdditionalContext([frag("a", 0, "A"), frag("b", 0, "B")], 1000);
    expect(out).toBe("A\n\nB");
    expect(out).not.toContain("omitted");
  });

  test("the default budget accommodates the measured all-injectors-plus-five-detectors turn", () => {
    // The turn the budget is SIZED for — everything always-on plus the five
    // heaviest conditional detectors — must NOT be truncated, or the budget
    // binds on real traffic.
    //
    // Derived from the registry's own annotations rather than hardcoded
    // (mt#3479). The previous version of this test restated the sizes as
    // literals, so when mt#3479 corrected 14 annotations the test kept
    // asserting a turn that no longer resembled production — the same
    // copy-drift the annotations themselves had already suffered. Reading the
    // registry means changing an annotation automatically changes what this
    // asserts, and `guard-feedback-shape.test.ts` separately keeps the
    // annotations honest against each guard's real rendered output.
    // `renderProbe` marks a guard that RENDERS but does not INJECT (mt#4002).
    // Such a guard contributes zero chars to any real turn, so including it in
    // the modelled turn sizes the shared budget for text that is never sent —
    // which is exactly what mt#3533 did (6156 -> 7206 for a guard whose
    // `INJECTION_ENABLED` is false), and what mt#3997 avoided hours earlier by
    // trimming its guard instead. A turn containing one cannot occur.
    const annotated = GUARD_REGISTRY.filter(
      (r) => r.event === USER_PROMPT_SUBMIT && r.attentionCost !== undefined && !r.renderProbe
    );
    const size = (name: string) =>
      annotated.find((r) => r.name === name)?.attentionCost?.denialMessageSizeChars ?? 0;

    // mt#3485 moved `inject-dispatch-watchdog` OUT of this list. It is
    // registered always-on and runs every turn, but `formatDispatchWatchdogState`
    // returns null for both a missing cache and an empty flag set, so it
    // contributes NO chars on an ordinary turn — counting it here modelled a
    // per-turn floor ~1800 chars heavier than any real turn. It is now modelled
    // where it belongs, as the largest conditional detector, which the
    // top-five selection below picks up automatically.
    const alwaysOnNames = [
      "inject-current-time",
      "inject-git-state",
      "inject-prod-state",
      "memory-search",
    ];
    // Every always-on injector must still be present in the registry; a typo or
    // a rename here would silently shrink the modelled turn to a passing one.
    for (const name of alwaysOnNames) expect(size(name)).toBeGreaterThan(0);

    // Pin the reclassification itself: the watchdog must be modelled as a
    // conditional detector, not silently dropped from the turn altogether.
    // Without this, deleting it from `alwaysOnNames` and forgetting it exists
    // would also pass.
    expect(size("inject-dispatch-watchdog")).toBeGreaterThan(0);

    const topFiveConditional = annotated
      .filter((r) => !alwaysOnNames.includes(r.name))
      .sort(
        (a, b) =>
          (b.attentionCost?.denialMessageSizeChars ?? 0) -
          (a.attentionCost?.denialMessageSizeChars ?? 0)
      )
      .slice(0, 5);
    expect(topFiveConditional).toHaveLength(5);

    const fragments = [
      ...alwaysOnNames.map((name) => frag(name, 10, "x".repeat(size(name)))),
      ...topFiveConditional.map((r) =>
        frag(r.name, 0, "x".repeat(r.attentionCost?.denialMessageSizeChars ?? 0))
      ),
    ];
    const out = composeAdditionalContext(fragments, MERGED_CONTEXT_BUDGET_CHARS);
    expect(out).not.toContain("omitted");
  });
});

describe("runDispatcher merged-context behavior (mt#3394)", () => {
  // Acceptance test 3: a fragment dropped for budget must STILL have written
  // its calibration record — the budget is a presentation concern only, and
  // /calibration-review's false-positive rates depend on the record surviving.
  test("a budget-dropped guard still logs its calibration record", async () => {
    const written: HookOutput[] = [];
    const logged: { name: string; record: Record<string, unknown> }[] = [];
    const registrations: GuardRegistration[] = [
      {
        name: "loud-high-priority",
        event: "PreToolUse",
        matcher: "Bash",
        module: () =>
          Promise.resolve({
            run: () => ({ additionalContext: "H".repeat(MERGED_CONTEXT_BUDGET_CHARS) }),
          }),
        timeoutMs: 1000,
        denyCapable: false,
        effects: FIXTURE_EFFECTS,
        contextPriority: 10,
      },
      {
        name: "quiet-low-priority",
        event: "PreToolUse",
        matcher: "Bash",
        module: () =>
          Promise.resolve({
            run: () => ({
              additionalContext: "L".repeat(100),
              calibration: { timestamp: "t", session_id: "s", detail: "still measured" },
            }),
          }),
        timeoutMs: 1000,
        denyCapable: false,
        effects: FIXTURE_EFFECTS,
        calibrationLog: "quiet-low",
      },
    ];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations,
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: (o) => written.push(o),
      logCalibrationRecordFn: (name, record) => logged.push({ name, record }),
      resolveDispatchContextFn: () => stubContext(),
    });

    const emitted = written[0]?.hookSpecificOutput?.additionalContext ?? "";
    // Presentation: the low-priority fragment was dropped and named.
    expect(emitted).not.toContain("L".repeat(100));
    expect(emitted).toContain("quiet-low-priority");
    // Measurement: its calibration record was written anyway.
    expect(logged.length).toBe(1);
    expect(logged[0]?.name).toBe("quiet-low");
    expect(logged[0]?.record?.detail).toBe("still measured");
  });

  // PR #2476 R1 (BLOCKING, raised as a possible semantic change): the emit
  // condition moved from `contextFragments.length > 0` to
  // `additionalContext !== undefined`. Those are equivalent — the composer
  // returns undefined ONLY for an empty fragment list, and a falsy
  // additionalContext never enters the list in the first place — but
  // "equivalent by reasoning" is not a test, so here is the test.
  test("no guard contributes context -> the additionalContext key is omitted entirely", async () => {
    const written: HookOutput[] = [];
    const registrations: GuardRegistration[] = [
      {
        name: "silent-guard",
        event: "PreToolUse",
        matcher: "Bash",
        // Returns an outcome, but with no additionalContext — the "matched but
        // silent" case that must still produce no stdout.
        module: () => Promise.resolve({ run: () => ({}) }),
        timeoutMs: 1000,
        denyCapable: false,
        effects: FIXTURE_EFFECTS,
      },
      {
        name: "empty-string-guard",
        event: "PreToolUse",
        matcher: "Bash",
        module: () => Promise.resolve({ run: () => ({ additionalContext: "" }) }),
        timeoutMs: 1000,
        denyCapable: false,
        effects: FIXTURE_EFFECTS,
      },
    ];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations,
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: (o) => written.push(o),
      resolveDispatchContextFn: () => stubContext(),
    });
    expect(written.length).toBe(0);
  });

  test("registry contextPriority is what orders the emitted block", async () => {
    const written: HookOutput[] = [];
    const registrations: GuardRegistration[] = [
      {
        name: "declared-last-but-higher",
        event: "PreToolUse",
        matcher: "Bash",
        module: () => Promise.resolve({ run: () => ({ additionalContext: "SECOND-DECLARED" }) }),
        timeoutMs: 1000,
        denyCapable: false,
        effects: FIXTURE_EFFECTS,
        contextPriority: 99,
      },
      {
        name: "declared-first-but-default",
        event: "PreToolUse",
        matcher: "Bash",
        module: () => Promise.resolve({ run: () => ({ additionalContext: "FIRST-DECLARED" }) }),
        timeoutMs: 1000,
        denyCapable: false,
        effects: FIXTURE_EFFECTS,
      },
    ];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations,
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: (o) => written.push(o),
      resolveDispatchContextFn: () => stubContext(),
    });
    expect(written[0]?.hookSpecificOutput?.additionalContext).toBe(
      "SECOND-DECLARED\n\nFIRST-DECLARED"
    );
  });
});
