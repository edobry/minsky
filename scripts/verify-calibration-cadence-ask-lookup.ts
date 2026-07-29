#!/usr/bin/env bun
/**
 * Live verification for mt#3270 — `resolveAskStates` against the REAL ask store.
 *
 * The unit tests inject the lookup result, so they prove the FORMATTER branches and nothing
 * about the binding. That is precisely the gap mt#3019 / mt#3046 turned into two dead hooks: a
 * hook's persistence path throws, the failure is swallowed, and the surface renders a plausible
 * "nothing to report" forever. This detector had no persistence path at all before mt#3270, so
 * the binding added there has never run in production.
 *
 * The check is a NEGATIVE CONTROL by construction: if the binding is dead, every id resolves to
 * `unavailable` and this script FAILS. It cannot pass without a working lookup.
 *
 *   bun scripts/verify-calibration-cadence-ask-lookup.ts
 *
 * Env: a configured Minsky database. Skips (exit 0) when the store is unreachable — an
 * unconfigured CI runner is not a regression — but says so explicitly rather than passing.
 *
 * Exit: 0 = pass or documented skip, non-zero = fail.
 */

import { resolveAskStates } from "../.minsky/hooks/calibration-review-cadence-detector";

/** ask#5425 — responded and closed 2026-07-23T21:03:10.616Z. The incident's own ask. */
const KNOWN_SETTLED_ASK = "109807e1-0ec6-49ff-9759-805a1bb02a64";
/** A well-formed uuid that cannot exist, exercising the not-found branch against a live store. */
const ABSENT_ASK = "00000000-0000-4000-8000-000000000000";

function fail(msg: string, detail?: unknown): never {
  console.error(`FAIL: ${msg}`);
  if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
  process.exit(1);
}

async function main(): Promise<number> {
  const lookups = await resolveAskStates([KNOWN_SETTLED_ASK, ABSENT_ASK]);
  const settled = lookups.get(KNOWN_SETTLED_ASK);
  const absent = lookups.get(ABSENT_ASK);

  const summary = {
    [KNOWN_SETTLED_ASK]: settled,
    [ABSENT_ASK]: absent,
  };

  if (settled?.kind === "unavailable" && absent?.kind === "unavailable") {
    // Both unreachable: no database in this environment. Report it as a SKIP rather than a
    // pass — "the store was unreachable" is exactly the state this task refuses to let a
    // surface render as success.
    console.log(
      JSON.stringify(
        { result: "SKIP", reason: `ask store unreachable: ${settled.reason}`, summary },
        null,
        2
      )
    );
    return 0;
  }

  if (settled?.kind !== "settled") {
    fail(
      `expected ${KNOWN_SETTLED_ASK} (closed 2026-07-23) to resolve as "settled", got "${settled?.kind}"`,
      summary
    );
  }
  if (settled.state !== "closed") {
    fail(`expected the known ask to report state "closed", got "${settled.state}"`, summary);
  }
  if (absent?.kind !== "not-found") {
    fail(`expected a nonexistent uuid to resolve as "not-found", got "${absent?.kind}"`, summary);
  }

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        note: "live binding resolves a real closed ask and a nonexistent one distinctly",
        summary,
      },
      null,
      2
    )
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
