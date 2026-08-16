#!/usr/bin/env bun
/**
 * mt#4126 — measure `causal-premise`'s false-negative rate against ADR-024 §(b).
 *
 * Reads mt#3743's evaluation stream (one record per EVALUATED turn, fired or
 * not) and produces the denominator, the strata, and — when a labels file is
 * supplied — the false-negative rate itself.
 *
 * Three exclusions, each for a different reason:
 *
 *  - **Canary rows** are synthetic inputs chosen to make the guard fire, so
 *    they belong in neither numerator nor denominator. Excluded via
 *    `isCanaryRecord()` (mt#4127), NOT a substring search for "canary".
 *  - **Empty-text rows** are turns `detectCausalPremise` returned on at its
 *    `if (!assistantText)` guard — the patterns never ran, so the turn is one
 *    the detector never evaluated rather than one it declined to fire on.
 *  - **Rows outside the window** — `--until` pins the upper bound so a rerun
 *    reproduces the reported counts even though the live stream keeps growing
 *    (the file accrues a record per turn, including the turns that measure it).
 *
 * The surviving records are stratified by `hadSameTurnVerification`, because
 * `matchedPhrases: []` means two different things across the strata and a
 * single blended rate hides which mechanism actually missed:
 *
 *  - `hadSameTurnVerification: true`  -> `detectCausalPremise` short-circuits
 *    BEFORE any pattern loop, so the patterns were never tested. A miss here is
 *    attributable to the SUPPRESSION rule.
 *  - `hadSameTurnVerification: false` -> the patterns ran and declined. A miss
 *    here is attributable to the PATTERN CORPUS.
 *
 * Usage:
 *   bun scripts/measure-causal-premise-fn-rate.ts --until 2026-08-16T21:16:15.197Z
 *   bun scripts/measure-causal-premise-fn-rate.ts --until <iso> --dump > records.txt
 *   bun scripts/measure-causal-premise-fn-rate.ts --until <iso> --labels labels.json
 *
 * @see mt#4126 — this task
 * @see mt#3743 — the evaluation stream this consumes
 * @see docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md
 */

import { readFileSync, existsSync } from "node:fs";
import { isCanaryRecord } from "../.minsky/hooks/canary-runner";

const DEFAULT_LOG = ".minsky/causal-premise-evaluations.jsonl";

/** How a hand-classified record was judged. See `--labels`. */
export type Label =
  /** The turn volunteers no causal/mechanism claim. Correctly did not fire. */
  | "no-claim"
  /** The turn volunteers a causal claim AND its own text carries the backing. */
  | "claim-backed"
  /** The turn volunteers a causal claim with no backing for it. FALSE NEGATIVE. */
  | "claim-unbacked"
  /** The excerpt alone cannot settle it (e.g. truncated mid-claim). */
  | "indeterminate";

export const FALSE_NEGATIVE_LABEL: Label = "claim-unbacked";

export interface EvaluationRecord {
  timestamp: string;
  session_id: string;
  fired: boolean;
  matchedPhrases: string[];
  hadSameTurnVerification: boolean;
  captureSchema: number;
  judgedInput: { excerpt: string; hash: string; length: number; truncated: boolean };
}

export interface StratumCounts {
  total: number;
  truncated: number;
  labeled: number;
  falseNegatives: number;
  indeterminate: number;
}

/**
 * The same assistant text can be evaluated more than once — a resumed
 * conversation re-runs the hook over a turn it already judged, and the record
 * carries the same `judgedInput.hash` both times.
 *
 * Counted per RECORD, a repeated text votes twice; counted per DISTINCT TEXT,
 * a turn that really did recur in the traffic votes once. Neither is wrong, so
 * both are reported rather than one being picked silently — a verdict that
 * flips between them is a verdict resting on the choice.
 */
export interface DistinctCounts {
  texts: number;
  resolved: number;
  falseNegatives: number;
  rate?: number;
}

export interface Measurement {
  window: { since?: string; until?: string; firstTimestamp?: string; lastTimestamp?: string };
  raw: number;
  canaryExcluded: number;
  outsideWindowExcluded: number;
  emptyTextExcluded: number;
  denominator: number;
  fired: number;
  fieldCoverage: { recordsWithAllFields: number; captureSchemas: number[] };
  strata: { suppressed: StratumCounts; patternTested: StratumCounts };
  rate: { overall?: number; suppressed?: number; patternTested?: number };
  distinct: DistinctCounts;
}

/** Parse a JSONL evaluation stream, skipping blank lines. */
export function parseStream(text: string): EvaluationRecord[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EvaluationRecord);
}

const REQUIRED_FIELDS = [
  "timestamp",
  "session_id",
  "fired",
  "matchedPhrases",
  "hadSameTurnVerification",
  "captureSchema",
  "judgedInput",
] as const;

function hasAllFields(record: EvaluationRecord): boolean {
  return REQUIRED_FIELDS.every((field) => field in record);
}

function inWindow(record: EvaluationRecord, since?: string, until?: string): boolean {
  if (since && record.timestamp < since) return false;
  if (until && record.timestamp > until) return false;
  return true;
}

function emptyStratum(): StratumCounts {
  return { total: 0, truncated: 0, labeled: 0, falseNegatives: 0, indeterminate: 0 };
}

function tally(stratum: StratumCounts, record: EvaluationRecord, label: Label | undefined): void {
  stratum.total += 1;
  if (record.judgedInput.truncated) stratum.truncated += 1;
  if (!label) return;
  stratum.labeled += 1;
  if (label === FALSE_NEGATIVE_LABEL) stratum.falseNegatives += 1;
  if (label === "indeterminate") stratum.indeterminate += 1;
}

/**
 * Rate over the records that were actually labeled and resolved.
 *
 * `indeterminate` rows are subtracted from the base rather than counted as
 * either outcome — folding them into the denominator would silently report an
 * unresolved record as a correct non-fire, which is the direction that
 * flatters the detector.
 */
function rateOf(stratum: StratumCounts): number | undefined {
  const resolved = stratum.labeled - stratum.indeterminate;
  if (resolved <= 0) return undefined;
  return stratum.falseNegatives / resolved;
}

export function measure(
  records: EvaluationRecord[],
  opts: { since?: string; until?: string; labels?: Record<string, Label> } = {}
): Measurement {
  const labels = opts.labels ?? {};
  const raw = records.length;

  const windowed = records.filter((r) => inWindow(r, opts.since, opts.until));
  const outsideWindowExcluded = raw - windowed.length;

  const nonCanary = windowed.filter((r) => !isCanaryRecord(r));
  const canaryExcluded = windowed.length - nonCanary.length;

  const nonEmpty = nonCanary.filter((r) => r.judgedInput.length > 0);
  const emptyTextExcluded = nonCanary.length - nonEmpty.length;

  const suppressed = emptyStratum();
  const patternTested = emptyStratum();
  for (const record of nonEmpty) {
    const stratum = record.hadSameTurnVerification ? suppressed : patternTested;
    tally(stratum, record, labels[record.judgedInput.hash]);
  }

  const combined: StratumCounts = {
    total: suppressed.total + patternTested.total,
    truncated: suppressed.truncated + patternTested.truncated,
    labeled: suppressed.labeled + patternTested.labeled,
    falseNegatives: suppressed.falseNegatives + patternTested.falseNegatives,
    indeterminate: suppressed.indeterminate + patternTested.indeterminate,
  };

  const timestamps = windowed.map((r) => r.timestamp).sort();

  const byHash = new Map<string, Label | undefined>();
  for (const record of nonEmpty) {
    byHash.set(record.judgedInput.hash, labels[record.judgedInput.hash]);
  }
  const distinctLabels = [...byHash.values()].filter(
    (label): label is Label => label !== undefined && label !== "indeterminate"
  );
  const distinctFn = distinctLabels.filter((label) => label === FALSE_NEGATIVE_LABEL).length;
  const distinct: DistinctCounts = {
    texts: byHash.size,
    resolved: distinctLabels.length,
    falseNegatives: distinctFn,
    rate: distinctLabels.length > 0 ? distinctFn / distinctLabels.length : undefined,
  };

  return {
    window: {
      since: opts.since,
      until: opts.until,
      firstTimestamp: timestamps[0],
      lastTimestamp: timestamps[timestamps.length - 1],
    },
    raw,
    canaryExcluded,
    outsideWindowExcluded,
    emptyTextExcluded,
    denominator: nonEmpty.length,
    fired: nonEmpty.filter((r) => r.fired).length,
    fieldCoverage: {
      recordsWithAllFields: windowed.filter(hasAllFields).length,
      captureSchemas: [...new Set(windowed.map((r) => r.captureSchema))].sort(),
    },
    strata: { suppressed, patternTested },
    rate: {
      overall: rateOf(combined),
      suppressed: rateOf(suppressed),
      patternTested: rateOf(patternTested),
    },
    distinct,
  };
}

function pct(value: number | undefined): string {
  return value === undefined ? "n/a (no resolved labels)" : `${(value * 100).toFixed(1)}%`;
}

function renderStratum(name: string, stratum: StratumCounts, rate: number | undefined): string {
  return [
    `  ${name}`,
    `    records:          ${stratum.total} (${stratum.truncated} truncated)`,
    `    labeled:          ${stratum.labeled} (${stratum.indeterminate} indeterminate)`,
    `    false negatives:  ${stratum.falseNegatives}`,
    `    rate:             ${pct(rate)}`,
  ].join("\n");
}

export function render(m: Measurement): string {
  return [
    `window:  ${m.window.firstTimestamp ?? "-"} .. ${m.window.lastTimestamp ?? "-"}`,
    `         (--since ${m.window.since ?? "unset"}, --until ${m.window.until ?? "unset"})`,
    "",
    "denominator",
    `  raw records:              ${m.raw}`,
    `  - outside window:         ${m.outsideWindowExcluded}`,
    `  - canary rows:            ${m.canaryExcluded}`,
    `  - empty-text rows:        ${m.emptyTextExcluded}`,
    `  = denominator:            ${m.denominator}`,
    `  fired within denominator: ${m.fired}`,
    "",
    "field coverage",
    `  records with all 7 fields: ${m.fieldCoverage.recordsWithAllFields}`,
    `  captureSchema values:      [${m.fieldCoverage.captureSchemas.join(", ")}]`,
    "",
    "strata (matchedPhrases: [] means a different thing in each)",
    renderStratum(
      "suppressed by verification gate (patterns never ran):",
      m.strata.suppressed,
      m.rate.suppressed
    ),
    renderStratum(
      "pattern-tested, declined (patterns ran):",
      m.strata.patternTested,
      m.rate.patternTested
    ),
    "",
    "per distinct text (a repeated text votes once, not twice)",
    `  distinct texts:   ${m.distinct.texts}`,
    `  resolved:         ${m.distinct.resolved}`,
    `  false negatives:  ${m.distinct.falseNegatives}`,
    `  rate:             ${pct(m.distinct.rate)}`,
    "",
    `overall false-negative rate: ${pct(m.rate.overall)} per record, ` +
      `${pct(m.distinct.rate)} per distinct text`,
    `ADR-024 §(b) bar:            <=5% new false-negative, 0 known-FP`,
  ].join("\n");
}

function readArg(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function loadLabels(path: string | undefined): Record<string, Label> | undefined {
  if (!path) return undefined;
  if (!existsSync(path)) {
    console.error(`FAIL: labels file not found: ${path}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, Label>;
}

function dumpRecords(records: EvaluationRecord[], since?: string, until?: string): void {
  for (const record of records) {
    if (!inWindow(record, since, until)) continue;
    if (isCanaryRecord(record) || record.judgedInput.length === 0) continue;
    const stratum = record.hadSameTurnVerification ? "SUPPRESSED" : "PATTERN-TESTED";
    console.log(
      `===== ${record.judgedInput.hash} ${stratum} ` +
        `len=${record.judgedInput.length} truncated=${record.judgedInput.truncated} ` +
        `ts=${record.timestamp}`
    );
    console.log(record.judgedInput.excerpt);
    console.log();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const logPath = readArg(argv, "--log") ?? DEFAULT_LOG;

  if (!existsSync(logPath)) {
    console.error(`FAIL: no evaluation stream at ${logPath}`);
    console.error("The stream is gitignored local telemetry — point --log at the main workspace.");
    process.exit(1);
  }

  const records = parseStream(readFileSync(logPath, "utf-8"));
  const since = readArg(argv, "--since");
  const until = readArg(argv, "--until");

  if (argv.includes("--dump")) {
    dumpRecords(records, since, until);
    return;
  }

  const result = measure(records, { since, until, labels: loadLabels(readArg(argv, "--labels")) });
  console.log(argv.includes("--json") ? JSON.stringify(result, null, 2) : render(result));
}

if (import.meta.main) {
  await main();
}
