#!/usr/bin/env bun
/**
 * mt#5000 — verify the Rung-2 nomination path can actually resolve its deps in a
 * REAL hook-shaped process.
 *
 * ## Why a script and not a unit test
 *
 * `nominatePendingClaims` takes an injectable `deps` bag, and every unit test in
 * `turn-end-stale-state-assertion-scan.test.ts` supplies one — deliberately, so
 * the suite stays hermetic. The consequence is that no test traverses
 * `resolveNominationDeps`, and the defect this script guards against lived
 * exactly there: a hook is its own entry point, inherits no process-global
 * configuration, and `resolveNominationDeps`' first statement is
 * `await getConfiguration()`. Without a bootstrap it throws, its own catch turns
 * that into `null`, and the stage records `nomination-deps-unavailable` on every
 * cold turn.
 *
 * Measured on the live calibration log at 388 records before the fix: **214
 * `nomination-deps-unavailable`** — 59% of all rung-2 records — while the unit
 * suite was green. That is the mt#3019 dead-path shape, and a green suite is
 * precisely what it looks like from inside. So this check has to run the real
 * resolver in a real process; there is no hermetic version of the question.
 *
 * ## What it asserts
 *
 * Runs the hook's own `run()` on a synthetic Stop payload chosen to miss Rung 1
 * and reach Rung 2 (no recognised phrase, one entity ref), then asserts the
 * outcome does NOT carry `nomination-deps-unavailable`. Any other result — a
 * clean nomination, a real fire, a provider timeout — passes: this is a check on
 * whether the stage can RUN, not on what it concludes.
 *
 * ## Exit codes
 *
 *   0  checked, and the nomination stage reached its dependencies
 *   1  checked, and the stage degraded on `nomination-deps-unavailable` (the defect)
 *   2  the check could not run — never conflated with a pass
 *
 * A `domain-bootstrap-failed: <error>` outcome exits 2 rather than 1: the stage
 * was reached and told you why it stopped, which is a diagnosable environment
 * problem (no config file, no provider credentials) rather than this defect.
 * Conflating the two would make this script report a laptop without an embedding
 * key as a code regression.
 *
 * Usage: `bun scripts/verify-stale-state-nomination-bootstrap.ts`
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { run } from "../.minsky/hooks/turn-end-stale-state-assertion-scan";

/**
 * The defect's signature. Present => the stage never reached its dependencies.
 *
 * A PREFIX since mt#5051: the stage now appends `: <provider>: <scrubbed cause>`,
 * and for this defect the provider reads `unknown` because configuration could
 * not be read at all — the cause names it directly.
 */
const DEFECT_REASON = "nomination-deps-unavailable";

/**
 * A message that misses Rung 1 and reaches Rung 2.
 *
 * Rung 1 is a phrase matcher, so this deliberately avoids its recognised forms
 * while making a past-tense completion claim about a real entity ref — which is
 * what the ref gate needs before nomination is attempted at all.
 */
const PROBE_MESSAGE =
  "I went ahead and wrapped up the remaining piece on mt#5000 earlier today, " +
  "so that thread is settled and nothing further is owed on it.";

async function main(): Promise<never> {
  // A scratch flag store, so a repeat run is not deduplicated against the last
  // one and the probe cannot pollute the real turn-end store.
  const storeDir = mkdtempSync(join(tmpdir(), "mt5000-nomination-probe-"));

  try {
    const outcome = await run(
      {
        session_id: "mt5000-nomination-bootstrap-probe",
        stop_hook_active: false,
        cwd: process.cwd(),
        // Deliberately absent: the transcript read is a LATER stage, and letting
        // it fail keeps this probe pointed at the dependency stage alone.
        transcript_path: join(storeDir, "no-such-transcript.jsonl"),
        last_assistant_message: PROBE_MESSAGE,
      } as Parameters<typeof run>[0],
      {} as Parameters<typeof run>[1],
      storeDir
    );

    // `GuardOutcome.calibration` is an open record, so its `suppressionReasons`
    // arrives untyped. Narrow it here rather than casting at each use — and treat
    // a non-array as absent, so a malformed record cannot read as "no defect".
    const rawReasons = (outcome?.calibration as { suppressionReasons?: unknown } | undefined)
      ?.suppressionReasons;
    const reasons: string[] = Array.isArray(rawReasons) ? rawReasons.map(String) : [];

    const depsUnavailable = reasons.find((r) => r.startsWith(DEFECT_REASON));
    if (depsUnavailable !== undefined) {
      console.error(
        `[verify-stale-state-nomination-bootstrap] FAIL — the nomination stage ` +
          `degraded on "${depsUnavailable}", so it never reached its dependencies. ` +
          `This is mt#5000's defect: check that nominatePendingClaims still calls ` +
          `ensureHookDomainBootstrap() before resolveNominationDeps().`
      );
      return process.exit(1);
    }

    const bootstrapFailure = reasons.find((r) => r.startsWith("domain-bootstrap-failed:"));
    if (bootstrapFailure !== undefined) {
      console.error(
        `[verify-stale-state-nomination-bootstrap] CANNOT CHECK — the bootstrap ran ` +
          `and reported: ${bootstrapFailure}. The code path is intact; the ` +
          `environment could not initialize configuration. Not a regression.`
      );
      return process.exit(2);
    }

    console.log(
      `[verify-stale-state-nomination-bootstrap] OK — the nomination stage reached its ` +
        `dependencies. rung=${outcome?.calibration?.rung ?? "n/a"} ` +
        `fired=${outcome?.calibration?.fired ?? "n/a"} ` +
        `suppressionReasons=${reasons.length === 0 ? "(none)" : JSON.stringify(reasons)}`
    );
    return process.exit(0);
  } catch (err) {
    // Exit 2, never 1: an unexpected throw means the check did not complete, and
    // "could not check" must not read as "checked, found the defect" either way.
    console.error(
      `[verify-stale-state-nomination-bootstrap] CANNOT CHECK — the probe threw: ` +
        `${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`
    );
    return process.exit(2);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
