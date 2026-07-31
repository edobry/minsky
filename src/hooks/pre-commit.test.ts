/**
 * Tests for `runInstrumentedStep` (`src/hooks/pre-commit.ts`) — the
 * fire-log instrumentation wrapper `PreCommitHook.instrumented()` delegates
 * to.
 *
 * mt#2597 R1 fix (reviewer finding: "pre-commit over-attribution on presence
 * vs. actual suppression"): the ORIGINAL Phase-1 landing derived the
 * "overridden" fire-log fields from `result.success && isOverrideTruthy(
 * process.env[overrideEnvVar])` — a blanket presence scan that misattributes
 * a step's NORMAL pass as an override whenever its paired env-var happens to
 * be truthy in the environment for an unrelated reason (a leftover export, a
 * DIFFERENT step's override, a developer testing something else). The fix
 * moves the signal onto the step's own `HookResult.overridden` flag, set only
 * on the specific branch where the step itself consulted its var and took
 * the skip path — mirroring how each real step (`runNulByteCheck`,
 * `runMigrationJournalCheck`, `runImmutableMigrationCheck`,
 * `runDeployDomainCheck`, `runRulesCompileCheck`'s size-budget branch) now
 * sets it.
 *
 * @see src/hooks/pre-commit.ts — `runInstrumentedStep`, `HookResult.overridden`
 * @see src/hooks/pre-commit-fire-log.ts — the fire-log schema this wrapper writes
 */

import { describe, test, expect } from "bun:test";
import { runInstrumentedStep, type HookResult } from "./pre-commit";
import { selectLintableStagedFiles, buildScopedLintCommand } from "./pre-commit-lint-scope";
import {
  describeSubprocessFailure,
  ESLINT_TIMEOUT_MS,
  FORMATTER_TIMEOUT_MS,
  TYPECHECK_TIMEOUT_MS,
} from "./pre-commit-subprocess-failure";

/** The default command `ProjectConfigReader.getLintJsonCommand` returns. */
const DEFAULT_LINT_COMMAND = "eslint . --format json";

/** The flag that keeps an ignored-but-staged file from tripping the zero-warning gate. */
const NO_WARN_IGNORED = "--no-warn-ignored";
import type { RecordPreCommitFireLogInput } from "./pre-commit-fire-log";
import { NUL_BYTE_CHECK_OVERRIDE_ENV } from "./nul-byte-detector";
import { MIGRATION_JOURNAL_CHECK_OVERRIDE_ENV } from "./migration-journal-check";

function makeFireLogSpy(): {
  records: RecordPreCommitFireLogInput[];
  fn: (i: RecordPreCommitFireLogInput) => void;
} {
  const records: RecordPreCommitFireLogInput[] = [];
  return { records, fn: (i) => records.push(i) };
}

describe("runInstrumentedStep (mt#2597 R1 — override attribution)", () => {
  test("a passing step that does NOT report overridden -> no override fields recorded, even though its paired env-var happens to be truthy", async () => {
    const spy = makeFireLogSpy();
    const prev = process.env[NUL_BYTE_CHECK_OVERRIDE_ENV];
    process.env[NUL_BYTE_CHECK_OVERRIDE_ENV] = "1"; // set but NOT consulted by fn() below
    try {
      const result: HookResult = await runInstrumentedStep(
        "nul-byte-check",
        async () => ({ success: true, message: "passed on its own merits", exitCode: 0 }),
        NUL_BYTE_CHECK_OVERRIDE_ENV,
        { recordFireLog: spy.fn, now: () => 0 }
      );
      expect(result.success).toBe(true);
    } finally {
      if (prev === undefined) delete process.env[NUL_BYTE_CHECK_OVERRIDE_ENV];
      else process.env[NUL_BYTE_CHECK_OVERRIDE_ENV] = prev;
    }
    expect(spy.records.length).toBe(1);
    expect(spy.records[0]?.decision).toBe("allow");
    expect(spy.records[0]?.overrideEnvVar).toBeUndefined();
    expect(spy.records[0]?.overrideClassification).toBeUndefined();
  });

  test("a step whose own fn reports overridden=true -> override fields recorded with classification=authorized_exception", async () => {
    const spy = makeFireLogSpy();
    const result = await runInstrumentedStep(
      "nul-byte-check",
      async () => ({
        success: true,
        message: "NUL-byte check skipped via override",
        exitCode: 0,
        overridden: true,
      }),
      NUL_BYTE_CHECK_OVERRIDE_ENV,
      { recordFireLog: spy.fn, now: () => 0 }
    );
    expect(result.success).toBe(true);
    expect(spy.records.length).toBe(1);
    expect(spy.records[0]?.overrideEnvVar).toBe(NUL_BYTE_CHECK_OVERRIDE_ENV);
    expect(spy.records[0]?.overrideClassification).toBe("authorized_exception");
  });

  test("overridden=true with no overrideEnvVar supplied -> no override fields (defensive: nothing to attribute the override to)", async () => {
    const spy = makeFireLogSpy();
    await runInstrumentedStep(
      "no-override-var-step",
      async () => ({ success: true, message: "ok", exitCode: 0, overridden: true }),
      undefined,
      { recordFireLog: spy.fn, now: () => 0 }
    );
    expect(spy.records.length).toBe(1);
    expect(spy.records[0]?.overrideEnvVar).toBeUndefined();
    expect(spy.records[0]?.overrideClassification).toBeUndefined();
  });

  test("a failing step is fire-logged as deny regardless of any override env-var state", async () => {
    const spy = makeFireLogSpy();
    const prev = process.env[NUL_BYTE_CHECK_OVERRIDE_ENV];
    process.env[NUL_BYTE_CHECK_OVERRIDE_ENV] = "1";
    try {
      await runInstrumentedStep(
        "nul-byte-check",
        async () => ({ success: false, message: "NUL byte found", exitCode: 1 }),
        NUL_BYTE_CHECK_OVERRIDE_ENV,
        { recordFireLog: spy.fn, now: () => 0 }
      );
    } finally {
      if (prev === undefined) delete process.env[NUL_BYTE_CHECK_OVERRIDE_ENV];
      else process.env[NUL_BYTE_CHECK_OVERRIDE_ENV] = prev;
    }
    expect(spy.records.length).toBe(1);
    expect(spy.records[0]?.decision).toBe("deny");
    expect(spy.records[0]?.overrideEnvVar).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // The exact reviewer-requested scenario: env var set for step A while step B
  // runs -> step B's record has NO override fields; step A's record shows the
  // override with classification.
  // ---------------------------------------------------------------------------
  test("env var set for step A while step B runs normally -> step B's record has no override fields; step A's record shows the override with classification", async () => {
    const spy = makeFireLogSpy();
    const prev = process.env[NUL_BYTE_CHECK_OVERRIDE_ENV];
    // Simulates the exact bug scenario: NUL_BYTE_CHECK_OVERRIDE_ENV is set in
    // the environment (e.g. left over from a prior invocation), and step A
    // (nul-byte-check) genuinely consults it and skips — but step B
    // (migration-journal-check) is a DIFFERENT step with a DIFFERENT paired
    // var; it runs its normal path and must not be misattributed as
    // overridden merely because SOME MINSKY_SKIP_* var is truthy somewhere in
    // the environment.
    process.env[NUL_BYTE_CHECK_OVERRIDE_ENV] = "1";
    try {
      // Step A: nul-byte-check consults its own var and actually takes the
      // skip path (sets overridden: true itself, as the real step does).
      await runInstrumentedStep(
        "nul-byte-check",
        async () => ({
          success: true,
          message: "NUL-byte check skipped via override",
          exitCode: 0,
          overridden: true,
        }),
        NUL_BYTE_CHECK_OVERRIDE_ENV,
        { recordFireLog: spy.fn, now: () => 0 }
      );

      // Step B: migration-journal-check runs its normal path and passes on
      // its own merits — it never sets `overridden`, even though
      // NUL_BYTE_CHECK_OVERRIDE_ENV (a DIFFERENT step's var) is still truthy.
      await runInstrumentedStep(
        "migration-journal-check",
        async () => ({ success: true, message: "passed normally", exitCode: 0 }),
        MIGRATION_JOURNAL_CHECK_OVERRIDE_ENV,
        { recordFireLog: spy.fn, now: () => 0 }
      );
    } finally {
      if (prev === undefined) delete process.env[NUL_BYTE_CHECK_OVERRIDE_ENV];
      else process.env[NUL_BYTE_CHECK_OVERRIDE_ENV] = prev;
    }

    expect(spy.records.length).toBe(2);

    const [stepARecord, stepBRecord] = spy.records;
    expect(stepARecord?.guardName).toBe("nul-byte-check");
    expect(stepARecord?.overrideEnvVar).toBe(NUL_BYTE_CHECK_OVERRIDE_ENV);
    expect(stepARecord?.overrideClassification).toBe("authorized_exception");

    expect(stepBRecord?.guardName).toBe("migration-journal-check");
    expect(stepBRecord?.overrideEnvVar).toBeUndefined();
    expect(stepBRecord?.overrideClassification).toBeUndefined();
  });

  test("durationMs reflects the injected clock", async () => {
    const spy = makeFireLogSpy();
    let call = 0;
    const now = () => (call++ === 0 ? 1000 : 1250);
    await runInstrumentedStep(
      "some-step",
      async () => ({ success: true, message: "ok", exitCode: 0 }),
      undefined,
      { recordFireLog: spy.fn, now }
    );
    expect(spy.records[0]?.durationMs).toBe(250);
  });
});

describe("selectLintableStagedFiles (mt#3404 — staged-file scoping)", () => {
  test("keeps only extensions ESLint is configured to lint", () => {
    expect(
      selectLintableStagedFiles([
        "src/a.ts",
        "src/b.tsx",
        "scripts/c.js",
        "web/d.jsx",
        "e.mjs",
        "f.cjs",
        "docs/g.md",
        "package.json",
        "h.yaml",
        "Dockerfile",
      ])
    ).toEqual(["src/a.ts", "src/b.tsx", "scripts/c.js", "web/d.jsx", "e.mjs", "f.cjs"]);
  });

  test("a docs-only staged set yields no files, so the step can skip spawning ESLint entirely", () => {
    expect(selectLintableStagedFiles(["README.md", "docs/x.md", "cfg.yml"])).toEqual([]);
  });

  test("an empty staged set yields an empty list", () => {
    expect(selectLintableStagedFiles([])).toEqual([]);
  });

  test("does not match an extension appearing mid-path rather than as a suffix", () => {
    expect(selectLintableStagedFiles(["src/.ts.backup", "notes.md"])).toEqual([]);
  });
});

describe("buildScopedLintCommand (mt#3404 — staged-file scoping)", () => {
  test("drops the bare `.` target, preserves surrounding flags, and puts files after `--`", () => {
    const cmd = buildScopedLintCommand(DEFAULT_LINT_COMMAND, ["src/a.ts", "src/b.ts"]);
    expect(cmd).toBe(
      "eslint --format json --no-warn-ignored --no-error-on-unmatched-pattern -- 'src/a.ts' 'src/b.ts'"
    );
  });

  test("appends the file list when the command has no `.` target to drop", () => {
    const cmd = buildScopedLintCommand("eslint --format json --max-warnings=0", ["src/a.ts"]);
    expect(cmd).toBe(
      "eslint --format json --max-warnings=0 --no-warn-ignored --no-error-on-unmatched-pattern -- 'src/a.ts'"
    );
  });

  test("a path beginning with `-` lands after `--`, so it is parsed as a file and not a flag", () => {
    const cmd = buildScopedLintCommand(DEFAULT_LINT_COMMAND, ["-weird-name.ts"]);
    const [, positional] = cmd.split(" -- ");
    expect(positional).toBe("'-weird-name.ts'");
  });

  test("every flag precedes the `--` separator, since anything after it is positional", () => {
    const cmd = buildScopedLintCommand(DEFAULT_LINT_COMMAND, ["src/a.ts"]);
    const [flagsPart, positional] = cmd.split(" -- ");
    expect(flagsPart).toContain(NO_WARN_IGNORED);
    expect(flagsPart).toContain("--no-error-on-unmatched-pattern");
    expect(positional).not.toContain("--no-");
  });

  test("a file NAMED like a flag does not suppress the real flag — it is quoted after `--`", () => {
    const cmd = buildScopedLintCommand(DEFAULT_LINT_COMMAND, ["--no-warn-ignored.ts"]);
    const [flagsPart, positional] = cmd.split(" -- ");
    expect(flagsPart).toContain(NO_WARN_IGNORED);
    expect(positional).toBe("'--no-warn-ignored.ts'");
  });

  test("always emits --no-warn-ignored: an ignored-but-staged file would otherwise warn and trip the zero-warning gate", () => {
    expect(buildScopedLintCommand(DEFAULT_LINT_COMMAND, ["dist/gen.ts"])).toContain(
      NO_WARN_IGNORED
    );
  });

  test("does not duplicate flags the configured command already carries", () => {
    const cmd = buildScopedLintCommand(`${DEFAULT_LINT_COMMAND} ${NO_WARN_IGNORED}`, ["a.ts"]);
    expect(cmd.match(/--no-warn-ignored/g)).toHaveLength(1);
  });

  test("shell-quotes paths containing spaces so they survive as one argument", () => {
    expect(buildScopedLintCommand(DEFAULT_LINT_COMMAND, ["src/my dir/a.ts"])).toContain(
      "'src/my dir/a.ts'"
    );
  });

  test("escapes an embedded single quote rather than terminating the quoted argument", () => {
    const cmd = buildScopedLintCommand(DEFAULT_LINT_COMMAND, ["src/it's.ts"]);
    expect(cmd).toContain("'src/it'\\''s.ts'");
  });
});

// ---------------------------------------------------------------------------
// mt#3406 — a timeout and a tool failure arrive at the same `catch` with the
// same `message`. These pin that the two are told apart, and that the timeout
// branch never swallows a real failure.
// ---------------------------------------------------------------------------

/** The shape Node actually produces on `execAsync` timeout — see the module docblock. */
function timedOutRejection(command: string): Error & { killed: boolean; signal: string } {
  const err = new Error(`Command failed: ${command}`) as Error & {
    killed: boolean;
    signal: string;
  };
  err.killed = true;
  err.signal = "SIGTERM";
  return err;
}

describe("describeSubprocessFailure (mt#3406 — timeout vs failure)", () => {
  // AT1
  test("the formatter timeout says it timed out and names the budget", () => {
    const message = describeSubprocessFailure(timedOutRejection("bunx lint-staged"), {
      step: "Code formatting",
      timeoutMs: FORMATTER_TIMEOUT_MS,
    });
    expect(message).toContain("timed out");
    expect(message).toContain("240s");
    // The bare Node text alone is what sent readers hunting through their diff.
    expect(message).not.toBe("Command failed: bunx lint-staged");
  });

  // AT2
  test("the ESLint timeout says it timed out and names its own budget", () => {
    const message = describeSubprocessFailure(timedOutRejection("bunx eslint --format json"), {
      step: "ESLint validation",
      timeoutMs: ESLINT_TIMEOUT_MS,
    });
    expect(message).toContain("timed out");
    expect(message).toContain("60s");
  });

  // AT3 — the branch must not swallow a real failure.
  test("a genuine tool failure surfaces the underlying output and is NOT called a timeout", () => {
    const real = new Error(
      "Command failed: bunx eslint\n/src/a.ts\n  3:1  error  Unexpected var  no-var"
    ) as Error & { killed: boolean; code: number };
    real.killed = false;
    real.code = 1;

    const message = describeSubprocessFailure(real, {
      step: "ESLint validation",
      timeoutMs: ESLINT_TIMEOUT_MS,
    });
    expect(message).not.toContain("timed out");
    expect(message).toContain("Unexpected var");
    expect(message).toContain("no-var");
  });

  test("an ETIMEDOUT errno is treated as a timeout even without `killed`", () => {
    const err = new Error("Command failed: bunx lint-staged") as Error & { code: string };
    err.code = "ETIMEDOUT";
    const message = describeSubprocessFailure(err, {
      step: "Code formatting",
      timeoutMs: FORMATTER_TIMEOUT_MS,
    });
    expect(message).toContain("timed out");
  });

  // The timeout message has to tell the author what to do, not just what broke.
  test("the timeout message names the remedy and where the budget lives", () => {
    const message = describeSubprocessFailure(timedOutRejection("bunx lint-staged"), {
      step: "Code formatting",
      timeoutMs: FORMATTER_TIMEOUT_MS,
    });
    expect(message).toContain("Re-run");
    expect(message).toContain("src/hooks/pre-commit.ts");
    expect(message).toContain("not a failure in your changes");
  });

  // The shape that blocked this task's OWN commit: the kernel SIGKILLed tsgo on
  // a loaded host and the step announced "TypeScript type errors found".
  test("a child the KERNEL killed with no output is not reported as a failure in your code", () => {
    const oom = new Error("Command failed: /path/to/tsgo --noEmit") as Error & {
      killed: boolean;
      signal: string;
      stdout: string;
      stderr: string;
    };
    oom.killed = false; // Node did not do the killing — the OOM killer did.
    oom.signal = "SIGKILL";
    oom.stdout = "";
    oom.stderr = "";

    const message = describeSubprocessFailure(oom, {
      step: "TypeScript type check (root)",
      timeoutMs: TYPECHECK_TIMEOUT_MS,
    });
    expect(message).toContain("SIGKILL");
    expect(message).toContain("out of memory");
    expect(message).toContain("not a failure in your changes");
    expect(message).not.toContain("timed out");
  });

  test("a child that died by signal AFTER printing diagnostics still surfaces them", () => {
    const withOutput = new Error("Command failed: tsgo --noEmit") as Error & {
      killed: boolean;
      signal: string;
      stdout: string;
    };
    withOutput.killed = false;
    withOutput.signal = "SIGKILL";
    withOutput.stdout = "src/a.ts(3,1): error TS2304: Cannot find name 'foo'.";

    const message = describeSubprocessFailure(withOutput, {
      step: "TypeScript type check (root)",
      timeoutMs: TYPECHECK_TIMEOUT_MS,
    });
    // Real diagnostics exist, so this is NOT relabelled as an environment problem.
    expect(message).not.toContain("out of memory");
    expect(message).toContain("failed:");
  });

  test("a non-Error rejection still produces a usable sentence", () => {
    expect(describeSubprocessFailure("boom", { step: "Code formatting", timeoutMs: 1000 })).toBe(
      "Code formatting failed: boom"
    );
  });
});
