#!/usr/bin/env bun
/**
 * mt#4311 — replay the offer-shape trigger over REAL calibration records.
 *
 * The task's measurement criterion asks for the injected count and false-positive
 * rate after the change, against ADR-024's sufficiency bar. A unit fixture cannot
 * supply that: it measures agreement with the author, which is the one thing that
 * cannot fail. This reads the captured context off every injected record that
 * fired an `offer-shape:*` leg and re-judges it with the CURRENT matcher.
 *
 * WHAT "BEFORE" MEANS HERE, stated because it is not free — and because the
 * first cut of this script got it wrong (PR #3211 R2 caught this docblock still
 * describing that first cut).
 *
 * The tempting reading is that a record's presence in the log IS the
 * before-state: the leg fired, or the record would not carry the label. That is
 * wrong for a measurable share of records, because `matches[].context` is capped
 * at 240 characters — the captured window is often a TRUNCATION of the line the
 * detector judged, and replaying it reproduces no fire under EITHER matcher.
 * Counting those as "silenced by the change" credits the change with fires it
 * never had.
 *
 * So BEFORE is COMPUTED, per record, as `namesAgentAction(x) && hasMenuShape(x)`
 * — the pre-mt#4311 relation itself, both halves still exported and unchanged.
 * Records that do not reproduce a fire on their captured window are counted in
 * their own column and excluded from the before/after totals.
 *
 * What this still does NOT measure: fires the old matcher missed entirely. There
 * is no record for a non-fire, so recall lives in the test suite's floor.
 *
 * The judged text is `matches[].context`, which the emitting guard caps at 240
 * characters. A verdict here is therefore a verdict about the CAPTURED WINDOW,
 * not necessarily the full line the detector saw. Reported as such.
 *
 * USAGE
 *   bun scripts/replay-offer-shape.ts [--log <path>]... [--verbose]
 *
 * A missing log is a SKIP (exit 0), not a failure — calibration logs are local
 * runtime state and are not present in CI.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { calibrationLogPath } from "../.minsky/hooks/dispatcher";
import {
  findOfferShape,
  hasMenuShape,
  namesAgentAction,
} from "../.minsky/hooks/ask-routing-deferral-detector";
import { safeTruncate } from "../src/utils/safe-truncate";

interface Match {
  phrase?: string;
  context?: string;
}
interface Record_ {
  injection_enabled?: boolean;
  matches?: Match[];
  session_id?: string;
  timestamp?: string;
}

/**
 * mt#4971: resolved through the WRITER's own function rather than the pre-mt#4748
 * repo paths, which no longer exist — reading them produced a SKIP that looked like
 * "no records" rather than "wrong location". `fallbackCwd` (not `projectDir`) keeps
 * the resolver's `CLAUDE_PROJECT_DIR` tier ahead of this checkout.
 */
const DEFAULT_LOGS = ["ask-routing-deferral", "operator-deferral"].map((name) =>
  calibrationLogPath(name, { fallbackCwd: resolve(import.meta.dir, "..") })
);

const argv = process.argv.slice(2);
const verbose = argv.includes("--verbose");
const explicit: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--log") {
    const next = argv[++i];
    if (next) explicit.push(next);
  }
}
// Resolve against the repo the logs actually live in: a session clone does not
// carry them (they are gitignored runtime state of the MAIN workspace).
const roots = [process.cwd(), join(homedir(), "Projects", "minsky")];
const logs = explicit.length > 0 ? explicit : DEFAULT_LOGS;

let anyRead = false;
const tally = new Map<string, { before: number; stillFires: number; unreproducible: number }>();
const stopped: Array<{ leg: string; context: string }> = [];

for (const rel of logs) {
  const path = explicit.includes(rel)
    ? rel
    : (roots.map((r) => join(r, rel)).find((p) => existsSync(p)) ?? rel);
  if (!existsSync(path)) {
    process.stdout.write(`SKIP: log not found: ${rel}\n`);
    continue;
  }
  anyRead = true;
  let injected = 0;
  let unknownInjection = 0;
  let offerMatches = 0;
  let stillFiring = 0;
  let unreproducible = 0;

  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (raw.trim() === "") continue;
    let rec: Record_;
    try {
      rec = JSON.parse(raw) as Record_;
    } catch {
      continue; // a torn trailing write; not a finding
    }
    // `injection_enabled` is TRI-STATE — true / false / absent — and the third
    // case is reported rather than folded into the second. A record that never
    // says whether it injected is UNKNOWN, and counting it as not-injected would
    // let a schema change quietly shrink the denominator.
    //
    // NOT a live problem in either log today: operator-deferral carries an
    // explicit `false` on all 108 of its records (the detector is quieted there,
    // so its 17 offer-shape matches are suppressed, not injected), and
    // ask-routing carries `true`. Recorded because `jq '.injection_enabled //
    // "absent"'` reports BOTH false and absent as "absent" — `//` falls through
    // on false — so the two are easy to conflate while reading the log, which is
    // exactly what happened while writing this script.
    if (rec.injection_enabled === false) continue;
    if (rec.injection_enabled === true) injected++;
    else unknownInjection++;
    for (const m of rec.matches ?? []) {
      const leg = m.phrase ?? "";
      const context = m.context ?? "";
      if (!leg.startsWith("offer-shape:") || context === "") continue;
      offerMatches++;
      const entry = tally.get(leg) ?? { before: 0, stillFires: 0, unreproducible: 0 };

      // The BEFORE state is COMPUTED, not inferred from the record's existence.
      //
      // That inference is what the first cut made, and it is wrong for a
      // measurable share of records: `matches[].context` is capped at 240
      // characters by the emitting guard, so the captured window is often a
      // TRUNCATION of the line the detector actually judged. Replaying such a
      // window reproduces no fire under EITHER matcher — and scoring it as
      // "silenced by this change" credits the change with a fire it never had.
      // Verified on a real record: the `should I stop letting my own writing
      // count as evidence` fire has `namesAgentAction === false` on its captured
      // window, so it cannot have fired on that text under the old relation.
      //
      // `namesAgentAction(x) && hasMenuShape(x)` IS the pre-mt#4311 relation,
      // and both halves are still exported and unchanged, so this is the old
      // predicate itself rather than a reconstruction of it.
      const firedBefore = namesAgentAction(context) && hasMenuShape(context);
      if (!firedBefore) {
        entry.unreproducible++;
        unreproducible++;
        tally.set(leg, entry);
        continue;
      }
      entry.before++;
      if (findOfferShape(context) !== null) {
        entry.stillFires++;
        stillFiring++;
      } else {
        stopped.push({ leg, context });
      }
      tally.set(leg, entry);
    }
  }
  const reproducible = offerMatches - unreproducible;
  process.stdout.write(
    `${rel}\n  injected=${injected} injection-unknown=${unknownInjection}\n` +
      `  offer-shape matches=${offerMatches}  reproducible-on-captured-window=${reproducible} ` +
      `not-reproducible=${unreproducible}\n` +
      `  of the reproducible: still firing=${stillFiring} now silent=${reproducible - stillFiring}\n`
  );
}

if (!anyRead) {
  process.stdout.write("SKIP: no calibration logs available\n");
  process.exit(0);
}

process.stdout.write(
  "\nby leg, over records reproducible on their captured window (before -> after):\n"
);
for (const [leg, { before, stillFires, unreproducible: unrep }] of [...tally.entries()].sort()) {
  process.stdout.write(
    `  ${leg.padEnd(28)} ${String(before).padStart(4)} -> ${String(stillFires).padStart(4)}` +
      `   silenced=${before - stillFires}   not-reproducible=${unrep}\n`
  );
}

if (verbose) {
  process.stdout.write("\nsilenced contexts:\n");
  for (const { leg, context } of stopped) {
    // Calibration contexts are agent prose and routinely carry emoji and
    // typographic quotes, so a raw `.slice` can split a surrogate pair.
    process.stdout.write(`  [${leg}] ${safeTruncate(context.replace(/\n/g, " "), 150, "head")}\n`);
  }
}
process.exit(0);
