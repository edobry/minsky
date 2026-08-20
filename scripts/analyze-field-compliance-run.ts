#!/usr/bin/env bun
/**
 * mt#4365 — the PRE-REGISTERED analysis of a field-compliance run.
 *
 * ## Why this is a committed script and not an ad-hoc query
 *
 * mt#4317 produced a p = 0.0063 result that did not replicate, and separately turned a
 * p = 0.15 into a p = 0.03 by analyzing the same data two defensible-looking ways: counting
 * paired rows as independent observations, and splitting at the smallest failing prompt rather
 * than at a threshold chosen in advance. Neither was deliberate. Both are what happens when the
 * analysis is written after the numbers are visible.
 *
 * So the analysis lives here, in the repo, written and committed BEFORE the run it analyzes.
 * That is what makes "pre-registered" a checkable claim rather than an assurance: the threshold,
 * the unit of analysis, and the test are all in git history with a timestamp earlier than the
 * data file.
 *
 * ## The pre-registered primary test (mt#4365 spec, §Pre-registration)
 *
 * - **H0:** the schema-violation rate is equal below and above the threshold.
 * - **Threshold:** 10,000 characters of rendered user prompt. FIXED IN ADVANCE. It is the prior
 *   run's smallest failing prompt (9,932) rounded — which is why it may only be applied to NEW
 *   data. Splitting the run that produced it would be circular; splitting a later one is an
 *   out-of-sample test of a pre-specified cut.
 * - **Unit:** one transcript, one observation. The run has a single arm precisely so that a
 *   row and an observation cannot come apart.
 * - **Test:** Fisher exact, two-sided. Chosen over chi-square because the below-threshold cell
 *   is expected to be small, which is where chi-square's approximation is worst.
 *
 * Everything else this prints is EXPLORATORY and labelled so. An exploratory p-value cannot be
 * promoted to the headline by having come out smaller.
 *
 * Usage:
 *   bun scripts/analyze-field-compliance-run.ts .tmp/prereg-run.jsonl
 */

import { readFileSync } from "node:fs";

/** Fixed by the mt#4365 pre-registration. Do not tune to a run. */
const THRESHOLD_CHARS = 10_000;

interface Row {
  conversationId: string;
  arm: string;
  totalMessages: number;
  analyzedMessages: number;
  fullWindow: boolean;
  promptChars: number;
  /**
   * The structured-output strategy actually sent, as recorded by the harness.
   *
   * OPTIONAL on purpose: datasets collected before the field existed simply lack the key, and
   * the analysis must be able to say "unknown" for those rather than assume a value. `null`
   * means the request set no mode — production's SDK default — which is a DIFFERENT fact from
   * the key being absent.
   */
  mode?: "auto" | "json" | "tool" | null;
  outcome:
    | { kind: "ok"; findingCount: number; summaryChars: number }
    | { kind: "schema-violation"; paths: string[]; message: string }
    | { kind: "call-error"; message: string };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** log(n!) via lgamma, so a 200-row table cannot overflow a factorial. */
function logFactorial(n: number): number {
  let acc = 0;
  for (let i = 2; i <= n; i++) acc += Math.log(i);
  return acc;
}

/** Probability of one specific 2x2 table under the hypergeometric null. */
function tableProbability(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  return Math.exp(
    logFactorial(a + b) +
      logFactorial(c + d) +
      logFactorial(a + c) +
      logFactorial(b + d) -
      logFactorial(n) -
      logFactorial(a) -
      logFactorial(b) -
      logFactorial(c) -
      logFactorial(d)
  );
}

/**
 * Two-sided Fisher exact: sum the probability of every table at least as extreme as observed,
 * holding the margins fixed. "At least as extreme" is by PROBABILITY, which is the conventional
 * two-sided definition and does not require picking a direction after the fact.
 */
export function fisherExactTwoSided(a: number, b: number, c: number, d: number): number {
  const observed = tableProbability(a, b, c, d);
  const rowOne = a + b;
  const colOne = a + c;
  const n = a + b + c + d;
  let total = 0;
  const lo = Math.max(0, colOne - (n - rowOne));
  const hi = Math.min(rowOne, colOne);
  for (let i = lo; i <= hi; i++) {
    const p = tableProbability(i, rowOne - i, colOne - i, n - rowOne - colOne + i);
    if (p <= observed * (1 + 1e-9)) total += p;
  }
  return Math.min(1, total);
}

/** Wilson score interval — behaves at 0/n and n/n, where the normal approximation does not. */
/**
 * Newcombe (1998) Method 10 — CI for the difference of two CORRELATED proportions.
 *
 * Replaces a Wald interval (PR #3204 R2). Two things are worth separating there, because the
 * finding and its remedy were right for different reasons:
 *
 * The Wald SE that was here — `sqrt((b+c) − (b−c)²/n)/n` — is NOT ad-hoc. It is the standard
 * estimated SE for the difference of correlated proportions (Agresti, matched pairs), and it
 * was applied correctly.
 *
 * It was still the wrong CHOICE. The Wald interval for matched pairs is known to under-cover
 * badly when the DISCORDANT count is small, and this analysis ran at 4 discordant pairs —
 * squarely in that regime, and the interval was carrying a "bounded null" conclusion. Newcombe's
 * square-and-add method is built from Wilson intervals on the two marginals plus a correlation
 * correction, and holds its coverage at exactly the small counts where Wald fails.
 *
 * Cells are the matched-pairs table: `bothFail`, `onlyAFails`, `onlyBFails`, `bothOk`.
 */
export function newcombePairedDifferenceCI(
  bothFail: number,
  onlyAFails: number,
  onlyBFails: number,
  bothOk: number
): [number, number] {
  const n = bothFail + onlyAFails + onlyBFails + bothOk;
  if (n === 0) return [0, 0];

  const p1 = (bothFail + onlyAFails) / n;
  const p2 = (bothFail + onlyBFails) / n;
  const delta = p1 - p2;

  const [l1, u1] = wilson(bothFail + onlyAFails, n);
  const [l2, u2] = wilson(bothFail + onlyBFails, n);

  // Correlation between the two marginals, from the table. When any margin is empty the
  // product is 0 and phi is undefined — Newcombe's convention is to take 0, which reduces the
  // method to the independent-samples square-and-add rather than silently producing NaN.
  const marginProduct =
    (bothFail + onlyAFails) *
    (onlyBFails + bothOk) *
    (bothFail + onlyBFails) *
    (onlyAFails + bothOk);
  const phi =
    marginProduct > 0
      ? Math.max(
          -1,
          Math.min(1, (bothFail * bothOk - onlyAFails * onlyBFails) / Math.sqrt(marginProduct))
        )
      : 0;

  const lower =
    delta -
    Math.sqrt(Math.max(0, (p1 - l1) ** 2 - 2 * phi * (p1 - l1) * (u2 - p2) + (u2 - p2) ** 2));
  const upper =
    delta +
    Math.sqrt(Math.max(0, (u1 - p1) ** 2 - 2 * phi * (u1 - p1) * (p2 - l2) + (p2 - l2) ** 2));
  return [Math.max(-1, lower), Math.min(1, upper)];
}

export function wilson(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.959963985;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - halfWidth), Math.min(1, centre + halfWidth)];
}

/** Binomial coefficient via logs, so a 100-pair table cannot overflow. */
function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/**
 * McNemar exact, two-sided: an exact binomial sign test on the DISCORDANT pairs only.
 *
 * Concordant pairs carry no information about which arm is better — a transcript both arms
 * reject, or both accept, is silent on the comparison — so they are excluded by construction
 * rather than by choice. `b` and `c` are the two discordant counts.
 *
 * The exact form is used rather than the chi-square approximation because the pre-registered
 * design expects ~36 discordant pairs, which is squarely in the range where the approximation
 * misbehaves.
 */
export function mcnemarExactTwoSided(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------

/**
 * mt#4365 Run 2: the PRE-REGISTERED paired comparison of two arms over the same transcripts.
 *
 * A transcript answered by both arms is ONE pair, not two observations — which is the exact
 * arithmetic mt#4317 got wrong when it read 80 rows as 80 independent points. Pairs are
 * assembled by conversation id here so that miscount is not expressible.
 */
function pairedAnalysis(rows: Row[], callErrorCount: number, arms: string[]): void {
  // Fail loudly rather than analyzing the first two and dropping the rest (PR #3204 R3). The
  // harness supports arbitrarily many named arms, and `arms` here comes from a Set over the
  // data — so a three-arm dataset would silently produce a two-arm result whose omission is
  // invisible in the output. For a script whose purpose is an auditable pre-registered
  // analysis, publishing a partial result is worse than publishing none.
  if (arms.length !== 2) {
    console.error(
      `Paired analysis requires exactly 2 arms; this dataset has ${arms.length}: ` +
        `${arms.join(", ")}. Re-run the harness with two arms, or split the file — this script ` +
        `will not silently analyze a subset.`
    );
    process.exit(2);
  }
  const [armA, armB] = arms as [string, string];
  const byConversation = new Map<string, Map<string, Row>>();
  for (const r of rows) {
    if (!byConversation.has(r.conversationId)) byConversation.set(r.conversationId, new Map());
    byConversation.get(r.conversationId)?.set(r.arm, r);
  }

  // Only transcripts BOTH arms answered can form a pair. A transcript one arm failed to reach
  // (a dropped call) is dropped entirely rather than counted against the arm that did answer.
  const pairs = [...byConversation.values()].filter((m) => m.has(armA) && m.has(armB));
  const incomplete = byConversation.size - pairs.length;

  const failed = (r: Row | undefined): boolean => r?.outcome.kind === "schema-violation";

  let bothFail = 0;
  let bothOk = 0;
  let onlyAFails = 0;
  let onlyBFails = 0;
  for (const m of pairs) {
    const a = failed(m.get(armA));
    const b = failed(m.get(armB));
    if (a && b) bothFail++;
    else if (!a && !b) bothOk++;
    else if (a) onlyAFails++;
    else onlyBFails++;
  }

  const aFail = bothFail + onlyAFails;
  const bFail = bothFail + onlyBFails;
  const [aLo, aHi] = wilson(aFail, pairs.length);
  const [bLo, bHi] = wilson(bFail, pairs.length);

  console.log("=== mt#4365 RUN 2 — PRE-REGISTERED PAIRED ANALYSIS ===");
  console.log(`arms: ${armA} vs ${armB}`);
  console.log(`complete pairs: ${pairs.length}   incomplete (dropped): ${incomplete}`);
  console.log(`call errors excluded: ${callErrorCount}`);
  console.log("");
  console.log(
    `${armA.padEnd(12)} ${aFail}/${pairs.length} = ${pct(aFail / pairs.length)}  ` +
      `(95% CI ${pct(aLo)}–${pct(aHi)})`
  );
  console.log(
    `${armB.padEnd(12)} ${bFail}/${pairs.length} = ${pct(bFail / pairs.length)}  ` +
      `(95% CI ${pct(bLo)}–${pct(bHi)})`
  );
  console.log("");
  console.log(`both reject: ${bothFail}   both accept: ${bothOk}   (concordant — carry no signal)`);
  console.log(`only ${armA} rejects: ${onlyAFails}   only ${armB} rejects: ${onlyBFails}`);

  const discordant = onlyAFails + onlyBFails;
  const p = mcnemarExactTwoSided(onlyAFails, onlyBFails);
  console.log("");
  console.log(`discordant pairs: ${discordant} (pre-registered target ~36)`);
  console.log(`McNemar exact, two-sided: p = ${p.toFixed(5)}`);

  // The pre-registration commits to reporting a CI on the DIFFERENCE when the test is null,
  // because "failed to reject" alone is compatible with both "no effect" and "no power" and a
  // reader cannot tell which.
  //
  // Newcombe rather than Wald (PR #3204 R2). The Wald SE for correlated proportions is standard
  // and was applied correctly, but it under-covers at small DISCORDANT counts — and this run
  // has 4, with the interval carrying the bounded-vs-underpowered verdict below.
  const diff = (onlyAFails - onlyBFails) / pairs.length;
  const [loDiff, hiDiff] = newcombePairedDifferenceCI(bothFail, onlyAFails, onlyBFails, bothOk);
  console.log(
    `paired difference (${armA} − ${armB}): ${(100 * diff).toFixed(1)} points  ` +
      `(95% CI ${(100 * loDiff).toFixed(1)} to ${(100 * hiDiff).toFixed(1)})`
  );
  console.log(
    `observed discordance rate: ${pct(discordant / pairs.length)} ` +
      `— the H1 design assumed 37.4%, so a value far below that falsifies the design's own ` +
      `premise rather than merely failing to confirm it`
  );
  if (p < 0.05) {
    const better = onlyAFails > onlyBFails ? armB : armA;
    console.log(
      `>>> REJECT H0. ${better} rejects LESS often. ONE run — SC4 replication still owed.`
    );
  } else {
    // "Failed to reject" is compatible with no-effect AND with no-power, and the honest default
    // is the weaker reading. But when the CI is narrow enough to EXCLUDE the effect the run was
    // designed to detect, the stronger reading is licensed — so the verdict is derived from the
    // interval rather than fixed in advance as a disclaimer. The rule is general: compare the
    // CI against the pre-registered MDE, whatever they turn out to be.
    const MDE_POINTS = 17;
    const excludesMde = Math.max(Math.abs(loDiff), Math.abs(hiDiff)) * 100 < MDE_POINTS;
    console.log(
      excludesMde
        ? `>>> FAIL TO REJECT H0 — and the CI EXCLUDES the ${MDE_POINTS}-point effect this run ` +
            `was designed to detect. That is a bounded null, not an underpowered one: an effect ` +
            `this size is ruled out, though a small one is not.`
        : `>>> FAIL TO REJECT H0. The CI still admits the ${MDE_POINTS}-point effect this run ` +
            `was designed to detect, so this is UNDERPOWERED — NOT evidence of no effect.`
    );
  }

  console.log("");
  console.log("=== EXPLORATORY (declared secondary — not confirmatory) ===");
  for (const arm of arms) {
    const byField: Record<string, number> = {};
    for (const m of pairs) {
      const r = m.get(arm);
      if (r?.outcome.kind !== "schema-violation") continue;
      for (const f of r.outcome.paths) byField[f] = (byField[f] ?? 0) + 1;
    }
    console.log(`exploratory — ${arm} missing-field breakdown: ${JSON.stringify(byField)}`);
  }

  // Does any benefit concentrate in the large-prompt stratum? Run 1 showed size predicts
  // rejection; if a mode benefit is size-dependent the two levers interact. NOT powered for this.
  for (const label of ["below", "at/above"] as const) {
    const stratum = pairs.filter((m) => {
      const size = m.get(armA)?.promptChars ?? 0;
      return label === "below" ? size < THRESHOLD_CHARS : size >= THRESHOLD_CHARS;
    });
    const sa = stratum.filter((m) => failed(m.get(armA))).length;
    const sb = stratum.filter((m) => failed(m.get(armB))).length;
    console.log(
      `exploratory — ${label} ${THRESHOLD_CHARS}: ${armA} ${sa}/${stratum.length}, ` +
        `${armB} ${sb}/${stratum.length}   [interaction check — run is NOT powered for this]`
    );
  }
}

function main(): void {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: bun scripts/analyze-field-compliance-run.ts <rows.jsonl>");
    process.exit(2);
  }

  const rows: Row[] = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Row);

  // A call error is a provider/transport failure and says nothing about whether the model
  // complied with the schema. Counting it as a violation inflates the very rate under test.
  const callErrors = rows.filter((r) => r.outcome.kind === "call-error");
  const analyzed = rows.filter((r) => r.outcome.kind !== "call-error");

  const arms = [...new Set(analyzed.map((r) => r.arm))];
  if (arms.length > 1) {
    pairedAnalysis(analyzed, callErrors.length, arms);
    return;
  }

  // One arm by design, so a duplicated conversation would mean a harness bug, not a pairing.
  const distinct = new Set(analyzed.map((r) => r.conversationId));
  const duplicated = analyzed.length - distinct.size;

  const failed = (r: Row): boolean => r.outcome.kind === "schema-violation";
  const below = analyzed.filter((r) => r.promptChars < THRESHOLD_CHARS);
  const above = analyzed.filter((r) => r.promptChars >= THRESHOLD_CHARS);
  const belowFail = below.filter(failed).length;
  const aboveFail = above.filter(failed).length;

  console.log("=== mt#4365 PRE-REGISTERED PRIMARY ANALYSIS ===");
  console.log(`threshold (fixed in advance): ${THRESHOLD_CHARS} prompt chars`);
  console.log(`unit of analysis: transcript (one call each)`);
  console.log("");
  console.log(`transcripts analyzed: ${analyzed.length}`);
  console.log(`call errors excluded:  ${callErrors.length}`);
  if (duplicated > 0) console.log(`WARNING: ${duplicated} duplicate conversation rows`);
  console.log("");

  const overallFail = analyzed.filter(failed).length;
  const [oLo, oHi] = wilson(overallFail, analyzed.length);

  // Describe the configuration from the DATA, never from the arm's name (PR #3204 R1).
  //
  // This line previously read "SC1 — production baseline under `auto`" unconditionally, so a
  // dataset gathered under any other configuration would have been labelled `auto` anyway.
  // In a script whose entire purpose is an auditable analysis, an unverifiable assertion in the
  // output is the same defect class as the mislabeled baselines this task exists to correct —
  // and it is how a 12.5% figure taken under tool mode got carried for a day as production's.
  //
  // `mode` is recorded per row by the harness. Older datasets predate that field, so absence is
  // reported as unknown rather than assumed: an unrecorded configuration and a verified `auto`
  // must not print the same way.
  // Keyed on PRESENCE, not on `??`. `mode: null` means "no mode set — production's `auto`",
  // which is a KNOWN configuration; an absent key means the dataset predates the field and the
  // configuration is UNKNOWN. `r.mode ?? "unrecorded"` collapses those two into one string,
  // manufacturing a value for a key that isn't there — the same projection hazard this cluster
  // keeps meeting. `in` distinguishes them; the nullish operator cannot.
  const describeMode = (r: Row): string =>
    "mode" in r ? (r.mode === null ? "auto (no mode set)" : String(r.mode)) : "unrecorded";
  const modes = [...new Set(analyzed.map(describeMode))];
  const armLabel = [...new Set(analyzed.map((r) => r.arm))].join("+");
  const configLabel =
    modes.length !== 1
      ? `arm "${armLabel}", MIXED modes: ${modes.join(", ")}`
      : modes[0] === "unrecorded"
        ? `arm "${armLabel}", mode NOT RECORDED in this dataset — verify separately`
        : modes[0] === "auto (no mode set)"
          ? `arm "${armLabel}", no mode set (SDK default \`auto\`) — production configuration`
          : `arm "${armLabel}", mode=${modes[0]}`;
  console.log(
    `SC1 — baseline (${configLabel}): ${overallFail}/${analyzed.length} = ` +
      `${pct(overallFail / analyzed.length)}  (95% CI ${pct(oLo)}–${pct(oHi)})`
  );
  console.log("");

  // An empty stratum prints NO interval (PR #3204 NB1). `wilson(x, 0)` returns [0,0], which
  // renders as "95% CI 0.0%-0.0%" — indistinguishable from a genuinely tight bound, and the
  // more confident-looking of the two readings. No data must not render as certainty.
  const rateLine = (label: string, fails: number, group: Row[]): string => {
    if (group.length === 0) return `${label}: 0/0 — NO DATA in this stratum, no interval`;
    const [lo, hi] = wilson(fails, group.length);
    return (
      `${label}: ${fails}/${group.length} = ${pct(fails / group.length)}  ` +
      `(95% CI ${pct(lo)}–${pct(hi)})`
    );
  };
  console.log(rateLine(`below ${THRESHOLD_CHARS}`, belowFail, below));
  console.log(rateLine(`at/above ${THRESHOLD_CHARS}`, aboveFail, above));

  const p = fisherExactTwoSided(
    aboveFail,
    above.length - aboveFail,
    belowFail,
    below.length - belowFail
  );
  console.log("");
  console.log(`Fisher exact, two-sided: p = ${p.toFixed(4)}`);
  console.log(
    p < 0.05
      ? ">>> REJECT H0 at alpha=0.05. Per SC4 this is ONE run and must be reported as UNREPLICATED."
      : ">>> FAIL TO REJECT H0. Powered for a 10-point difference; this is NOT evidence of no effect."
  );

  // -------------------------------------------------------------------------
  console.log("");
  console.log("=== EXPLORATORY (declared secondary — not confirmatory) ===");

  const fails = analyzed.filter(failed);
  const byField: Record<string, number> = {};
  for (const r of fails) {
    if (r.outcome.kind !== "schema-violation") continue;
    for (const f of r.outcome.paths) byField[f] = (byField[f] ?? 0) + 1;
  }
  console.log(`exploratory — missing-field breakdown: ${JSON.stringify(byField)}`);

  const full = analyzed.filter((r) => r.fullWindow);
  const partial = analyzed.filter((r) => !r.fullWindow);
  console.log(
    `exploratory — full window: ${full.filter(failed).length}/${full.length}   ` +
      `partial: ${partial.filter(failed).length}/${partial.length}`
  );

  const sizes = analyzed.map((r) => r.promptChars).sort((x, y) => x - y);
  const median = sizes[Math.floor(sizes.length / 2)] ?? 0;
  const hi = analyzed.filter((r) => r.promptChars > median);
  const lo = analyzed.filter((r) => r.promptChars <= median);
  console.log(
    `exploratory — median split (${median} chars): above ${hi.filter(failed).length}/${hi.length}, ` +
      `at-or-below ${lo.filter(failed).length}/${lo.length}   ` +
      `[gradient check: if size only sets a FLOOR, this split is flat while the primary is not]`
  );

  const failSizes = fails.map((r) => r.promptChars).sort((x, y) => x - y);
  console.log(
    `exploratory — smallest failing prompt: ${failSizes[0] ?? "n/a"} chars ` +
      `[NOT a threshold — recording it is how mt#4317 produced a spurious p=0.03]`
  );
}

// Guarded: the test file imports the statistics above, and an unguarded call would run the
// CLI (and `exit(2)` on the missing argument) at import time.
if (import.meta.main) main();
