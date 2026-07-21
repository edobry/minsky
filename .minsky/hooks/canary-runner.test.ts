/**
 * Unit tests for canary-runner.ts — mt#2889 (evaluation-loop Phase 1
 * completion).
 *
 * Covers:
 * - evaluateCanaryOutcome's per-`expects`-kind matching logic.
 * - runGuardCanary against the REAL check-guessed-session-path registration
 *   (a genuine registry canary) — proves the runner correctly reports PASS
 *   for a healthy guard.
 * - THE SABOTAGE-DETECTION ACCEPTANCE TEST: a synthetic "test copy" of a
 *   guard registration whose module's run() always returns null (simulating
 *   a guard whose detection logic silently broke) — the runner must report
 *   FAIL, not a false PASS. This is the RFC's load-bearing broken-vs-dormant
 *   disambiguator in action: mt#2057's dead retrospective-trigger hook and
 *   mt#2835's dead UserPromptSubmit dispatcher would both have been caught
 *   by exactly this mechanism.
 * - summarizeCanaryResults / formatCanaryResult pure helpers.
 */

/* eslint-disable custom/no-real-fs-in-tests -- this file exercises REAL
   GUARD_REGISTRY guards' run() (including canary.setup hooks that write
   priming fixtures to disk) to prove the canary runner works against the
   actual production entry points, not mocks. The isolation block below
   (beforeAll/afterAll) points MINSKY_STATE_DIR and CLAUDE_PROJECT_DIR at a
   throwaway temp directory for the WHOLE file so none of those writes ever
   touch the developer's real ~/.local/state/minsky/ or this repo's real
   .minsky/*.jsonl — mirrors dispatcher.test.ts's identical isolation
   pattern (mt#2597/mt#2876 class). */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateCanaryOutcome,
  runGuardCanary,
  runAllRegistryCanaries,
  summarizeCanaryResults,
  formatCanaryResult,
  type CanaryResult,
} from "./canary-runner";
import { GUARD_REGISTRY } from "./registry";
import type { GuardRegistration, GuardModule } from "./registry";

const MINSKY_STATE_DIR_VAR = "MINSKY_STATE_DIR";
const CLAUDE_PROJECT_DIR_VAR = "CLAUDE_PROJECT_DIR";
const CHECK_GUESSED_SESSION_PATH = "check-guessed-session-path";
const USER_PROMPT_SUBMIT = "UserPromptSubmit";

let canaryTestStateDir: string;
let prevMinskyStateDir: string | undefined;
let prevClaudeProjectDir: string | undefined;

beforeAll(() => {
  canaryTestStateDir = mkdtempSync(join(tmpdir(), "mt2889-canary-runner-test-isolation-"));
  prevMinskyStateDir = process.env[MINSKY_STATE_DIR_VAR];
  prevClaudeProjectDir = process.env[CLAUDE_PROJECT_DIR_VAR];
  process.env[MINSKY_STATE_DIR_VAR] = canaryTestStateDir;
  process.env[CLAUDE_PROJECT_DIR_VAR] = canaryTestStateDir;
});

afterAll(() => {
  if (prevMinskyStateDir === undefined) delete process.env[MINSKY_STATE_DIR_VAR];
  else process.env[MINSKY_STATE_DIR_VAR] = prevMinskyStateDir;
  if (prevClaudeProjectDir === undefined) delete process.env[CLAUDE_PROJECT_DIR_VAR];
  else process.env[CLAUDE_PROJECT_DIR_VAR] = prevClaudeProjectDir;
  rmSync(canaryTestStateDir, { recursive: true, force: true });
});

describe("evaluateCanaryOutcome", () => {
  test("deny: matches when outcome.deny is set", () => {
    expect(evaluateCanaryOutcome({ deny: { reason: "x" } }, "deny")).toBe(true);
  });
  test("deny: does not match a null outcome", () => {
    expect(evaluateCanaryOutcome(null, "deny")).toBe(false);
  });
  test("deny: does not match an outcome with only additionalContext", () => {
    expect(evaluateCanaryOutcome({ additionalContext: "hi" }, "deny")).toBe(false);
  });

  test("warn: matches a non-empty additionalContext", () => {
    expect(evaluateCanaryOutcome({ additionalContext: "hi" }, "warn")).toBe(true);
  });
  test("warn: does not match an empty-string additionalContext", () => {
    expect(evaluateCanaryOutcome({ additionalContext: "" }, "warn")).toBe(false);
  });
  test("warn: does not match a null outcome", () => {
    expect(evaluateCanaryOutcome(null, "warn")).toBe(false);
  });

  test("calibration: matches when outcome.calibration is set", () => {
    expect(evaluateCanaryOutcome({ calibration: { foo: "bar" } }, "calibration")).toBe(true);
  });
  test("calibration: does not match a missing calibration field", () => {
    expect(evaluateCanaryOutcome({ additionalContext: "hi" }, "calibration")).toBe(false);
  });

  test("sessionTitle: matches when outcome.sessionTitle is set", () => {
    expect(evaluateCanaryOutcome({ sessionTitle: "mt#1 — Title" }, "sessionTitle")).toBe(true);
  });
  test("sessionTitle: does not match a missing sessionTitle field", () => {
    expect(evaluateCanaryOutcome({}, "sessionTitle")).toBe(false);
  });

  test("undefined outcome never matches any expects kind", () => {
    for (const expects of ["deny", "warn", "calibration", "sessionTitle"] as const) {
      expect(evaluateCanaryOutcome(undefined, expects)).toBe(false);
    }
  });
});

describe("runGuardCanary — real guard, real canary", () => {
  test("check-guessed-session-path's declared canary passes against its REAL run()", async () => {
    const reg = GUARD_REGISTRY.find((r) => r.name === CHECK_GUESSED_SESSION_PATH);
    if (!reg) throw new Error("check-guessed-session-path missing from GUARD_REGISTRY");
    const result = await runGuardCanary(reg);
    expect(result.passed).toBe(true);
    expect(result.source).toBe("registry");
    expect(result.expects).toBe("deny");
  });

  test("a registry entry with no declared canary reports passed: undefined (MISSING, not FAIL)", async () => {
    const syntheticReg: GuardRegistration = {
      name: "synthetic-no-canary-guard",
      event: "PreToolUse",
      module: () => Promise.resolve<GuardModule>({ run: () => null }),
      timeoutMs: 5000,
      denyCapable: false,
      // no `canary` field
    };
    const result = await runGuardCanary(syntheticReg);
    expect(result.passed).toBeUndefined();
  });
});

describe("runGuardCanary — SABOTAGE DETECTION (mt#2889 acceptance test)", () => {
  test("a guard whose module always returns null (broken detection) FAILS its own canary that expects deny", async () => {
    // A "test copy" of a real deny-capable guard registration: same canary
    // declaration (input + expects: "deny") as the real check-guessed-
    // session-path entry, but with a SABOTAGED module whose run() always
    // returns null — simulating a guard whose detection logic silently
    // stopped firing (the exact mt#2057 / mt#2835 failure class).
    const realReg = GUARD_REGISTRY.find((r) => r.name === CHECK_GUESSED_SESSION_PATH);
    if (!realReg?.canary) throw new Error("check-guessed-session-path canary missing");

    const sabotagedReg: GuardRegistration = {
      ...realReg,
      name: "check-guessed-session-path-SABOTAGED-test-copy",
      module: () => Promise.resolve<GuardModule>({ run: () => null }), // always "allow" — the bug
    };

    const result = await runGuardCanary(sabotagedReg);
    expect(result.passed).toBe(false);
    expect(result.error).toBeUndefined(); // a clean false, not a thrown error
  });

  test("a guard whose module throws also FAILS (not silently ignored)", async () => {
    const realReg = GUARD_REGISTRY.find((r) => r.name === CHECK_GUESSED_SESSION_PATH);
    if (!realReg?.canary) throw new Error("check-guessed-session-path canary missing");

    const throwingReg: GuardRegistration = {
      ...realReg,
      name: "check-guessed-session-path-THROWING-test-copy",
      module: () =>
        Promise.resolve<GuardModule>({
          run: () => {
            throw new Error("simulated guard crash");
          },
        }),
    };

    const result = await runGuardCanary(throwingReg);
    expect(result.passed).toBe(false);
    expect(result.error).toContain("simulated guard crash");
  });

  test("a warn-expecting guard sabotaged to return null also fails", async () => {
    const sabotagedWarnReg: GuardRegistration = {
      name: "sabotaged-warn-guard-test-copy",
      event: USER_PROMPT_SUBMIT,
      module: () => Promise.resolve<GuardModule>({ run: () => null }),
      timeoutMs: 5000,
      denyCapable: false,
      canary: { input: {}, expects: "warn" },
    };
    const result = await runGuardCanary(sabotagedWarnReg);
    expect(result.passed).toBe(false);
  });
});

describe("runGuardCanary — setup hook", () => {
  test("setup runs BEFORE the checked invocation and its returned patch is merged into input", async () => {
    let setupRan = false;
    const reg: GuardRegistration = {
      name: "setup-patch-test",
      event: USER_PROMPT_SUBMIT,
      module: () =>
        Promise.resolve<GuardModule>({
          run: (input) => {
            // The checked invocation should see the patched session_id.
            if (input.session_id === "patched-session-id") {
              return { additionalContext: "matched" };
            }
            return null;
          },
        }),
      timeoutMs: 5000,
      denyCapable: false,
      canary: {
        input: {},
        expects: "warn",
        setup: () => {
          setupRan = true;
          return { session_id: "patched-session-id" };
        },
      },
    };
    const result = await runGuardCanary(reg);
    expect(setupRan).toBe(true);
    expect(result.passed).toBe(true);
  });
});

describe("summarizeCanaryResults / formatCanaryResult", () => {
  test("counts passed/failed/missing correctly and derives allPassed", () => {
    const results: CanaryResult[] = [
      { guardName: "a", source: "registry", expects: "deny", passed: true },
      { guardName: "b", source: "registry", expects: "warn", passed: false },
      { guardName: "c", source: "standalone", expects: "deny", passed: undefined },
    ];
    const report = summarizeCanaryResults(results);
    expect(report.total).toBe(3);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.missing).toBe(1);
    expect(report.allPassed).toBe(false);
  });

  test("allPassed is true when there are zero failures, even with missing entries", () => {
    const results: CanaryResult[] = [
      { guardName: "a", source: "registry", expects: "deny", passed: true },
      { guardName: "b", source: "registry", expects: "warn", passed: undefined },
    ];
    expect(summarizeCanaryResults(results).allPassed).toBe(true);
  });

  test("formatCanaryResult renders PASS/FAIL/MISSING with the guard name and expects kind", () => {
    expect(
      formatCanaryResult({ guardName: "g", source: "registry", expects: "deny", passed: true })
    ).toContain("[PASS] g (registry, expects=deny)");
    expect(
      formatCanaryResult({ guardName: "g", source: "registry", expects: "deny", passed: false })
    ).toContain("[FAIL] g");
    expect(
      formatCanaryResult({ guardName: "g", source: "registry", expects: "deny", passed: undefined })
    ).toContain("[MISSING] g");
    expect(
      formatCanaryResult({
        guardName: "g",
        source: "registry",
        expects: "deny",
        passed: false,
        error: "boom",
      })
    ).toContain("(error: boom)");
  });
});

describe("runAllRegistryCanaries", () => {
  test("returns one result per registration, in order", async () => {
    const results = await runAllRegistryCanaries(GUARD_REGISTRY);
    expect(results).toHaveLength(GUARD_REGISTRY.length);
    expect(results.map((r) => r.guardName)).toEqual(GUARD_REGISTRY.map((r) => r.name));
  });
});

// ---------------------------------------------------------------------------
// mt#3004 — MISSING-result honesty + the two formerly-canary-less guards
// ---------------------------------------------------------------------------

const MEMORY_SEARCH_GUARD = "memory-search";
const DAEMON_STALENESS_GUARD = "mcp-daemon-staleness-detector";
const CANARY_STUB_ENV_VAR = "MINSKY_MEMORY_SEARCH_CANARY_STUB";
const TRACKER_HOME_ENV_VAR = "MINSKY_DAEMON_TRACKER_HOME";

describe("mt#3004 — MISSING result carries no expects", () => {
  test("a no-canary registry entry has undefined expects and renders 'no canary declared'", async () => {
    const syntheticReg: GuardRegistration = {
      name: "synthetic-no-canary-guard-mt3004",
      event: "PreToolUse",
      module: () => Promise.resolve<GuardModule>({ run: () => null }),
      timeoutMs: 5000,
      denyCapable: false,
    };
    const result = await runGuardCanary(syntheticReg);
    expect(result.passed).toBeUndefined();
    expect(result.expects).toBeUndefined();
    expect(formatCanaryResult(result)).toBe(
      "[MISSING] synthetic-no-canary-guard-mt3004 (registry, no canary declared)"
    );
  });
});

describe("mt#3004 — runGuardCanary restores env mutated by setup (PR #2145 R1)", () => {
  test("a sentinel env var set in setup is removed after the canary completes", async () => {
    const SENTINEL = "MT3004_CANARY_ENV_RESTORE_SENTINEL";
    delete process.env[SENTINEL];
    const reg: GuardRegistration = {
      name: "env-restore-test-guard",
      event: USER_PROMPT_SUBMIT,
      module: () =>
        Promise.resolve<GuardModule>({
          run: () =>
            process.env[SENTINEL] === "set-by-setup" ? { additionalContext: "saw sentinel" } : null,
        }),
      timeoutMs: 5000,
      denyCapable: false,
      canary: {
        input: {},
        expects: "warn",
        setup: () => {
          process.env[SENTINEL] = "set-by-setup";
          return {};
        },
      },
    };
    const result = await runGuardCanary(reg);
    // The checked invocation SAW the setup's env mutation...
    expect(result.passed).toBe(true);
    // ...but nothing leaked past the canary.
    expect(process.env[SENTINEL]).toBeUndefined();
  });
});

describe("mt#3004 — the two formerly-canary-less registry guards", () => {
  // Both guards' canary setups mutate test-only env vars; snapshot/restore so
  // no state leaks into sibling tests.
  let prevStub: string | undefined;
  let prevTrackerHome: string | undefined;

  const snapshotEnv = () => {
    prevStub = process.env[CANARY_STUB_ENV_VAR];
    prevTrackerHome = process.env[TRACKER_HOME_ENV_VAR];
  };
  const restoreEnv = () => {
    if (prevStub === undefined) delete process.env[CANARY_STUB_ENV_VAR];
    else process.env[CANARY_STUB_ENV_VAR] = prevStub;
    if (prevTrackerHome === undefined) delete process.env[TRACKER_HOME_ENV_VAR];
    else process.env[TRACKER_HOME_ENV_VAR] = prevTrackerHome;
  };

  test("memory-search's declared canary passes against its REAL run()", async () => {
    snapshotEnv();
    try {
      const reg = GUARD_REGISTRY.find((r) => r.name === MEMORY_SEARCH_GUARD);
      if (!reg?.canary) throw new Error("memory-search canary missing from GUARD_REGISTRY");
      const result = await runGuardCanary(reg);
      expect(result.error).toBeUndefined();
      expect(result.passed).toBe(true);
      expect(result.expects).toBe("warn");
    } finally {
      restoreEnv();
    }
  });

  test("memory-search sabotaged to return null FAILS its canary (acceptance: break it -> FAIL)", async () => {
    snapshotEnv();
    try {
      const realReg = GUARD_REGISTRY.find((r) => r.name === MEMORY_SEARCH_GUARD);
      if (!realReg?.canary) throw new Error("memory-search canary missing from GUARD_REGISTRY");
      const sabotagedReg: GuardRegistration = {
        ...realReg,
        name: "memory-search-SABOTAGED-test-copy",
        module: () => Promise.resolve<GuardModule>({ run: () => null }),
      };
      const result = await runGuardCanary(sabotagedReg);
      expect(result.passed).toBe(false);
    } finally {
      restoreEnv();
    }
  });

  test("mcp-daemon-staleness-detector's declared canary passes against its REAL run()", async () => {
    snapshotEnv();
    try {
      const reg = GUARD_REGISTRY.find((r) => r.name === DAEMON_STALENESS_GUARD);
      if (!reg?.canary) {
        throw new Error("mcp-daemon-staleness-detector canary missing from GUARD_REGISTRY");
      }
      const result = await runGuardCanary(reg);
      expect(result.error).toBeUndefined();
      expect(result.passed).toBe(true);
      expect(result.expects).toBe("warn");
    } finally {
      restoreEnv();
    }
  });

  test("mcp-daemon-staleness-detector sabotaged to return null FAILS its canary", async () => {
    snapshotEnv();
    try {
      const realReg = GUARD_REGISTRY.find((r) => r.name === DAEMON_STALENESS_GUARD);
      if (!realReg?.canary) {
        throw new Error("mcp-daemon-staleness-detector canary missing from GUARD_REGISTRY");
      }
      const sabotagedReg: GuardRegistration = {
        ...realReg,
        name: "mcp-daemon-staleness-detector-SABOTAGED-test-copy",
        module: () => Promise.resolve<GuardModule>({ run: () => null }),
      };
      const result = await runGuardCanary(sabotagedReg);
      expect(result.passed).toBe(false);
    } finally {
      restoreEnv();
    }
  });
});
