#!/usr/bin/env bun
/**
 * Join exported human labels to the judge panel's verdicts and report Cohen's
 * kappa between the two raters (mt#2746).
 *
 * This is the consuming half of the gold set: `push-braintrust-gold-set.ts`
 * sends blind rows to Braintrust for labeling, a human labels them, the labels
 * are exported and committed beside the corpus, and this script turns the pair
 * into a number that mt#2991 can gate on.
 *
 * ## What is deliberately EXCLUDED from kappa
 *
 * Three populations are held out rather than scored, and each is reported
 * with its count. Silently folding any of them in would produce a kappa that
 * looks like a measurement and is not one:
 *
 * - **`cant_tell` labels.** The human declined to rate. Mapping that onto
 *   VALID or NOISE invents a rating they refused to give. A high `cant_tell`
 *   count is a finding about the corpus, not a kappa input.
 * - **Rows whose judge aggregate includes a FAILED judge call.** `judgeFinding`
 *   returns `verdict: "VALID"` with a `parseError` when a judge errors, and
 *   `"VALID"` is a real verdict — so a dead judge contributes a phantom vote
 *   that is invisible in the aggregate. This is the defect mt#4616 owns; a
 *   measured run had two of three judges failing on all 114 rows while the
 *   summary reported success. Any row carrying a `parseError` is excluded here.
 * - **Rows present on only one side of the join.** An unlabeled row is not a
 *   disagreement, and a label with no judge verdict cannot be paired.
 *
 * ## Export-shape caveat
 *
 * The Braintrust export reader below accepts the shapes a Human Review export
 * is documented to produce, but has NOT been validated against a real export —
 * no labeling pass has run yet. It reports the shape it detected and refuses
 * on an ambiguous one rather than guessing. Confirm against the first real
 * export before trusting the join.
 *
 * @see mt#2746 — this task
 * @see mt#2991 — Milestone B, the regression gate that consumes this number
 * @see mt#4616 — the failed-judge-returns-a-valid-verdict defect
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { cohensKappa, type CohensKappaResult } from "../src/eval-metrics";

// ---------------------------------------------------------------------------
// Label taxonomy
// ---------------------------------------------------------------------------

/** The 4 categorical options configured on the Braintrust human-review score. */
export const HUMAN_LABELS = [
  "valid_blocking",
  "valid_nonblocking",
  "false_positive",
  "cant_tell",
] as const;

export type HumanLabel = (typeof HUMAN_LABELS)[number];

/** The binary axis kappa is computed on. */
export type BinaryRating = "VALID" | "NOISE";

/**
 * Collapse a human label onto the binary axis, or `null` for `cant_tell`.
 *
 * The blocking/non-blocking split is dropped deliberately: the judge taxonomy
 * has no severity axis, so a rater comparison across it would be scoring the
 * human against a distinction the judge was never asked to make.
 */
export function humanLabelToBinary(label: HumanLabel): BinaryRating | null {
  switch (label) {
    case "valid_blocking":
    case "valid_nonblocking":
      return "VALID";
    case "false_positive":
      return "NOISE";
    case "cant_tell":
      return null;
  }
}

/**
 * Collapse a judge verdict onto the binary axis.
 *
 * `BUG_HIT` is a strictly stronger claim than `VALID` (the finding caught a
 * seeded bug), so both are VALID on this axis.
 */
export function judgeVerdictToBinary(verdict: string): BinaryRating | null {
  if (verdict === "BUG_HIT" || verdict === "VALID") return "VALID";
  if (verdict === "NOISE") return "NOISE";
  return null;
}

// ---------------------------------------------------------------------------
// Export reading
// ---------------------------------------------------------------------------

export interface ExportedLabel {
  rowId: string;
  label: HumanLabel;
}

function isHumanLabel(value: unknown): value is HumanLabel {
  return typeof value === "string" && (HUMAN_LABELS as readonly string[]).includes(value);
}

/**
 * Pull `{ rowId, label }` out of one exported Braintrust record.
 *
 * Returns a reason string instead of throwing so the caller can tally why
 * records were skipped — a silent skip here would shrink the denominator
 * without saying so.
 */
export function readExportedRecord(
  record: Record<string, unknown>
): { ok: true; value: ExportedLabel } | { ok: false; reason: string } {
  const input = record.input as Record<string, unknown> | undefined;
  const metadata = record.metadata as Record<string, unknown> | undefined;
  const rowId = [input?.rowId, metadata?.rowId, record.id].find((c) => typeof c === "string") as
    | string
    | undefined;
  if (!rowId) {
    return { ok: false, reason: "no rowId in input.rowId, metadata.rowId, or id" };
  }

  const expected = record.expected;
  if (expected === undefined || expected === null || expected === "") {
    return { ok: false, reason: "unlabeled (no `expected` value)" };
  }
  // A human-review score writing to `expected` yields the option label as a
  // bare string. Some export paths nest it; accept a single obvious nesting
  // and refuse anything else rather than guessing at a shape.
  const candidate =
    typeof expected === "string"
      ? expected
      : ((expected as Record<string, unknown>)?.label ??
        (expected as Record<string, unknown>)?.value);
  if (!isHumanLabel(candidate)) {
    return {
      ok: false,
      reason: `unrecognized label ${JSON.stringify(candidate)} (expected one of ${HUMAN_LABELS.join(", ")})`,
    };
  }
  return { ok: true, value: { rowId, label: candidate } };
}

function parseExportFile(path: string): Record<string, unknown>[] {
  const raw = readFileSync(resolve(path), "utf-8").trim();
  if (!raw) throw new Error(`${path}: file is empty`);
  if (raw.startsWith("[")) return JSON.parse(raw) as Record<string, unknown>[];
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line, i) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new Error(`${path}: line ${i + 1} is not valid JSON`);
      }
    });
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface JudgeVerdictEntry {
  aggregate: string;
  agreement: boolean;
  perJudge: { provider: string; model: string; verdict: string; parseError?: string }[];
}

export interface ScoreResult {
  kappa: CohensKappaResult;
  /** Rows scored on both axes. */
  paired: number;
  /** Held-out populations, each reported rather than silently dropped. */
  excluded: {
    cantTell: number;
    contaminatedJudge: number;
    labelOnly: number;
    judgeOnly: number;
    unreadable: { rowId?: string; reason: string }[];
  };
  /** 2x2 counts, human as rows: [humanVALID/judgeVALID, hV/jN, hN/jV, hN/jN]. */
  confusion: { hvJv: number; hvJn: number; hnJv: number; hnJn: number };
}

export function scoreLabels(
  labels: ExportedLabel[],
  judgeVerdicts: Record<string, JudgeVerdictEntry>,
  unreadable: { rowId?: string; reason: string }[] = []
): ScoreResult {
  const humanRatings: string[] = [];
  const judgeRatings: string[] = [];
  const excluded = {
    cantTell: 0,
    contaminatedJudge: 0,
    labelOnly: 0,
    judgeOnly: 0,
    unreadable,
  };
  const confusion = { hvJv: 0, hvJn: 0, hnJv: 0, hnJn: 0 };

  const labeledIds = new Set(labels.map((l) => l.rowId));
  for (const rowId of Object.keys(judgeVerdicts)) {
    if (!labeledIds.has(rowId)) excluded.judgeOnly++;
  }

  for (const { rowId, label } of labels) {
    const human = humanLabelToBinary(label);
    if (human === null) {
      excluded.cantTell++;
      continue;
    }
    const entry = judgeVerdicts[rowId];
    if (!entry) {
      excluded.labelOnly++;
      continue;
    }
    // mt#4616: a judge that ERRORED still contributed a verdict to this
    // aggregate. Scoring it would compare the human against a phantom.
    if (entry.perJudge.some((j) => j.parseError !== undefined)) {
      excluded.contaminatedJudge++;
      continue;
    }
    const judge = judgeVerdictToBinary(entry.aggregate);
    if (judge === null) {
      excluded.unreadable.push({ rowId, reason: `unrecognized judge verdict ${entry.aggregate}` });
      continue;
    }
    humanRatings.push(human);
    judgeRatings.push(judge);
    if (human === "VALID") judge === "VALID" ? confusion.hvJv++ : confusion.hvJn++;
    else judge === "VALID" ? confusion.hnJv++ : confusion.hnJn++;
  }

  return {
    kappa: cohensKappa(humanRatings, judgeRatings),
    paired: humanRatings.length,
    excluded,
    confusion,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const DEFAULT_ARTIFACT = "services/reviewer/eval/results/disagreement-subset-v1.json";

/**
 * Shape written by `--out` — the calibration snapshot `reviewer-benchmark-gate.ts`
 * (mt#2991) reads to decide the judge's trust mode. A SEPARATE artifact from
 * the console report above: the gate needs a stable, parseable record of
 * "what was the kappa, over how many rows, as of when" that does not depend
 * on scraping stdout.
 */
export interface KappaCalibrationSnapshot {
  computedAt: string;
  kappa: number | null;
  degenerate?: "single-category";
  observedAgreement: number;
  expectedAgreement: number;
  n: number;
  excluded: ScoreResult["excluded"];
  labelsPath: string;
  artifactPath: string;
}

function main(): void {
  const argv = process.argv.slice(2);
  let labelsPath: string | undefined;
  let artifactPath = DEFAULT_ARTIFACT;
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--labels") labelsPath = argv[++i];
    else if (argv[i] === "--artifact") artifactPath = argv[++i] ?? artifactPath;
    else if (argv[i] === "--out") outPath = argv[++i];
  }
  if (!labelsPath) {
    throw new Error(
      "usage: bun services/reviewer/scripts/score-human-labels.ts --labels <export.jsonl> " +
        "[--artifact <judge-pass.json>] [--out <calibration-snapshot.json>]"
    );
  }

  console.log("=== Human-label vs judge kappa (mt#2746) ===");

  const artifact = JSON.parse(readFileSync(resolve(artifactPath), "utf-8")) as {
    judgeVerdicts?: Record<string, JudgeVerdictEntry>;
    panel?: string[];
  };
  if (!artifact.judgeVerdicts) {
    throw new Error(
      `${artifactPath}: no judgeVerdicts map. Artifacts written before mt#2746 dropped the ` +
        `panel's verdicts at write time; re-run the judge pass to produce a joinable artifact.`
    );
  }

  const records = parseExportFile(labelsPath);
  const labels: ExportedLabel[] = [];
  const unreadable: { rowId?: string; reason: string }[] = [];
  for (const record of records) {
    const read = readExportedRecord(record);
    if (read.ok) labels.push(read.value);
    else unreadable.push({ reason: read.reason });
  }

  console.log(`Labels file: ${resolve(labelsPath)} (${records.length} record(s))`);
  console.log(`Artifact:    ${resolve(artifactPath)}`);
  if (artifact.panel) console.log(`Judge panel: ${artifact.panel.join(", ")}`);

  const result = scoreLabels(labels, artifact.judgeVerdicts, unreadable);

  console.log(`\nPaired and scored: ${result.paired}`);
  console.log("Held out:");
  console.log(`  cant_tell (human declined to rate): ${result.excluded.cantTell}`);
  console.log(
    `  judge aggregate contaminated by a failed judge: ${result.excluded.contaminatedJudge}`
  );
  console.log(`  labeled but no judge verdict: ${result.excluded.labelOnly}`);
  console.log(`  judged but not labeled: ${result.excluded.judgeOnly}`);
  console.log(`  unreadable records: ${result.excluded.unreadable.length}`);
  for (const u of result.excluded.unreadable.slice(0, 5)) {
    console.log(`    - ${u.rowId ?? "(no id)"}: ${u.reason}`);
  }

  const c = result.confusion;
  console.log("\nConfusion (human x judge):");
  console.log(`            judge VALID   judge NOISE`);
  console.log(`  human VALID  ${String(c.hvJv).padStart(8)}      ${String(c.hvJn).padStart(8)}`);
  console.log(`  human NOISE  ${String(c.hnJv).padStart(8)}      ${String(c.hnJn).padStart(8)}`);

  const k = result.kappa;
  console.log(`\nObserved agreement: ${k.observedAgreement.toFixed(4)}`);
  console.log(`Chance agreement:   ${k.expectedAgreement.toFixed(4)}`);
  if (k.kappa === null) {
    console.log(`Cohen's kappa:      UNDEFINED (${k.degenerate})`);
    console.log(
      "  Both raters used a single category, so kappa is 0/0. Report the observed " +
        "agreement and the degeneracy — not a kappa."
    );
  } else {
    console.log(`Cohen's kappa:      ${k.kappa.toFixed(4)}  (n=${k.n})`);
  }

  if (result.excluded.contaminatedJudge > 0) {
    console.warn(
      `\nWARNING: ${result.excluded.contaminatedJudge} row(s) were held out because a judge ` +
        `call FAILED and its fallback verdict entered the aggregate (mt#4616). Re-run the ` +
        `judge pass with a healthy panel before treating this kappa as complete.`
    );
  }

  if (outPath) {
    const snapshot: KappaCalibrationSnapshot = {
      computedAt: new Date().toISOString(),
      kappa: k.kappa,
      ...(k.degenerate ? { degenerate: k.degenerate } : {}),
      observedAgreement: k.observedAgreement,
      expectedAgreement: k.expectedAgreement,
      n: k.n,
      excluded: result.excluded,
      labelsPath: resolve(labelsPath),
      artifactPath: resolve(artifactPath),
    };
    writeFileSync(resolve(outPath), `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
    console.log(`\nCalibration snapshot written: ${resolve(outPath)}`);
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
