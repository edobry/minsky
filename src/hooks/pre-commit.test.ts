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
