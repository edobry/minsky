#!/usr/bin/env bun
/**
 * Report whether the display linkifier is actually running (mt#4145).
 *
 * Before this existed, nothing did: `linkify-message-display.ts` sits off the
 * guard dispatcher (ADR-028 D1/D7(5)) so it writes no dispatcher fire-log
 * record, and its own contract makes every failure path a silent no-op. Three
 * layers had already stood down on the assumption it works, so an operator
 * noticing bare refs in their terminal was the only detector — which is exactly
 * how the 2026-08-13 incident (mem#623 R8) was found.
 *
 * Usage:
 *   bun scripts/check-linkify-liveness.ts                  # report, exit 0
 *   bun scripts/check-linkify-liveness.ts --window 6       # 6-hour window
 *   bun scripts/check-linkify-liveness.ts --json           # machine-readable
 *   bun scripts/check-linkify-liveness.ts --assert-live    # exit 1 unless live
 *
 * `--assert-live` is for a CI/smoke context that wants a hard signal. The bare
 * form always exits 0: on a fresh machine "no evidence" is the correct and
 * expected state, and a check that fails there would be noise, not a finding.
 */

import { checkLiveness } from "../.minsky/hooks/linkify-liveness";

function parseArgs(argv: string[]): { windowHours: number; json: boolean; assertLive: boolean } {
  let windowHours = 24;
  let json = false;
  let assertLive = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--assert-live") assertLive = true;
    else if (arg === "--window") {
      const next = Number(argv[i + 1]);
      if (!Number.isFinite(next) || next <= 0) {
        process.stderr.write(`--window needs a positive number of hours, got: ${argv[i + 1]}\n`);
        process.exit(2);
      }
      windowHours = next;
      i += 1;
    }
  }
  return { windowHours, json, assertLive };
}

function main(): void {
  const { windowHours, json, assertLive } = parseArgs(process.argv.slice(2));
  const summary = checkLiveness({ windowHours });

  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`${summary.headline}\n`);
    process.stdout.write(
      `  messages in window : ${summary.messages} (all time: ${summary.messagesAllTime})\n` +
        `  deltas in window   : ${summary.deltas}\n` +
        `  refs linked        : ${summary.linked} ` +
        `(task ${summary.totals.task}, PR ${summary.totals.changeset}, ` +
        `ask ${summary.totals.ask}, mem ${summary.totals.memory}, ws ${summary.totals.session})\n` +
        `  short ids left bare: ${summary.totals.shortIdUnresolved}\n` +
        `  newest record      : ${summary.newestAt ?? "(none)"}\n` +
        `  in-flight state    : ${summary.inFlightStatePresent ? "present" : "absent"}\n`
    );
  }

  if (assertLive && summary.verdict !== "live") {
    process.stderr.write(`FAIL: --assert-live but verdict is "${summary.verdict}"\n`);
    process.exit(1);
  }
  process.exit(0);
}

main();
