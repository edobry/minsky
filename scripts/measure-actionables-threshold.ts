#!/usr/bin/env bun
/**
 * Measure the actionables-decision family's similarity band, and pick its threshold (mt#4807).
 *
 * `decision-defaults.mdc §Thresholds` asks for observed cadence rather than a round number, and
 * this file's own lineage is why: `SETTLED_DECISION_RUNG2_THRESHOLD`'s docblock records
 * `DEFAULT_SIMILARITY_THRESHOLD` mis-fitting two corpora it was not measured on. So the constant
 * this script prints is derived from two LABELED populations that share most of their vocabulary:
 *
 *   - POSITIVES — Tier-0 decisions handed to the principal inside a terminal actionables block,
 *     with no ask filed. Every one is verbatim from the transcript corpus; the first is the turn
 *     mt#4807 was filed on.
 *   - NEGATIVES — units from the same blocks that must NOT fire. The load-bearing ones are not
 *     action bullets (those are lexically distant and prove nothing); they are the corpus-MANDATED
 *     shapes: a `humility.mdc §Subjective quality is not yours to certify` disclaimer, a
 *     `work-completion.mdc` self-resolving-wait report, and a bullet that already cites its ask.
 *     Those are the ones a naive widening punishes, and mem#1250 measured that class as this
 *     family's dominant false positive.
 *
 * The reported band is `[positive floor, negative ceiling]`. A threshold exists only if the floor
 * is ABOVE the ceiling; the script says so either way rather than printing a number that separates
 * nothing.
 *
 * EGRESS — the complete set of channels this script writes to (mt#4191):
 *   - stdout: labels, scores, and the derived band. The fixture text printed is the LABELED
 *     fixture text embedded in this file, which is already committed source — no corpus file is
 *     read and no unlabeled transcript text is printed.
 *   - network: the embedding provider, via `nominate` -> `resolveNominationDeps`. Each fixture
 *     string below is SENT to that provider. They are agent-authored report prose from this
 *     operator's own transcripts; that transmission is the whole point of the measurement, and it
 *     is named here rather than left implicit (mt#4191: a third-party SDK call is an egress even
 *     when its purpose reads as computation).
 *   - files written: none.  - subprocess: none.
 *
 * Usage:
 *   bun scripts/measure-actionables-threshold.ts
 */

import {
  ACTIONABLES_DECISION_EXEMPLAR_SET,
  ACTIONABLES_DECISION_THRESHOLD,
} from "../.minsky/hooks/ask-routing-deferral-detector";
import { splitUnitClauses } from "../.minsky/hooks/actionables-block";
import { nominate } from "../packages/domain/src/detectors/embedding-nomination";
import { resolveNominationDeps } from "../packages/domain/src/detectors/embedding-nomination-factory";
import { ensureHookDomainBootstrap } from "../.minsky/hooks/domain-bootstrap";

/** Verbatim Tier-0 decisions from terminal actionables blocks, none citing an ask. */
const POSITIVES: Array<[string, string]> = [
  [
    "P1 originating (e461ddb2 t296)",
    "- **One yes needed before PR 1:** a hashed JSON payload at a stable URL is a de facto dataset release of your *editorial* layer (all-rights-reserved; the code is MIT). Smaller than the doc implies — the raw tweets are already on the Community Archive's public API — but it should be a deliberate yes.",
  ],
  [
    "P2 same decision, next day (8a6c7128 t154)",
    "- **The mt#4678 agent needs two things from you**: a yes/no on publishing the corpus payload at a stable URL under all-rights-reserved, and a Claude Code window opened *in* `~/Projects/peezombie.me`.",
  ],
  [
    "P3 naming decision",
    "- **The name is the one open decision.** Recommendation: `work package` for the entity, `handoff` retained as the act that writes one. Everything downstream — table, tools, cockpit route — is blocked on it.",
  ],
  [
    "P4 confirm-an-option",
    '- **Confirm `work package` / `handoff` / leave `docket`** — that\'s the last thing between here and building. One RFC edit flips it from "recommended" to "decided."',
  ],
  [
    "P5 RFC acceptance",
    "- **Still Draft.** Accepting releases Phase 1, which is also the containment fix for the five-recurrence family from earlier.",
  ],
  [
    "P6 needs-a-call-from-you",
    "- **mt#4682 needs a call from you.** 98% of workspace links (1,699 of 1,733) point at sessions that no longer exist — steady state on every single day, and a consequence of two correct decisions meeting, not a bug.",
  ],
  [
    "P7 direction still waiting",
    "- **mt#4735's tiering direction is still waiting on you** — four candidate directions are enumerated in its spec, none pre-selected.",
  ],
  [
    "P8 bare imperative + spend",
    "- **Pick the order.** My recommendation: balance alert first (smallest, prevents recurrence), then own-fleet attribution (build), then decide on OpenAI org spend once you've seen the usage page split.",
  ],
  [
    "P9 request for a value",
    "- Tell me the split and I'll take the right task: **mt#2718** if it's gpt-5, or measure the post-mt#4345 transcript-embedding rate if it's embeddings.",
  ],
  [
    "P10 scope call handed over",
    "- **Flagged, not actioned:** removing the inlined `index.html` still leaves ~8.5 MB of corpus in git *history*. Purging that is a separate rewrite and your call.",
  ],
];

/** Verbatim units that must NOT fire. The first three are corpus-MANDATED shapes. */
const NEGATIVES: Array<[string, string]> = [
  [
    "N1 MANDATED humility.mdc subjective-quality disclaimer",
    "- Screenshots are above and in the PR; whether the layout reads well is your call, not something I've asserted.",
  ],
  [
    "N2 MANDATED work-completion.mdc self-resolving wait",
    "- **Nothing needed from you right now** — merge fires automatically when CI goes green.",
  ],
  [
    "N3 MANDATED routed decision, ask cited",
    "- **[ask#9672](minsky://ask/cd95752e) — suspended 4 days, now decides for two tasks.** Answering it unblocks the handoff's #1 priority.",
  ],
  [
    "N4 ordinary action bullet",
    "- Merge PR #3508 once the bot approves, then enable R2 in the Cloudflare dashboard.",
  ],
  [
    "N5 filed-work pointer",
    "- Filed: mt#4799 (rename the mis-named `stale` field) and mt#4801 (a flaky ChangesetsPage test I hit under full-suite load — not mine, green in CI).",
  ],
  [
    "N6 status report naming remaining work",
    "- **mt#4787** is the last open child of mt#4760 — small, a percentage that renders backwards.",
  ],
  [
    "N7 finding recorded, no decision",
    "- Unowned: the analyzer produced **no answer on 93 of 785 runs (11.8%)** and nobody has read that field.",
  ],
  [
    "N8 agent-owned next step",
    "- **mt#4494** (TODO) — the structural fix, filed and spec-corrected, not yet planned. I'll walk it once the proxy is clean.",
  ],
  [
    "N9 collision note",
    "- mt#4534 and mt#4525 touch the same test file; whichever ships second rebases.",
  ],
  [
    "N10 deferred-not-yet-a-decision",
    "- **A spend decision on mt#4577 is coming** once the token split is measured. Nothing to do now.",
  ],
];

async function main(): Promise<void> {
  const bootstrap = await ensureHookDomainBootstrap();
  if (!bootstrap.ok) {
    console.log("SKIP: domain bootstrap failed — no embedding provider available here");
    return;
  }
  const deps = await resolveNominationDeps();
  if (deps === null || !deps.semantic) {
    console.log("SKIP: no semantic embedding provider configured");
    return;
  }

  // Threshold 0 so every fixture reports its raw best score rather than a verdict,
  // and CLAUSE-SPLIT so this measures what the detector actually scores. Measuring
  // the whole bullet would report a band the shipped path never sees — the
  // originating fixture alone differs by 0.31 between the two.
  //
  // Retries a degraded result rather than scoring it 0. That distinction is the
  // whole point: a 0 is indistinguishable from a real low score, so swallowing a
  // provider timeout would silently move the measured band and nothing would
  // look wrong (mem#704 — a probe that returns the same answer when the system
  // is broken carries no information). After the retries it THROWS, so a run
  // that could not measure ends loudly instead of reporting a band it did not
  // observe. Observed once in practice, under a load average of 21.
  const score = async (text: string): Promise<number> => {
    const scored = splitUnitClauses(text);
    if (scored === "") return 0;
    let lastReason = "unknown";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const r = await nominate(scored, [ACTIONABLES_DECISION_EXEMPLAR_SET], deps, { threshold: 0 });
      if (!r.degraded) return r.nominations[0]?.score ?? 0;
      lastReason = r.degradedReason ?? "unknown";
    }
    throw new Error(`degraded after 3 attempts: ${lastReason}`);
  };

  const pos: Array<[string, number]> = [];
  for (const [label, text] of POSITIVES) pos.push([label, await score(text)]);
  const neg: Array<[string, number]> = [];
  for (const [label, text] of NEGATIVES) neg.push([label, await score(text)]);

  console.log("POSITIVES (must fire)");
  for (const [l, s] of [...pos].sort((a, b) => a[1] - b[1])) console.log(`  ${s.toFixed(4)}  ${l}`);
  console.log("\nNEGATIVES (must not fire)");
  for (const [l, s] of [...neg].sort((a, b) => b[1] - a[1])) console.log(`  ${s.toFixed(4)}  ${l}`);

  const posFloor = Math.min(...pos.map(([, s]) => s));
  const negCeil = Math.max(...neg.map(([, s]) => s));
  console.log(`\npositive floor  ${posFloor.toFixed(4)}`);
  console.log(`negative ceiling ${negCeil.toFixed(4)}`);

  if (posFloor > negCeil) {
    const mid = (posFloor + negCeil) / 2;
    console.log(`SEPARABLE. band ${negCeil.toFixed(4)}..${posFloor.toFixed(4)}`);
    console.log(
      `midpoint ${mid.toFixed(4)}  (margin ${((posFloor - negCeil) / 2).toFixed(4)} each way)`
    );
  } else {
    // Reported, not designed away. A threshold that reaches every positive would
    // also fire on a corpus-MANDATED sentence, which is worse than a miss.
    const safe = neg.filter(([, s]) => s > posFloor).length;
    console.log(`NOT FULLY SEPARABLE — ${safe} negative(s) score above the positive floor.`);
    console.log("Pick a threshold ABOVE the negative ceiling and report the positives it misses.");
    const reached = pos.filter(([, s]) => s > negCeil);
    console.log(
      `A floor-safe threshold just above ${negCeil.toFixed(4)} reaches ${reached.length}/${pos.length} positives.`
    );
    for (const [l, s] of pos.filter(([, s]) => s <= negCeil))
      console.log(`  MISSED at floor-safe: ${s.toFixed(4)}  ${l}`);
  }
  console.log(`\nshipped constant is currently ${ACTIONABLES_DECISION_THRESHOLD}`);
}

await main();
