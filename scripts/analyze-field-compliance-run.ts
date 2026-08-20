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
export function wilson(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.959963985;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - halfWidth), Math.min(1, centre + halfWidth)];
}

function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------

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
  console.log(
    `SC1 — production baseline under \`auto\`: ${overallFail}/${analyzed.length} = ` +
      `${pct(overallFail / analyzed.length)}  (95% CI ${pct(oLo)}–${pct(oHi)})`
  );
  console.log("");

  const [bLo, bHi] = wilson(belowFail, below.length);
  const [aLo, aHi] = wilson(aboveFail, above.length);
  console.log(
    `below ${THRESHOLD_CHARS}: ${belowFail}/${below.length} = ` +
      `${below.length ? pct(belowFail / below.length) : "n/a"}  (95% CI ${pct(bLo)}–${pct(bHi)})`
  );
  console.log(
    `at/above ${THRESHOLD_CHARS}: ${aboveFail}/${above.length} = ` +
      `${above.length ? pct(aboveFail / above.length) : "n/a"}  (95% CI ${pct(aLo)}–${pct(aHi)})`
  );

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
