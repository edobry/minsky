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
 * ## The second pre-registration this file carries (mt#4370, §Amended SC1/SC2)
 *
 * A window-size dataset — rows carrying a recorded `truncateChars` at two or more values —
 * selects `doseResponseAnalysis` instead, which measures a TRADE rather than a rate: the dose
 * spent, the coverage it buys, and the compliance it purchases, printed together. Its
 * constants (`CONTROL_TRUNCATE_CHARS`, both MDEs) are fixed here for the same reason
 * `THRESHOLD_CHARS` is, and the routing is on the KEY'S PRESENCE so every mt#4365 dataset
 * still reaches the paths above byte-for-byte.
 *
 * Usage:
 *   bun scripts/analyze-field-compliance-run.ts .tmp/prereg-run.jsonl
 *   bun scripts/analyze-field-compliance-run.ts .tmp/mt4370-window.jsonl
 */

import { readFileSync } from "node:fs";

/** Fixed by the mt#4365 pre-registration. Do not tune to a run. */
const THRESHOLD_CHARS = 10_000;

/**
 * mt#4370's control dose: production's `MESSAGE_TRUNCATE_CHARS`. Fixed in advance.
 *
 * Named as a constant rather than derived as "the largest dose present" so a dataset that
 * simply forgot to run the control cannot be silently re-based onto its own gentlest arm.
 * A ratio against a substitute denominator is a different quantity wearing the same name.
 */
const CONTROL_TRUNCATE_CHARS = 400;

/**
 * mt#4370 pre-registered coverage MDE, in findings per accepted run. FIXED IN ADVANCE.
 *
 * Sized against the CURRENT regime, NOT the pooled history: of the 597 stored analyzer
 * records, the 527 predating the mt#4196/mt#4235 fixes could not produce a finding at all,
 * and pooling across that boundary gives 0.03 findings/run — a rate at which the metric looks
 * hopeless and the only outcome measure the trade has would get dropped. Measured over the 70
 * records since 2026-08-19: **0.214 findings/run, sd 0.797, 5/70 finding-bearing.**
 *
 * The number: n = 250 transcripts is expected to yield ~115 tuples accepted at every dose
 * (0.68 x 0.80 x 0.85, from mt#4365's corrected 32% control rejection rate and the treatments
 * doing better). At 80% power, two-sided alpha = 0.05, and assuming NO paired correlation —
 * sd(difference) = 0.797 x sqrt(2) — that is 2.80 x 1.127 / sqrt(115) = 0.29.
 *
 * **This is stated as a limit, not as a design target (SC2).** 0.29 is 135% of the base rate
 * itself: this run can bound a coverage loss large enough to erase the detector's entire
 * output, and cannot resolve a moderate one. Halving coverage — 0.107, the effect that would
 * actually decide the trade — needs ~870 tuples, i.e. ~1,900 transcripts x 3 arms ~ 5,600
 * live calls. That is a property of how rarely this detector finds anything, not of the
 * design, and it is recorded here BEFORE the run so the coverage arm's weakness cannot be
 * discovered afterward and framed as a null. The realized CI is computed from the data and
 * will be better than this if the arms turn out correlated, which they may well be.
 */
const COVERAGE_MDE_FINDINGS_PER_RUN = 0.29;

/**
 * mt#4370 pre-registered compliance MDE, in percentage points of paired difference.
 *
 * At n = 250 complete tuples with an expected discordance around 30% (control rejecting ~32%
 * against treatments that should reject materially less), SE ~ sqrt(0.30/250) = 0.035, so
 * 80% power at two-sided alpha = 0.05 reaches 2.80 x 3.5 = ~10 points. Unlike the coverage
 * arm, this side is properly powered for the effect at stake: mt#4365's size/rejection
 * gradient predicts a difference well above 10 points at T=150.
 */
const COMPLIANCE_MDE_POINTS = 10;

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
  /**
   * The per-message truncation actually used to render this row's prompt (mt#4370).
   *
   * OPTIONAL for the same reason `mode` is: datasets gathered before the field existed lack
   * the key entirely, and the analysis must route on its PRESENCE rather than assume the
   * control's value for them. A missing key is what selects the mt#4365 paths below.
   */
  truncateChars?: number;
  /** Transcript characters delivered, excluding the prompt's fixed scaffolding (mt#4370). */
  transcriptChars?: number;
  outcome:
    | { kind: "ok"; findingCount: number; summaryChars: number; findingLabels?: string[] }
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

/**
 * Percentile bootstrap CI for the MEAN of a set of paired differences (mt#4370).
 *
 * The coverage outcome is findings per accepted run — a small count, not a proportion, so
 * neither Wilson nor Newcombe applies. A normal-theory interval on the mean would, at a base
 * rate near 0.29 with most runs at exactly zero, be an interval on a distribution that is
 * mostly a point mass: the sample mean is fine but its sampling distribution is far from
 * normal at the n a live run can afford. Resampling the PAIRED DIFFERENCES keeps the pairing
 * (a transcript is one draw, carrying both arms' counts) and assumes nothing about shape.
 *
 * **Seeded on purpose.** This script's whole claim is that the analysis is fixed before the
 * data exists; an interval that moved between two runs on the same file would retire that
 * claim. The generator is a plain LCG so the seed fully determines the output, and the seed
 * is a parameter rather than a global so a test can pin a known answer.
 */
export function pairedBootstrapMeanDifferenceCI(
  differences: readonly number[],
  seed = 20260821,
  iterations = 10_000
): [number, number] {
  const n = differences.length;
  if (n === 0) return [0, 0];
  // Numerical Recipes' LCG constants. Any full-period generator does here — the requirement
  // is reproducibility, not cryptographic or spectral quality.
  let state = seed >>> 0;
  const nextIndex = (): number => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    // HIGH bits, not `state % n`. The low bits of a power-of-two-modulus LCG have very short
    // periods — bit k cycles with period 2^(k+1) — so `% n` inherits that whenever n shares a
    // factor with a power of two. Caught by the narrows-as-n-grows test: at n=20, `% 20`
    // carried a period-4 component that lined up with the fixture's own period-4 pattern and
    // produced resample means far too alike, i.e. an interval that was tight because the
    // generator was degenerate rather than because the data were.
    return Math.floor((state / 0x1_0000_0000) * n);
  };
  const means: number[] = [];
  for (let b = 0; b < iterations; b++) {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += differences[nextIndex()] ?? 0;
    means.push(acc / n);
  }
  means.sort((a, b) => a - b);
  const at = (q: number): number =>
    means[Math.max(0, Math.min(means.length - 1, Math.floor(q * (means.length - 1))))] ?? 0;
  return [at(0.025), at(0.975)];
}

/**
 * Holm–Bonferroni step-down adjustment, returned in the input's order.
 *
 * mt#4370 runs TWO pre-registered compliance comparisons against one control (T=200 and
 * T=150), and reporting the smaller of two p-values at a nominal 0.05 is exactly the
 * garden-of-forking-paths move mt#4317 already made once by another route. Holm rather than
 * plain Bonferroni because it is uniformly more powerful at no extra assumption, and the
 * monotonicity enforcement matters: without it an adjusted p can come out below one that was
 * smaller before adjustment.
 */
export function holmAdjust(pValues: readonly number[]): number[] {
  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const m = indexed.length;
  const out = new Array<number>(m).fill(0);
  let running = 0;
  for (let k = 0; k < m; k++) {
    const entry = indexed[k];
    if (!entry) continue;
    running = Math.max(running, Math.min(1, entry.p * (m - k)));
    out[entry.i] = running;
  }
  return out;
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

/**
 * mt#4370 — the PRE-REGISTERED dose-response analysis of a window-size run.
 *
 * ## Why this prints one table before it prints any test
 *
 * The task's SC4 says the result must be reported as a TRADE, and that "a write-up that leads
 * with the rejection-rate drop and mentions coverage second has already made the decision it
 * is supposed to surface". That is a constraint on this function's OUTPUT, not only on the
 * prose someone writes afterwards — so the first thing printed is a row per dose carrying the
 * price and the purchase side by side, and the significance tests come after it. A reader who
 * stops at the first table still sees both halves.
 *
 * ## The three quantities, and which of them is an outcome
 *
 * - **Dose** (delivered characters, as a fraction of the control) is CERTAIN and local — no
 *   model call decides it. It is the x-axis, not a result. It exists because the metrics the
 *   original spec named (`emptyTextRatio`, `analyzedMessages`) are invariant under this lever
 *   by construction, so scoring the trade with them would have reported "coverage unchanged"
 *   no matter what the truncation did — and SC5 reads "unchanged" as reclassifying the trade
 *   into a pure win. A dose that is guaranteed non-zero closes that path.
 * - **Coverage** (findings per accepted run) is the OUTCOME the dose is spent on, and it is
 *   the underpowered one. Reported as a paired difference with a bootstrap CI, and compared
 *   against a pre-registered MDE, so "no difference" and "no power" print differently.
 * - **Compliance** (schema-violation rate) is what the dose BUYS, and mt#4365 already
 *   established the mechanism it works through.
 */
function doseResponseAnalysis(rows: Row[], callErrorCount: number): void {
  // Descending, so the control (the largest, least-truncated dose) reads first everywhere.
  // Rows WITHOUT the key are dropped, not defaulted (PR #3225 R2). `?? CONTROL_TRUNCATE_CHARS`
  // manufactures a dose for a row that records none, and a fabricated control row is worse
  // than a missing one: it lands in the control arm's denominator and shifts the very ratio
  // this analysis exists to report, with nothing to notice. This is the projection hazard
  // `claim-confidence.mdc` names — an accessor over a missing key is a CONSTRUCTOR, not a
  // filter — and the routing in `main` already tested PRESENCE (`"truncateChars" in r`) for
  // exactly this reason. The two disagreed; they now agree.
  const dosed = rows.filter((r) => typeof r.truncateChars === "number");
  const undosed = rows.length - dosed.length;
  if (undosed > 0) {
    console.log(
      `NOTE: ${undosed} of ${rows.length} rows carry no truncateChars and are EXCLUDED — ` +
        `a mixed dataset predating the field cannot be scored on a dose it never recorded.`
    );
  }
  const doses = [...new Set(dosed.map((r) => r.truncateChars as number))].sort((a, b) => b - a);
  if (!doses.includes(CONTROL_TRUNCATE_CHARS)) {
    console.error(
      `Dose-response analysis requires the pre-registered control dose ` +
        `(${CONTROL_TRUNCATE_CHARS} chars, production's value); this dataset has only ` +
        `${doses.join(", ")}. Re-run including the control — this script will not re-base the ` +
        `dosage onto whichever arm happens to be largest.`
    );
    process.exit(2);
  }

  const byConversation = new Map<string, Map<number, Row>>();
  for (const r of dosed) {
    const dose = r.truncateChars as number;
    if (!byConversation.has(r.conversationId)) byConversation.set(r.conversationId, new Map());
    byConversation.get(r.conversationId)?.set(dose, r);
  }
  // Only transcripts every dose answered can form a tuple, for the same reason mt#4365 drops
  // a half-answered pair: a transcript one dose failed to reach is not evidence about it.
  const tuples = [...byConversation.values()].filter((m) => doses.every((d) => m.has(d)));
  const incomplete = byConversation.size - tuples.length;

  const failed = (r: Row | undefined): boolean => r?.outcome.kind === "schema-violation";
  const findingsOf = (r: Row | undefined): number =>
    r?.outcome.kind === "ok" ? r.outcome.findingCount : 0;
  const accepted = (r: Row | undefined): boolean => r?.outcome.kind === "ok";

  console.log("=== mt#4370 — PRE-REGISTERED WINDOW-SIZE TRADE ===");
  console.log(
    `doses (MESSAGE_TRUNCATE_CHARS): ${doses.join(", ")}   control: ${CONTROL_TRUNCATE_CHARS}`
  );
  console.log(`complete tuples: ${tuples.length}   incomplete (dropped): ${incomplete}`);
  console.log(`call errors excluded: ${callErrorCount}`);
  console.log("");

  // -------------------------------------------------------------------------
  // The trade table — both halves, side by side, before any test.
  // -------------------------------------------------------------------------
  const controlTranscriptChars = tuples.reduce(
    (acc, m) => acc + (m.get(CONTROL_TRUNCATE_CHARS)?.transcriptChars ?? 0),
    0
  );
  const controlPromptChars = tuples.reduce(
    (acc, m) => acc + (m.get(CONTROL_TRUNCATE_CHARS)?.promptChars ?? 0),
    0
  );
  // Every dose must be scored on the SAME transcripts, so the fully-accepted subset is taken
  // across all doses at once rather than per dose. A per-dose "accepted" subset would let a
  // dose that rejects the hard transcripts look like it finds more in the easy ones — the
  // coverage metric would then be reading the compliance result back to itself.
  const fullyAccepted = tuples.filter((m) => doses.every((d) => accepted(m.get(d))));

  console.log("--- THE TRADE (dose spent / coverage delivered / compliance bought) ---");
  console.log(
    `${"dose".padEnd(6)} ${"transcript".padEnd(11)} ${"prompt".padEnd(8)} ` +
      `${"findings/run".padEnd(13)} ${"finding-bearing".padEnd(16)} rejection`
  );
  for (const dose of doses) {
    const at = tuples.map((m) => m.get(dose));
    const transcriptDosage =
      controlTranscriptChars === 0
        ? null
        : at.reduce((acc, r) => acc + (r?.transcriptChars ?? 0), 0) / controlTranscriptChars;
    const promptDosage =
      controlPromptChars === 0
        ? null
        : at.reduce((acc, r) => acc + (r?.promptChars ?? 0), 0) / controlPromptChars;
    const rejected = at.filter(failed).length;
    const [rLo, rHi] = wilson(rejected, at.length);
    const fa = fullyAccepted.map((m) => m.get(dose));
    const findings = fa.reduce((acc, r) => acc + findingsOf(r), 0);
    const bearing = fa.filter((r) => findingsOf(r) > 0).length;
    console.log(
      `${String(dose).padEnd(6)} ` +
        `${(transcriptDosage === null ? "n/a" : pct(transcriptDosage)).padEnd(11)} ` +
        `${(promptDosage === null ? "n/a" : pct(promptDosage)).padEnd(8)} ` +
        `${(fa.length === 0 ? "n/a" : (findings / fa.length).toFixed(3)).padEnd(13)} ` +
        `${`${bearing}/${fa.length}`.padEnd(16)} ` +
        `${rejected}/${at.length} = ${pct(at.length === 0 ? 0 : rejected / at.length)} ` +
        `(95% CI ${pct(rLo)}–${pct(rHi)})`
    );
  }
  console.log("");
  console.log(
    `transcript/prompt dosage are the SAME characters counted with and without the prompt's ` +
      `fixed scaffolding — the prompt figure has a floor the transcript figure does not.`
  );
  console.log(
    `coverage columns are scored on the ${fullyAccepted.length} tuples EVERY dose accepted, ` +
      `so a dose cannot look richer by having rejected the hard transcripts.`
  );

  const treatments = doses.filter((d) => d !== CONTROL_TRUNCATE_CHARS);

  // -------------------------------------------------------------------------
  // Coverage — the price. Printed BEFORE compliance, deliberately (SC4).
  // -------------------------------------------------------------------------
  console.log("");
  console.log("--- COVERAGE: what the dose SPENDS (paired, pre-registered outcome) ---");
  if (fullyAccepted.length === 0) {
    console.log("NO tuple was accepted at every dose — the coverage arm has no data at all.");
  }
  for (const dose of treatments) {
    const differences = fullyAccepted.map(
      (m) => findingsOf(m.get(dose)) - findingsOf(m.get(CONTROL_TRUNCATE_CHARS))
    );
    const mean =
      differences.length === 0 ? 0 : differences.reduce((a, b) => a + b, 0) / differences.length;
    const [lo, hi] = pairedBootstrapMeanDifferenceCI(differences);
    console.log(
      `T=${dose} − T=${CONTROL_TRUNCATE_CHARS}: ${mean >= 0 ? "+" : ""}${mean.toFixed(3)} ` +
        `findings/accepted run  (95% bootstrap CI ${lo.toFixed(3)} to ${hi.toFixed(3)}; ` +
        `n=${differences.length})`
    );
    // The same verdict rule mt#4365 used for its bounded null, applied to a count: a CI that
    // excludes the pre-registered MDE licenses "an effect this size is ruled out"; one that
    // admits it means the run could not have seen the effect it was designed for, and saying
    // "no difference" there would be reporting absence of power as absence of effect.
    const excludesMde = Math.max(Math.abs(lo), Math.abs(hi)) < COVERAGE_MDE_FINDINGS_PER_RUN;
    console.log(
      excludesMde
        ? `  >>> BOUNDED: the CI excludes the pre-registered ${COVERAGE_MDE_FINDINGS_PER_RUN} ` +
            `findings/run MDE. A coverage loss that size is ruled out; a smaller one is not.`
        : `  >>> UNDERPOWERED for the pre-registered ${COVERAGE_MDE_FINDINGS_PER_RUN} ` +
            `findings/run MDE — this is NOT evidence that coverage is unaffected.`
    );

    // Secondary, binary: does the dose change WHETHER a run finds anything, as distinct from
    // how much? At a base rate near 0.29 findings/run these two can move independently.
    let bothBear = 0;
    let onlyControlBears = 0;
    let onlyTreatmentBears = 0;
    let neitherBears = 0;
    for (const m of fullyAccepted) {
      const c = findingsOf(m.get(CONTROL_TRUNCATE_CHARS)) > 0;
      const t = findingsOf(m.get(dose)) > 0;
      if (c && t) bothBear++;
      else if (c) onlyControlBears++;
      else if (t) onlyTreatmentBears++;
      else neitherBears++;
    }
    const pBearing = mcnemarExactTwoSided(onlyControlBears, onlyTreatmentBears);
    const [bLo, bHi] = newcombePairedDifferenceCI(
      bothBear,
      onlyControlBears,
      onlyTreatmentBears,
      neitherBears
    );
    console.log(
      `  finding-bearing rate, control − T=${dose}: discordant ${onlyControlBears} vs ` +
        `${onlyTreatmentBears}, McNemar exact p = ${pBearing.toFixed(4)} ` +
        `(95% CI ${(100 * bLo).toFixed(1)} to ${(100 * bHi).toFixed(1)} points) [secondary]`
    );
  }

  // -------------------------------------------------------------------------
  // Compliance — the purchase.
  // -------------------------------------------------------------------------
  console.log("");
  console.log("--- COMPLIANCE: what the dose BUYS (paired, Holm-corrected across doses) ---");
  const complianceCells = treatments.map((dose) => {
    let bothFail = 0;
    let onlyControlFails = 0;
    let onlyTreatmentFails = 0;
    let bothOk = 0;
    for (const m of tuples) {
      const c = failed(m.get(CONTROL_TRUNCATE_CHARS));
      const t = failed(m.get(dose));
      if (c && t) bothFail++;
      else if (c) onlyControlFails++;
      else if (t) onlyTreatmentFails++;
      else bothOk++;
    }
    return { dose, bothFail, onlyControlFails, onlyTreatmentFails, bothOk };
  });
  const rawP = complianceCells.map((c) =>
    mcnemarExactTwoSided(c.onlyControlFails, c.onlyTreatmentFails)
  );
  const adjP = holmAdjust(rawP);
  complianceCells.forEach((c, i) => {
    const [lo, hi] = newcombePairedDifferenceCI(
      c.bothFail,
      c.onlyControlFails,
      c.onlyTreatmentFails,
      c.bothOk
    );
    const diff =
      tuples.length === 0 ? 0 : (c.onlyControlFails - c.onlyTreatmentFails) / tuples.length;
    console.log(
      `control − T=${c.dose}: ${(100 * diff).toFixed(1)} points ` +
        `(95% CI ${(100 * lo).toFixed(1)} to ${(100 * hi).toFixed(1)})  ` +
        `discordant ${c.onlyControlFails} vs ${c.onlyTreatmentFails}  ` +
        `McNemar p = ${(rawP[i] ?? 1).toFixed(5)}, Holm-adjusted p = ${(adjP[i] ?? 1).toFixed(5)}`
    );
    const adjusted = adjP[i] ?? 1;
    if (adjusted < 0.05) {
      console.log(
        `  >>> REJECT H0 after correction. T=${c.dose} rejects ` +
          `${c.onlyControlFails > c.onlyTreatmentFails ? "LESS" : "MORE"} often than control.`
      );
    } else {
      const excludesMde = Math.max(Math.abs(lo), Math.abs(hi)) * 100 < COMPLIANCE_MDE_POINTS;
      console.log(
        excludesMde
          ? `  >>> FAIL TO REJECT — and the CI excludes the ${COMPLIANCE_MDE_POINTS}-point MDE. Bounded null.`
          : `  >>> FAIL TO REJECT — the CI still admits the ${COMPLIANCE_MDE_POINTS}-point MDE. UNDERPOWERED.`
      );
    }
  });

  // -------------------------------------------------------------------------
  console.log("");
  console.log("=== EXPLORATORY (declared secondary — not confirmatory) ===");
  for (const dose of treatments) {
    let shared = 0;
    let controlOnly = 0;
    let treatmentOnly = 0;
    for (const m of fullyAccepted) {
      const c = new Set(labelsOf(m.get(CONTROL_TRUNCATE_CHARS)));
      const t = new Set(labelsOf(m.get(dose)));
      for (const l of c) t.has(l) ? shared++ : controlOnly++;
      for (const l of t) if (!c.has(l)) treatmentOnly++;
    }
    console.log(
      `exploratory — finding-label overlap, control vs T=${dose}: ${shared} shared, ` +
        `${controlOnly} control-only, ${treatmentOnly} T=${dose}-only  ` +
        `[a FLOOR on agreement, not an estimate: labels are free text, so the same finding ` +
        `phrased differently counts as two]`
    );
  }
  for (const dose of doses) {
    const byField: Record<string, number> = {};
    for (const m of tuples) {
      const r = m.get(dose);
      if (r?.outcome.kind !== "schema-violation") continue;
      for (const f of r.outcome.paths) byField[f] = (byField[f] ?? 0) + 1;
    }
    console.log(`exploratory — T=${dose} missing-field breakdown: ${JSON.stringify(byField)}`);
  }
  for (const dose of doses) {
    const sizes = tuples.map((m) => m.get(dose)?.promptChars ?? 0);
    const below = sizes.filter((s) => s < THRESHOLD_CHARS).length;
    console.log(
      `exploratory — T=${dose}: ${below}/${sizes.length} prompts below the mt#4365 ` +
        `${THRESHOLD_CHARS}-char threshold  [the mechanism the compliance result runs through]`
    );
  }

  console.log("");
  console.log(
    "NOTE (mt#4370 SC5): this is a MEASUREMENT. No lever is pulled on this task's authority — " +
      "the dose, the coverage price and the compliance purchase go to the principal together."
  );
}

/** Finding labels for a row, empty when the row was rejected or predates the field. */
function labelsOf(r: Row | undefined): string[] {
  return r?.outcome.kind === "ok" ? (r.outcome.findingLabels ?? []) : [];
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

  // Routed on the DOSE dimension before the arm count, and on PRESENCE of `truncateChars`
  // rather than on its value (the `mode` lesson: an absent key means the dataset predates the
  // field, which is a different fact from a recorded control value). Two distinct recorded
  // doses is the only thing that selects mt#4370's path; every mt#4365 dataset lacks the key
  // entirely and reaches the arm-count routing below unchanged.
  const doses = [
    ...new Set(analyzed.filter((r) => "truncateChars" in r).map((r) => r.truncateChars)),
  ];
  if (doses.length > 1) {
    doseResponseAnalysis(analyzed, callErrors.length);
    return;
  }

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
