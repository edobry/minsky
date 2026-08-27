/**
 * Recovery-flag name wiring (mt#4578).
 *
 * `config-fingerprint.ts` claims `RECOVERY_FLAG_ENV_VARS` is the single place the
 * flag set is written down. mt#4556 made that true of the PARSE; mt#4578 makes it
 * true of the NAME. Two drift directions have to be closed, and only one of them
 * is a type:
 *
 *  - **Gate names a flag the list does not have** → compile error. The gates pass
 *    a `RecoveryFlagKey`, derived from the list itself, so there is no second
 *    spelling to drift from. Asserted here by the `@ts-expect-error` case, which
 *    ALSO fails the build if the key union ever widens back to `string` (an
 *    unused `@ts-expect-error` directive is itself an error) — that is the
 *    regression guard for re-annotating the array and silently losing the union.
 *  - **List entry no gate reads** → NOT expressible as a type. Nothing can
 *    require a call site to exist, so an orphan key would keep emitting a
 *    fingerprint dimension nothing acts on. That is what the source scan below
 *    is for, and it is the only reason this file reads source text at all.
 *
 * The scan is deliberately narrow: it asks whether each key is CONSUMED, not
 * where or how. Keys are compile-checked, so a typo inside one of these calls is
 * already a type error before this test runs.
 */
/* eslint-disable custom/no-real-fs-in-tests -- the orphan-key direction is a
 * question about the REAL `review-worker.ts`, and only the real one. An
 * in-memory fake would assert against a fixture whose author already believed
 * the wiring was correct, which is exactly the staleness this test exists to
 * catch: the failure mode is "a flag was declared and never wired up", and a
 * fixture cannot drift from the list the way the real file can. Same
 * justification as `.minsky/hooks/hook-module-inventory.test.ts`, and the same
 * shape — a committed census measured against the tree it describes. */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RECOVERY_FLAG_ENV_VARS,
  readRecoveryFlag,
  parseRecoveryFlag,
  type RecoveryFlagKey,
} from "./config-fingerprint";

const GATE_FILE = "review-worker.ts";
const gateSource = readFileSync(join(import.meta.dir, GATE_FILE), "utf-8");

/** Does `review-worker.ts` read this flag? Tolerates either quote style and wrapping. */
function isConsumedByAGate(key: string): boolean {
  return new RegExp(String.raw`readRecoveryFlag\(\s*["']${key}["']`).test(gateSource);
}

describe("recovery-flag wiring — every declared flag is read (SC2)", () => {
  // The direction no type can catch: an entry here that no gate consumes would
  // put a dimension in every fingerprint that no code path acts on, so a cohort
  // key would claim to distinguish an arm that does not exist.
  test.each(RECOVERY_FLAG_ENV_VARS.map(([key]) => key))(
    "%s is consumed by a gate in review-worker.ts",
    (key) => {
      expect(isConsumedByAGate(key)).toBe(true);
    }
  );

  test("the scan can fail — a key no gate reads is not found", () => {
    // Negative control for the scan itself: without this, a regex that matched
    // nothing (a renamed helper, a changed call shape) would report every key as
    // consumed by vacuously passing, which is the failure mode this whole file
    // exists to prevent one level down.
    expect(isConsumedByAGate("a_flag_that_does_not_exist")).toBe(false);
  });
});

describe("recovery-flag wiring — the gates spell no env var (SC1)", () => {
  // mt#4556 unified the parse but left each gate spelling its own literal. If one
  // comes back, the name has two homes again and this whole mechanism is moot.
  test.each(RECOVERY_FLAG_ENV_VARS.map(([key, envVar]) => [key, envVar]))(
    "%s: review-worker.ts does not name %s",
    (_key, envVar) => {
      expect(gateSource.includes(envVar)).toBe(false);
    }
  );

  test("no REVIEWER_*_ENABLED literal survives anywhere in the gate file", () => {
    // Broader than the per-flag check above: catches a NEW flag added with a
    // literal at its gate and never declared in RECOVERY_FLAG_ENV_VARS, which the
    // per-flag loop cannot see precisely because it iterates the list.
    expect(gateSource.match(/REVIEWER_[A-Z0-9_]*_ENABLED/g)).toBeNull();
  });
});

describe("readRecoveryFlag", () => {
  test("reads the env var this key is paired with, not a derived guess", () => {
    for (const [key, envVar] of RECOVERY_FLAG_ENV_VARS) {
      expect(readRecoveryFlag(key, { [envVar]: "true" })).toBe(true);
      expect(readRecoveryFlag(key, {})).toBe(false);
    }
  });

  test("does not read a NEIGHBOURING flag's env var", () => {
    // Guards the key→env-var mapping specifically: a lookup that fell back to a
    // fixed index, or to `REVIEWER_${key.toUpperCase()}_ENABLED`, would pass the
    // test above and fail here.
    const [firstKey] = RECOVERY_FLAG_ENV_VARS[0];
    const [, secondEnvVar] = RECOVERY_FLAG_ENV_VARS[1];
    expect(readRecoveryFlag(firstKey, { [secondEnvVar]: "true" })).toBe(false);
  });

  test("applies exactly parseRecoveryFlag's rule — same tokens, same defaults", () => {
    const [key, envVar] = RECOVERY_FLAG_ENV_VARS[0];
    for (const raw of ["true", "TRUE", "1", "yes", "ON", " true ", "false", "0", "", "no"]) {
      expect(readRecoveryFlag(key, { [envVar]: raw })).toBe(parseRecoveryFlag(raw));
    }
    expect(readRecoveryFlag(key, { [envVar]: undefined })).toBe(parseRecoveryFlag(undefined));
  });

  test("defaults to process.env when no env is injected", () => {
    const [key, envVar] = RECOVERY_FLAG_ENV_VARS[0];
    const original = process.env[envVar];
    try {
      process.env[envVar] = "true";
      expect(readRecoveryFlag(key)).toBe(true);
      process.env[envVar] = "false";
      expect(readRecoveryFlag(key)).toBe(false);
    } finally {
      if (original === undefined) delete process.env[envVar];
      else process.env[envVar] = original;
    }
  });

  test("a key outside the declared set does not compile, and is inert if forced", () => {
    // The compile-time half of SC1, asserted as a test so it cannot rot silently.
    // If RecoveryFlagKey ever widens to `string` — which is what re-adding a
    // `ReadonlyArray<readonly [string, string]>` annotation to the array does —
    // this line stops erroring and typecheck fails on the now-unused directive.
    // @ts-expect-error "not_a_flag" is not a RecoveryFlagKey
    const forced: boolean = readRecoveryFlag("not_a_flag", { REVIEWER_ANYTHING: "true" });
    // Paired runtime assertion (a bare @ts-expect-error asserts nothing at run time):
    // an unmapped key reads no env var at all rather than defaulting to enabled.
    expect(forced).toBe(false);
  });
});

describe("RecoveryFlagKey", () => {
  test("is derived from the array, so declared keys are assignable", () => {
    // Not a tautology: this fails to COMPILE if the array's `as const` is dropped
    // or its element type is widened, which is the exact regression that would
    // turn every gate's key back into an unchecked string.
    const keys: RecoveryFlagKey[] = RECOVERY_FLAG_ENV_VARS.map(([key]) => key);
    expect(keys).toHaveLength(RECOVERY_FLAG_ENV_VARS.length);
    expect(new Set(keys).size).toBe(RECOVERY_FLAG_ENV_VARS.length);
  });
});
