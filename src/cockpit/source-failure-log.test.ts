/**
 * Tests for the cockpit source-read failure log field (mt#4597).
 *
 * These pin the SITE's contract, not the domain helper's — `getLoggableErrorSummary`
 * has its own tests in `packages/domain/src/schemas/loggable-error-summary.test.ts`.
 * What is asserted here is that the cap chosen for these four caches is small
 * enough to clip a real drizzle wrapper and large enough that the Postgres error
 * underneath it survives intact. Those two pull in opposite directions, which is
 * the only reason the constant needs a test at all.
 *
 * The fixture is the ACTUAL failure from the 2026-08-25 degradation window: the
 * `guard_canary_runs` batch read, whose `error` field measured 4685 characters
 * of SELECT text plus 148 bound guard names with no Postgres error in it.
 */
import { describe, test, expect } from "bun:test";
import { MAX_LOGGED_ERROR_CHARS } from "@minsky/domain/errors/index";
import { describeSourceFailure, SOURCE_FAILURE_ERROR_CHARS } from "./source-failure-log";

/** The Postgres error a severed socket actually produces. */
const DRIVER_MESSAGE = "Connection terminated unexpectedly";

/**
 * A `DrizzleQueryError`-shaped error, sized like the observed canary failure:
 * a `Failed query: …` message carrying the SELECT and 148 bound params, with
 * the real driver error on `.cause`.
 */
function makeCanaryQueryError(): Error {
  const placeholders = Array.from({ length: 148 }, (_, i) => `$${i + 1}`).join(", ");
  const params = Array.from({ length: 148 }, (_, i) => `guard-name-${i}`).join(",");
  const err = new Error(
    `Failed query: select "id", "run_id", "guard_name", "source", "expects", "passed", ` +
      `"failure_detail", "ran_at" from "guard_canary_runs" where "guard_canary_runs"."guard_name" ` +
      `in (${placeholders}) order by "guard_canary_runs"."ran_at" desc\nparams: ${params}`
  );
  (err as Error & { cause?: unknown }).cause = new Error(DRIVER_MESSAGE);
  return err;
}

describe("describeSourceFailure", () => {
  test("surfaces the driver error that the wrapper's message buries (AT1)", () => {
    const err = makeCanaryQueryError();
    // Precondition: the fixture reproduces the observed shape — a multi-KB
    // message that mentions the driver error nowhere.
    expect(err.message.length).toBeGreaterThan(3000);
    expect(err.message).not.toContain(DRIVER_MESSAGE);

    const out = describeSourceFailure(err);

    expect(out).toContain(DRIVER_MESSAGE);
    expect(out.length).toBeLessThan(err.message.length / 2);
  });

  test("clips the SQL rather than carrying it whole (AT1)", () => {
    const err = makeCanaryQueryError();
    const out = describeSourceFailure(err);

    // The tail of the bound-parameter list is what made these lines enormous.
    expect(out).not.toContain("guard-name-147");
    // Enough of the head survives to identify which query failed.
    expect(out).toContain("guard_canary_runs");
  });

  test("preserves a plain Error's message (AT2)", () => {
    expect(describeSourceFailure(new Error("canary repository unavailable"))).toContain(
      "canary repository unavailable"
    );
  });

  test("stringifies a non-Error rejection (AT3)", () => {
    expect(describeSourceFailure("plain string rejection")).toContain("plain string rejection");
  });

  test("the cap is below the default, or it would not clip anything here", () => {
    // The whole point of the site-specific constant. If someone raises it to
    // the default, the 4685-character case stops being clipped and this test
    // is what says so.
    expect(SOURCE_FAILURE_ERROR_CHARS).toBeLessThan(MAX_LOGGED_ERROR_CHARS);
  });

  test("the cap clears a realistic Postgres error message", () => {
    // The opposite bound: a cap small enough to clip the DIAGNOSIS would be
    // worse than no change at all.
    const longestRealistic = "unable to check out connection from the pool after 60000ms";
    expect(longestRealistic.length).toBeLessThan(SOURCE_FAILURE_ERROR_CHARS);

    const err = new Error("Failed query: select 1");
    (err as Error & { cause?: unknown }).cause = new Error(longestRealistic);
    expect(describeSourceFailure(err)).toContain(longestRealistic);
  });
});
