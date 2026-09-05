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
import { join } from "node:path";
import { isCanaryRecord } from "../.minsky/hooks/canary-runner";
import { evaluationLogPath } from "../.minsky/hooks/dispatcher";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * Resolved through the WRITER's own resolver, never a repo-rooted literal (mt#4972).
 *
 * mt#4748 moved this stream to `<state dir>/projects/<key>/`, and the old
 * `.minsky/`-rooted default outlived it, so every run with no `--log` failed on
 * a path nothing has written to since 2026-08-30. `fallbackCwd` (not
 * `projectDir`) keeps the resolver's `CLAUDE_PROJECT_DIR` tier ahead of this
 * checkout, which matters when the script runs from a session workspace.
 */
const DEFAULT_LOG = evaluationLogPath("causal-premise", { fallbackCwd: REPO_ROOT });

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
  /**
   * Rows the corpus lost before any measurement ran. Reported rather than
   * thrown on, and reported even at zero: "0 malformed" is the receipt that
   * the check ran, which a silent skip cannot distinguish itself from.
   */
  dataQuality: { malformedLines: number; invalidTimestamps: number };
  denominator: number;
  fired: number;
  fieldCoverage: { recordsWithAllFields: number; captureSchemas: number[] };
  strata: { suppressed: StratumCounts; patternTested: StratumCounts };
  rate: { overall?: number; suppressed?: number; patternTested?: number };
  distinct: DistinctCounts;
  verdict: Verdict;
}

/** ADR-024 §(b) bar: `0 known-FP AND <=5% new false-negative`. */
export const FALSE_NEGATIVE_BAR = 0.05;

/**
 * Which halves of ADR-024 §(b)'s bar this run actually evaluated.
 *
 * Both halves are stated explicitly, including when they were NOT evaluated,
 * because the failure mode here is a reader taking silence for a pass. Two
 * ways that happens:
 *
 *  - Run with no `--labels` and every rate is `n/a`, yet the bar is printed
 *    beside it. Nothing says "no comparison was made."
 *  - `0 known-FP` holds trivially in a window with zero fires — no fire means
 *    no false positive was possible. That is a fact about the window, not
 *    evidence of precision, and it must not read as half a pass.
 *
 * This script only ever computes the false-negative half; the FP half needs
 * fires classified, which is a different pass.
 */
export interface Verdict {
  falseNegative: "not-evaluated" | "met" | "not-met";
  falsePositive: "vacuous-zero-fires" | "not-computed-by-this-script";
  resolvedLabels: number;
}

export interface ParsedStream {
  records: EvaluationRecord[];
  malformedLines: number;
}

/**
 * Parse a JSONL evaluation stream, skipping blank lines.
 *
 * A malformed line is SKIPPED AND COUNTED, never thrown on: the stream is
 * append-only telemetry written by a live hook, so a partial line from an
 * interrupted write is routine rather than exceptional, and letting one kill
 * the run would make the measurement non-reproducible on exactly the days it
 * matters. The count rides in the report so a skip is never silent — a
 * measurement over a corpus that quietly lost rows is the failure mode this
 * whole task exists to avoid.
 */
export function parseStream(text: string): ParsedStream {
  const records: EvaluationRecord[] = [];
  let malformedLines = 0;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as EvaluationRecord);
    } catch {
      malformedLines += 1;
    }
  }

  return { records, malformedLines };
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

/**
 * Epoch ms for an ISO-8601 timestamp, or `undefined` when it does not parse.
 *
 * The window bounds used to be raw string comparisons, which are only
 * chronological while every timestamp is same-precision UTC with a trailing
 * `Z`. A record carrying an offset (`+00:00`), different sub-second precision,
 * or no zone designator would sort lexicographically but not chronologically —
 * and would land on the wrong side of `--until` with no error to notice.
 */
export function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function inWindow(at: number, since?: number, until?: number): boolean {
  if (since !== undefined && at < since) return false;
  if (until !== undefined && at > until) return false;
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
  opts: {
    since?: string;
    until?: string;
    labels?: Record<string, Label>;
    malformedLines?: number;
  } = {}
): Measurement {
  const labels = opts.labels ?? {};
  const raw = records.length;

  const since = parseTimestamp(opts.since);
  const until = parseTimestamp(opts.until);

  // A record whose timestamp does not parse cannot be placed in the window at
  // all, so it is excluded and counted rather than silently compared. Keeping
  // it would put an unplaceable row inside a windowed denominator.
  const dated = records
    .map((record) => ({ record, at: parseTimestamp(record.timestamp) }))
    .filter((entry): entry is { record: EvaluationRecord; at: number } => entry.at !== undefined);
  const invalidTimestamps = raw - dated.length;

  const windowedEntries = dated.filter((entry) => inWindow(entry.at, since, until));
  const windowed = windowedEntries.map((entry) => entry.record);
  const outsideWindowExcluded = dated.length - windowed.length;

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

  // Sorted by parsed instant, not by string. The window comparison was fixed
  // to be chronological; sorting the DISPLAY bounds lexicographically here
  // would have left the same defect one field over, reporting a first/last
  // pair that is not actually the earliest/latest record. The original
  // spelling is preserved in the output — only the ordering is normalized.
  const chronological = [...windowedEntries].sort((a, b) => a.at - b.at);
  const timestamps = chronological.map((entry) => entry.record.timestamp);

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

  const overallRate = rateOf(combined);
  const firedInDenominator = nonEmpty.filter((r) => r.fired).length;

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
    dataQuality: { malformedLines: opts.malformedLines ?? 0, invalidTimestamps },
    denominator: nonEmpty.length,
    fired: firedInDenominator,
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
    verdict: {
      // Judged on the per-record rate, the stricter of the two framings. When
      // the two disagree the run is too close to call from this corpus, and
      // `render()` prints both so the disagreement is visible rather than
      // resolved by whichever one this line happened to pick.
      falseNegative:
        overallRate === undefined
          ? "not-evaluated"
          : overallRate <= FALSE_NEGATIVE_BAR
            ? "met"
            : "not-met",
      falsePositive:
        firedInDenominator === 0 ? "vacuous-zero-fires" : "not-computed-by-this-script",
      resolvedLabels: combined.labeled - combined.indeterminate,
    },
  };
}

function pct(value: number | undefined): string {
  return value === undefined ? "n/a (no resolved labels)" : `${(value * 100).toFixed(1)}%`;
}

/**
 * The verdict block, written so that no run of this script can be skim-read as
 * a pass it did not establish. Every branch names what was NOT evaluated.
 */
function renderVerdict(m: Measurement): string {
  const bar = `${(FALSE_NEGATIVE_BAR * 100).toFixed(0)}%`;
  const lines = [`ADR-024 §(b) bar: 0 known-FP AND <=${bar} new false-negative`, ""];

  if (m.verdict.falseNegative === "not-evaluated") {
    lines.push(
      `  false-negative half: NOT EVALUATED — 0 resolved labels.`,
      `    No rate was computed, so this run establishes nothing about the bar.`,
      `    Pass --labels <file> mapping judgedInput.hash -> a label to evaluate it.`
    );
  } else {
    const met = m.verdict.falseNegative === "met";
    lines.push(
      `  false-negative half: ${met ? "MET" : "NOT MET"} — ` +
        `${pct(m.rate.overall)} per record (${m.verdict.resolvedLabels} resolved labels), ` +
        `${pct(m.distinct.rate)} per distinct text, against <=${bar}.`
    );
    if (m.distinct.rate !== undefined && met !== m.distinct.rate <= FALSE_NEGATIVE_BAR) {
      lines.push(
        `    CAUTION: the two framings straddle the bar, so this verdict rests on`,
        `    which one is chosen. Treat it as too close to call from this corpus.`
      );
    }
  }

  lines.push("");
  if (m.verdict.falsePositive === "vacuous-zero-fires") {
    lines.push(
      `  false-positive half: VACUOUS — the detector fired 0 times in this window,`,
      `    so no false positive was possible. "0 known-FP" holds trivially here and`,
      `    is NOT evidence of precision. Do not report it as half a pass.`
    );
  } else {
    lines.push(
      `  false-positive half: NOT COMPUTED — ${m.fired} fire(s) in this window.`,
      `    This script measures only the false-negative half; classifying those`,
      `    fires is a separate pass.`
    );
  }

  return lines.join("\n");
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
    "data quality (rows the corpus lost before measuring)",
    `  malformed JSONL lines:     ${m.dataQuality.malformedLines}`,
    `  unparseable timestamps:    ${m.dataQuality.invalidTimestamps}`,
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
    renderVerdict(m),
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
  const sinceMs = parseTimestamp(since);
  const untilMs = parseTimestamp(until);

  for (const record of records) {
    const at = parseTimestamp(record.timestamp);
    if (at === undefined || !inWindow(at, sinceMs, untilMs)) continue;
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
    console.error(
      "The stream is local telemetry under the state dir, keyed by repo root. If this resolved " +
        "to the wrong project, set CLAUDE_PROJECT_DIR to the main checkout or pass --log."
    );
    process.exit(1);
  }

  const { records, malformedLines } = parseStream(readFileSync(logPath, "utf-8"));
  const since = readArg(argv, "--since");
  const until = readArg(argv, "--until");

  // A bound that does not parse would silently window nothing out, so it is a
  // hard error rather than a skipped filter — the failure mode of a bad
  // `--until` is a plausible-looking report over the wrong corpus.
  for (const [flag, value] of [
    ["--since", since],
    ["--until", until],
  ] as const) {
    if (value !== undefined && parseTimestamp(value) === undefined) {
      console.error(`FAIL: ${flag} is not a parseable timestamp: ${value}`);
      process.exit(1);
    }
  }

  if (argv.includes("--dump")) {
    dumpRecords(records, since, until);
    return;
  }

  const result = measure(records, {
    since,
    until,
    malformedLines,
    labels: loadLabels(readArg(argv, "--labels")),
  });
  console.log(argv.includes("--json") ? JSON.stringify(result, null, 2) : render(result));
}

if (import.meta.main) {
  await main();
}
