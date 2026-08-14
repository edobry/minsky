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
import { mkdtempSync, rmSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  evaluateCanaryOutcome,
  runGuardCanary,
  runAllRegistryCanaries,
  summarizeCanaryResults,
  formatCanaryResult,
  CANARY_SESSION_ID,
  isCanaryRecord,
  type CanaryResult,
} from "./canary-runner";
import { GUARD_REGISTRY } from "./registry";
import type { GuardRegistration, GuardModule } from "./registry";

const MINSKY_STATE_DIR_VAR = "MINSKY_STATE_DIR";
const CLAUDE_PROJECT_DIR_VAR = "CLAUDE_PROJECT_DIR";
const CANARY_MODE_VAR = "MINSKY_CANARY_MODE";
const CHECK_GUESSED_SESSION_PATH = "check-guessed-session-path";
const USER_PROMPT_SUBMIT = "UserPromptSubmit";

let canaryTestStateDir: string;
let prevMinskyStateDir: string | undefined;
let prevClaudeProjectDir: string | undefined;
let prevCanaryMode: string | undefined;

beforeAll(() => {
  canaryTestStateDir = mkdtempSync(join(tmpdir(), "mt2889-canary-runner-test-isolation-"));
  prevMinskyStateDir = process.env[MINSKY_STATE_DIR_VAR];
  prevClaudeProjectDir = process.env[CLAUDE_PROJECT_DIR_VAR];
  prevCanaryMode = process.env[CANARY_MODE_VAR];
  process.env[MINSKY_STATE_DIR_VAR] = canaryTestStateDir;
  process.env[CLAUDE_PROJECT_DIR_VAR] = canaryTestStateDir;
  // mt#2292: the DB half of the isolation the block comment above describes.
  // The two vars above redirect guards' filesystem writes to a temp dir; this
  // one is what keeps a guard from reaching the live DATABASE, and the file was
  // running the whole registry without it. `MINSKY_CANARY_MODE` is what
  // `record-agent-dispatch` and `duplicate-signature-scan` check to short-circuit
  // their persistence work, and both bound that work with a multi-second deadline
  // — so without this the runner pays a real connect attempt per DB-touching
  // guard and "returns one result per registration" blows its 15s budget.
  // Set here rather than at module load because this file imports the registry
  // statically and no guard reads it at import time (unlike
  // guard-feedback-shape.test.ts, which dynamic-imports and therefore must set
  // it first). Same value that file and `scripts/run-guard-canaries.ts` set.
  process.env[CANARY_MODE_VAR] = "1";
});

afterAll(() => {
  if (prevMinskyStateDir === undefined) delete process.env[MINSKY_STATE_DIR_VAR];
  else process.env[MINSKY_STATE_DIR_VAR] = prevMinskyStateDir;
  if (prevClaudeProjectDir === undefined) delete process.env[CLAUDE_PROJECT_DIR_VAR];
  else process.env[CLAUDE_PROJECT_DIR_VAR] = prevClaudeProjectDir;
  if (prevCanaryMode === undefined) delete process.env[CANARY_MODE_VAR];
  else process.env[CANARY_MODE_VAR] = prevCanaryMode;
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
      effects: [
        {
          effect: "deny",
          verdictShape: "validator",
          failurePolicy: { failurePolicy: "closed", degradedPolicy: "closed" },
        },
      ],
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
      effects: [
        {
          effect: "deny",
          verdictShape: "validator",
          failurePolicy: { failurePolicy: "closed", degradedPolicy: "closed" },
        },
      ],
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
      effects: [
        {
          effect: "deny",
          verdictShape: "validator",
          failurePolicy: { failurePolicy: "closed", degradedPolicy: "closed" },
        },
      ],
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
      effects: [
        {
          effect: "deny",
          verdictShape: "validator",
          failurePolicy: { failurePolicy: "closed", degradedPolicy: "closed" },
        },
      ],
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
      effects: [
        {
          effect: "deny",
          verdictShape: "validator",
          failurePolicy: { failurePolicy: "closed", degradedPolicy: "closed" },
        },
      ],
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

// ---------------------------------------------------------------------------
// Write isolation (mt#4127)
// ---------------------------------------------------------------------------

/**
 * A canary drives the guard's REAL `run()`, and several guards append a
 * per-turn evaluation record as a side effect. Before mt#4127 those rows landed
 * in the developer's checkout: this file already isolated `CLAUDE_PROJECT_DIR`
 * (see `beforeAll`), which covers writers routed through `evaluationLogPath` —
 * but a HAND-ROLLED writer roots on `input.cwd`, which `baseCanaryInput` set to
 * `process.cwd()`. Reproduced 2026-08-14: running this one test file appended a
 * row bearing `CANARY_SESSION_ID` to the real
 * `.minsky/negative-existence-claim-evaluations.jsonl`.
 */
describe("runGuardCanary — write isolation (mt#4127)", () => {
  /** A registration whose module records what it was handed, and writes where a guard would. */
  function makeObservingReg(name: string): {
    reg: GuardRegistration;
    observed: { cwd?: string; projectDir?: string; wouldWriteTo?: string; wroteTo?: string };
  } {
    const observed: {
      cwd?: string;
      projectDir?: string;
      wouldWriteTo?: string;
      wroteTo?: string;
    } = {};
    const reg: GuardRegistration = {
      name,
      event: "PreToolUse",
      module: () =>
        Promise.resolve<GuardModule>({
          run: (input) => {
            observed.cwd = input.cwd;
            observed.projectDir = process.env[CLAUDE_PROJECT_DIR_VAR];
            // Mirror a hand-rolled evaluation writer: root on input.cwd.
            const logPath = join(String(input.cwd), ".minsky", "synthetic-evaluations.jsonl");
            observed.wouldWriteTo = logPath;
            // Write ONLY when the runner actually sandboxed us (PR #2995 R1).
            // The assertions below check `wouldWriteTo`, so a regression is
            // still caught — but the test that detects files scattering into
            // the developer's checkout must not scatter them itself on the way
            // to failing. Guarding here rather than asserting-then-writing
            // keeps that true even if the assertion order later changes.
            if (logPath.startsWith(tmpdir())) {
              mkdirSync(dirname(logPath), { recursive: true });
              appendFileSync(logPath, `${JSON.stringify({ session_id: CANARY_SESSION_ID })}\n`);
              observed.wroteTo = logPath;
            }
            // A calibration outcome rather than null, so the fixture is a
            // coherent registration: the guards that write a per-turn record
            // are exactly the calibration-first ones.
            return { calibration: { session_id: input.session_id } };
          },
        }),
      timeoutMs: 5000,
      denyCapable: false,
      effects: [
        {
          effect: "deny",
          verdictShape: "validator",
          failurePolicy: { failurePolicy: "closed", degradedPolicy: "closed" },
        },
      ],
      canary: { input: {}, expects: "calibration" },
    };
    return { reg, observed };
  }

  test("the guard is handed a cwd OUTSIDE the developer's checkout", async () => {
    const { reg, observed } = makeObservingReg("mt4127-cwd-isolation");
    await runGuardCanary(reg);

    expect(observed.cwd).toBeDefined();
    // The assertion that would have caught the defect: before the fix this was
    // exactly `process.cwd()`, so a hand-rolled writer wrote into the repo.
    expect(observed.cwd).not.toBe(process.cwd());
    expect(observed.cwd?.startsWith(tmpdir())).toBe(true);
  });

  test("CLAUDE_PROJECT_DIR points at the same sandbox during the run, and is restored after", async () => {
    const before = process.env[CLAUDE_PROJECT_DIR_VAR];
    const { reg, observed } = makeObservingReg("mt4127-projectdir-isolation");
    await runGuardCanary(reg);

    // Both knobs must agree, or the two writer conventions sandbox differently.
    expect(String(observed.projectDir)).toBe(String(observed.cwd));
    // Restored, including the case where it was unset before and must stay so —
    // hence the sentinel rather than comparing two possibly-undefined values.
    expect(process.env[CLAUDE_PROJECT_DIR_VAR] ?? "<unset>").toBe(before ?? "<unset>");
  });

  test("the path a guard would write to is inside the sandbox, and nothing persists", async () => {
    const { reg, observed } = makeObservingReg("mt4127-write-lands-in-sandbox");
    await runGuardCanary(reg);

    // The regression check, made on the PATH rather than on a file that had to
    // be created in the checkout to be observed.
    expect(observed.wouldWriteTo).toBeDefined();
    expect(observed.wouldWriteTo?.startsWith(tmpdir())).toBe(true);
    // The fixture only writes when sandboxed, so this being set is itself
    // evidence the guard was — and its absence afterward is the teardown.
    expect(observed.wroteTo).toBeDefined();
    expect(existsSync(String(observed.wroteTo))).toBe(false);
  });

  test("a canary that throws still releases its slot (PR #2995 R2)", async () => {
    // The reviewer's scenario is `createCanarySandbox()` throwing, which cannot
    // be injected here — but the invariant it threatens is observable: if ANY
    // path skips `releaseSlot()`, `canaryInvocationChain` stays pending and
    // every later canary waits on it forever. A rejecting module loader
    // exercises that invariant through the error path.
    const { reg: template } = makeObservingReg("mt4127-exploding");
    const exploding: GuardRegistration = {
      ...template,
      module: () => Promise.reject(new Error("canary module boom")),
    };
    const failed = await runGuardCanary(exploding);
    expect(failed.passed).toBe(false);

    // Raced against a timeout ON PURPOSE: a leaked slot makes the next canary
    // HANG, and a hanging test reports as a suite timeout rather than as this
    // assertion failing. The race converts the hang into a legible failure.
    const { reg, observed } = makeObservingReg("mt4127-after-failure");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      runGuardCanary(reg).then(() => "completed" as const),
      new Promise<"slot-leaked">((resolve) => {
        timer = setTimeout(() => resolve("slot-leaked"), 2000);
      }),
    ]);
    if (timer) clearTimeout(timer);

    expect(outcome).toBe("completed");
    expect(observed.cwd?.startsWith(tmpdir())).toBe(true);
  });

  test("concurrent invocations do not trample each other's sandbox (PR #2995 R1)", async () => {
    // `runGuardCanary` hands the sandbox to guards through `process.env`, which
    // is process-global. Overlapping calls are serialized; without that, one
    // canary's `finally` restores the pre-canary value while another is still
    // running, and the second writes to the real repo.
    const a = makeObservingReg("mt4127-concurrent-a");
    const b = makeObservingReg("mt4127-concurrent-b");

    await Promise.all([runGuardCanary(a.reg), runGuardCanary(b.reg)]);

    // Each saw a sandbox, and each saw its OWN — a shared or restored-early
    // value would show up as an equal pair, or as one pointing at the checkout.
    expect(a.observed.cwd?.startsWith(tmpdir())).toBe(true);
    expect(b.observed.cwd?.startsWith(tmpdir())).toBe(true);
    expect(a.observed.cwd).not.toBe(b.observed.cwd);
    expect(String(a.observed.projectDir)).toBe(String(a.observed.cwd));
    expect(String(b.observed.projectDir)).toBe(String(b.observed.cwd));
  });
});

describe("isCanaryRecord (mt#4127)", () => {
  test("identifies a canary row by session_id", () => {
    expect(isCanaryRecord({ session_id: CANARY_SESSION_ID })).toBe(true);
  });

  test("a real turn is not a canary row", () => {
    expect(isCanaryRecord({ session_id: "9f3c1a20-real-conversation" })).toBe(false);
    expect(isCanaryRecord({})).toBe(false);
  });

  test("a real turn whose CAPTURED TEXT mentions canaries is not a canary row", () => {
    // The measured false positive this predicate exists to avoid: on
    // 2026-08-13 `grep -c canary` over operator-deferral's stream returned 31
    // against a true count of 25, because six real turns discussed canary runs
    // in their captured text. Keying on the field, not the line, is the fix.
    const realRowDiscussingCanaries = {
      session_id: "9f3c1a20-real-conversation",
      text_tail: "typecheck clean, lint 0/0, canary PASS, and the negative control reproduced",
    };
    expect(isCanaryRecord(realRowDiscussingCanaries)).toBe(false);
  });
});
