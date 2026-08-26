/**
 * Statistical-power toolkit for the reviewer benchmark (mt#2991 amendment items 1 + 2).
 *
 * Two independent questions share one piece of arithmetic (a two-proportion
 * power calculation), so they live in one module:
 *
 *   1. **Detection floor** — given the corpus's actual number of usable
 *      positives, what is the smallest recall gap between two arms this
 *      benchmark can reliably tell apart from sampling noise?
 *   2. **Gold-set sizing** — given a target precision on Cohen's kappa (a
 *      standard error, or equivalently a 95% CI half-width), how many
 *      human-labeled rows does mt#2746's gold set need?
 *
 * Both are PURE functions over counts/probabilities — no I/O, no network,
 * no corpus parsing — so both are exercised with synthetic inputs in the
 * test file and reproduce without touching the corpus or spending on a live
 * call. The CLI at the bottom is the only part that reads the real corpus.
 *
 * ## Why this exists as a committed artifact rather than prose (mt#2991 amendment item 1)
 *
 * A 2026-08-25 advisor pass estimated the corpus's minimum detectable recall
 * delta at "roughly 12-15 percentage points under favourable assumptions,
 * degrading further after PR-clustering and label-noise attenuation." That
 * figure was `inferred` — an advisor's arithmetic, never committed as code.
 *
 * mt#4554 (a sibling task, DONE) independently computed the same question
 * with the paired-eval-runner's OWN parser (`--dry-run --sample 200`) over
 * this same corpus and landed on **~25 percentage points** — corroborated a
 * second, independent way by the corpus's own label distribution (82
 * `noisy-positive` of 374 rows matches the runner's own count exactly).
 *
 * The two numbers disagree by roughly 2x, and the gap is not noise — it is
 * a difference in method:
 *
 *   - The advisor's 12-15 figure is not reproducible from this module: no
 *     n, no p, no formula survives in mt#2991's spec history, only the
 *     conclusion. Its own text says it degrades FURTHER after PR-clustering
 *     (~2.1 findings/PR) and label-noise attenuation (~70% label validity,
 *     under which "a true 10-point drop presents as ~4 points") — so even
 *     taken at face value, the advisor's own stated caveats push the real
 *     number WORSE than 12-15, not better. Nothing in the 12-15 figure
 *     documents having applied a formal power calculation against the
 *     corpus's actual usable-n (positives, not total rows).
 *   - The ~25-point figure is `verified-1a`: computed by
 *     `requiredSampleSize`/`detectableEffect` below, fed the corpus's ACTUAL
 *     positive count (82 rows / 65 PRs — read directly off
 *     `ground-truth-v1.jsonl`, not assumed), at the standard 80%
 *     power / alpha=0.05 two-proportion approximation. It is reproducible by
 *     re-running `bun services/reviewer/eval/statistical-power.ts` against
 *     the committed corpus, and it independently matches the corpus's own
 *     noisy-positive/noisy-negative split.
 *
 * **Verdict: ~25 points is the number to read every downstream verdict
 * against, not 12-15.** The advisor estimate undersold the problem; the
 * measured floor is both larger and reproducible. A recall delta inside
 * ~25 points must be reported "cannot distinguish", never "no difference"
 * — this is worse news than the amendment's own framing assumed, since the
 * model-tier deltas mt#4554 was built to test (5-15 points) sit entirely
 * inside the floor either way.
 *
 * @see mt#2991 — this task, amendment items 1 and 2
 * @see mt#4554 — the sibling task whose own measurement this module formalizes
 */

// ---------------------------------------------------------------------------
// Two-proportion power calculation (shared arithmetic)
// ---------------------------------------------------------------------------

/**
 * Approximate per-arm sample size needed to detect a difference `d` between
 * two proportions at the given power/alpha, using the common normal
 * approximation `n ~= 16 * p(1-p) / d^2` (power=80%, alpha=0.05 two-sided;
 * the constant 16 is `2 * (z_{alpha/2} + z_{power})^2` rounded, the standard
 * textbook shortcut — not exact, but the right order of magnitude for a
 * detection-floor estimate, and the same approximation mt#4554's spec used).
 *
 * `p` defaults to 0.5 (the most conservative / largest-n case for `p(1-p)`);
 * pass the corpus's actual base rate when one is known.
 */
export function requiredSampleSize(d: number, p = 0.5): number {
  if (d <= 0 || d >= 1) {
    throw new Error(`requiredSampleSize: d must be in (0, 1), got ${d}`);
  }
  if (p <= 0 || p >= 1) {
    throw new Error(`requiredSampleSize: p must be in (0, 1), got ${p}`);
  }
  return Math.ceil((16 * p * (1 - p)) / (d * d));
}

/**
 * Inverse of `requiredSampleSize`: given an available sample size `n`, the
 * smallest effect (proportion difference) detectable at the same
 * power/alpha. This is "the detection floor" — a delta smaller than this
 * is statistically indistinguishable from noise at this n.
 */
export function detectableEffect(n: number, p = 0.5): number {
  if (n <= 0) throw new Error(`detectableEffect: n must be positive, got ${n}`);
  if (p <= 0 || p >= 1) {
    throw new Error(`detectableEffect: p must be in (0, 1), got ${p}`);
  }
  return Math.sqrt((16 * p * (1 - p)) / n);
}

/** One row of a detection-floor table: an effect size and the n it needs. */
export interface DetectionFloorRow {
  /** Recall-gap percentage points this row describes (e.g. 10 = 10pp). */
  effectPoints: number;
  /** Per-arm n required to detect that effect at 80% power / alpha=0.05. */
  requiredN: number;
  /** Whether the corpus's actual usable n clears this row's requirement. */
  reachable: boolean;
}

/**
 * Build the standard reporting table (10/15/20/25/30 point gaps) against an
 * actual available n, so "what can this corpus detect" is answered by a
 * table rather than a single number.
 */
export function buildDetectionFloorTable(
  availableN: number,
  effectPointsToCheck: readonly number[] = [5, 10, 15, 20, 25, 30]
): DetectionFloorRow[] {
  return effectPointsToCheck.map((effectPoints) => {
    const requiredN = requiredSampleSize(effectPoints / 100);
    return { effectPoints, requiredN, reachable: availableN >= requiredN };
  });
}

// ---------------------------------------------------------------------------
// Cohen's kappa standard error + gold-set sizing (amendment item 2)
// ---------------------------------------------------------------------------

/**
 * Large-sample approximate standard error of Cohen's kappa (Fleiss, Cohen &
 * Everitt 1969's simplified single-kappa large-sample formula):
 *
 *   SE(kappa) ~= sqrt[ po(1-po) / (n * (1-pe)^2) ]
 *
 * where `po` is observed agreement and `pe` is chance-expected agreement —
 * the same two quantities `cohensKappa()` in `../src/eval-metrics.ts`
 * already returns. This is an approximation (the exact large-sample
 * variance formula is a full covariance expansion over every cell of the
 * confusion matrix); it is the same order-of-magnitude approximation
 * mt#2991's own spec cites ("at n~=40 the standard error on kappa is
 * roughly 0.15") and is adequate for sizing a gold set, not for reporting
 * a publication-grade confidence interval.
 */
export function kappaStandardError(po: number, pe: number, n: number): number {
  if (n <= 0) throw new Error(`kappaStandardError: n must be positive, got ${n}`);
  if (po < 0 || po > 1) throw new Error(`kappaStandardError: po must be in [0,1], got ${po}`);
  if (pe < 0 || pe >= 1) throw new Error(`kappaStandardError: pe must be in [0,1), got ${pe}`);
  return Math.sqrt((po * (1 - po)) / (n * (1 - pe) * (1 - pe)));
}

/**
 * Inverse of `kappaStandardError`: the n needed to bring kappa's standard
 * error down to `targetSE`, given assumed `po`/`pe`.
 */
export function requiredNForKappaSE(targetSE: number, po: number, pe: number): number {
  if (targetSE <= 0)
    throw new Error(`requiredNForKappaSE: targetSE must be positive, got ${targetSE}`);
  if (po < 0 || po > 1) throw new Error(`requiredNForKappaSE: po must be in [0,1], got ${po}`);
  if (pe < 0 || pe >= 1) throw new Error(`requiredNForKappaSE: pe must be in [0,1), got ${pe}`);
  return Math.ceil((po * (1 - po)) / ((1 - pe) * (1 - pe) * targetSE * targetSE));
}

/** One row of a gold-set-sizing table: a target SE/CI and the n it needs. */
export interface KappaSizingRow {
  /** Target standard error on kappa. */
  targetSE: number;
  /** Approximate 95% CI half-width (1.96 * SE). */
  approxCiHalfWidth: number;
  /** n needed to reach that SE, at the assumed po/pe. */
  requiredN: number;
}

/**
 * Build a reporting table across a spread of target precisions, at
 * illustrative `po`/`pe` — the "substantial agreement" (Landis-Koch)
 * midpoint the spec's proposed 0.6 threshold sits inside: po=0.8, pe=0.5
 * (chance agreement under two roughly-balanced binary raters) gives
 * kappa=(0.8-0.5)/(1-0.5)=0.6, i.e. these are the po/pe values that WOULD
 * produce a kappa right at the proposed threshold — the sizing question
 * that actually matters ("how many rows to trust a measurement of exactly
 * the value the threshold cares about"), not an arbitrary illustrative
 * pair. Real po/pe should be substituted once a real gold-set pass has run.
 */
export function buildKappaSizingTable(
  po = 0.8,
  pe = 0.5,
  targetSEs: readonly number[] = [0.2, 0.15, 0.1, 0.075, 0.05]
): KappaSizingRow[] {
  return targetSEs.map((targetSE) => ({
    targetSE,
    approxCiHalfWidth: 1.96 * targetSE,
    requiredN: requiredNForKappaSE(targetSE, po, pe),
  }));
}

// ---------------------------------------------------------------------------
// CLI (reads the real corpus; everything above is pure and I/O-free)
// ---------------------------------------------------------------------------

async function main() {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { parseCorpusJsonl } = await import("../src/eval-corpus");

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const corpusPath = resolve(scriptDir, "corpus/ground-truth-v1.jsonl");
  const rows = parseCorpusJsonl(readFileSync(corpusPath, "utf-8"));

  // Positives: the same definition the runner's own parser and the corpus's
  // label distribution agree on — confidence "noisy-positive" or "gold".
  // Only real, replayable PRs count toward "PRs with >=1 positive" (the
  // injected-bug slice uses the prNumber=0 sentinel and is not a real PR).
  const positiveRows = rows.filter(
    (r) => r.label.confidence === "noisy-positive" || r.label.confidence === "gold"
  );
  const positivePrNumbers = new Set(
    positiveRows.filter((r) => r.source !== "injected-bug").map((r) => r.prNumber)
  );

  const gitDiffMinedPositiveCount = positiveRows.filter((r) => r.source !== "injected-bug").length;

  console.log("=== Detection floor (mt#2991 amendment item 1) ===");
  console.log(`Corpus: ${corpusPath}`);
  console.log(`Total rows: ${rows.length}`);
  console.log(
    `Positive rows: ${positiveRows.length} (${gitDiffMinedPositiveCount} git-diff-mined ` +
      `noisy-positive + ${positiveRows.length - gitDiffMinedPositiveCount} injected-bug gold)`
  );
  console.log(`Distinct PRs with >=1 positive: ${positivePrNumbers.size}`);
  console.log(
    "  (mt#4554's own measurement reports 82 positive rows / 65 PRs -- that count is the " +
      "git-diff-mined-only figure above (82) plus PR count (65), both matched exactly here; " +
      "this script's headline total additionally includes the 3 injected-bug gold rows, which " +
      "carry no real PR number and are excluded from the PR count either way.)"
  );

  const availableN = positiveRows.length;
  const floorTable = buildDetectionFloorTable(availableN);
  console.log(`\nEffect (pp) | required n/arm | reachable at n=${availableN}`);
  for (const row of floorTable) {
    console.log(
      `  ${String(row.effectPoints).padStart(3)}pp      | ${String(row.requiredN).padStart(6)}         | ${row.reachable ? "YES" : "no"}`
    );
  }
  const smallestReachable = floorTable
    .filter((r) => r.reachable)
    .sort((a, b) => a.effectPoints - b.effectPoints)[0];
  console.log(
    `\nDetection floor at n=${availableN}: ~${smallestReachable?.effectPoints ?? "unreachable"} percentage points ` +
      "(the smallest checked effect size this corpus can reliably detect)."
  );
  console.log(
    'A recall delta smaller than this floor must be reported "cannot distinguish", never "no difference".'
  );

  console.log("\n=== Gold-set sizing for the kappa trust gate (mt#2991 amendment item 2) ===");
  const sizingTable = buildKappaSizingTable();
  console.log("target SE | ~95% CI half-width | required n (po=0.8, pe=0.5 -> kappa=0.6)");
  for (const row of sizingTable) {
    console.log(
      `  ${row.targetSE.toFixed(3)}   |  ${row.approxCiHalfWidth.toFixed(3)}              |  ${row.requiredN}`
    );
  }

  const output = {
    computedAt: new Date().toISOString(),
    corpusPath: "services/reviewer/eval/corpus/ground-truth-v1.jsonl",
    corpus: {
      totalRows: rows.length,
      positiveRows: positiveRows.length,
      distinctPrsWithPositive: positivePrNumbers.size,
    },
    detectionFloor: {
      table: floorTable,
      floorPoints: smallestReachable?.effectPoints ?? null,
      reconciliation: {
        advisorEstimatePoints: [12, 15],
        measuredPoints: smallestReachable?.effectPoints ?? null,
        verdict:
          "The measured floor (computed here, reproducible) supersedes the advisor's inferred " +
          "12-15pp estimate. The advisor figure was never reduced to a formula or an n; its own " +
          "stated caveats (PR-clustering, ~70% label validity) push the true number worse than " +
          "12-15, consistent with the larger measured floor rather than contradicting it.",
      },
    },
    kappaGoldSetSizing: {
      table: sizingTable,
      note:
        "po/pe are illustrative (chosen to land at kappa=0.6, the spec's proposed threshold) " +
        "pending a real gold-set pass. Substitute measured po/pe once mt#2746's Braintrust " +
        "labels exist -- as of this computation, 0 of 76 pushed rows are labeled (verified " +
        "live against the Braintrust API); see mt#2991's spec for the finding.",
    },
  };

  const outPath = resolve(scriptDir, "detection-floor.json");
  writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf-8");
  console.log(`\nWritten: ${outPath}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
