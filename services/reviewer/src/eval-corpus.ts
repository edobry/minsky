/**
 * Types + pure JSONL helpers for the reviewer benchmark's ground-truth corpus.
 *
 * The corpus is a versioned, git-committed JSONL file (one `CorpusRow` per
 * line) mined from `minsky-reviewer[bot]`'s own review history plus an
 * injected-bug slice. See mt#2726 (Milestone A) for the mining pipeline and
 * mt#2991 (Milestone B) for judge calibration against a human gold set.
 *
 * This module is intentionally pure: no file I/O, no network. Callers own
 * reading/writing the underlying file; `parseCorpusJsonl` / `serializeCorpusJsonl`
 * only convert between the JSONL text representation and typed rows.
 */

import type { FlatFinding } from "./replay-summary";

// ---------------------------------------------------------------------------
// Corpus row schema
// ---------------------------------------------------------------------------

/**
 * Where a corpus row's finding + label originated.
 *
 * - `git-diff-mined` — finding mined from a real bot review, label derived by
 *   cross-checking the finding's file:line window against a later diff.
 * - `injected-bug` — finding derived from `seeded-bug-harness.ts`'s bug
 *   catalog (off-by-one / null-deref / unhandled-promise), unambiguous
 *   location ground truth.
 * - `clean-pr` — a PR (or PR slice) with no real findings, used as a
 *   true-negative source for false-positive-rate measurement.
 */
export type CorpusRowSource = "git-diff-mined" | "injected-bug" | "clean-pr";

/**
 * How a row's `label.value` was derived.
 *
 * Extensible: new provenance-tagged outcomes can be appended as the mining
 * pipeline grows additional deterministic signals.
 */
export type CorpusLabelValue =
  | "git-diff-fixed"
  | "carried-forward-unchanged"
  | "dismissed-no-change"
  | "injected-exact"
  | "judge-verdict";

/** Whether a label was derived deterministically (git-diff cross-check,
 * injected-bug ground truth) or by the raw judge pass (uncalibrated). */
export type CorpusLabelProvenance = "deterministic" | "judge";

/**
 * Confidence tag for a label. `gold` labels are high-confidence ground
 * truth (e.g. injected-bug exact matches); `noisy-positive` / `noisy-negative`
 * are deterministic-but-imperfect signals (e.g. "the file wasn't touched in
 * the next round" is evidence of, but not proof of, a dismissal).
 */
export type CorpusLabelConfidence = "gold" | "noisy-positive" | "noisy-negative";

/** A corpus row's label: the outcome value plus its provenance + confidence. */
export interface CorpusLabel {
  value: CorpusLabelValue;
  provenance: CorpusLabelProvenance;
  confidence: CorpusLabelConfidence;
}

/**
 * The finding stored in a corpus row: the `FlatFinding` fields (file /
 * severity / line / lineEnd) plus the finding's review-comment `text` — the
 * prose the reviewer wrote. `text` is required because the judge and the
 * eval both need the finding's content, not just its location; `FlatFinding`
 * alone (from replay-summary.ts) deliberately drops it.
 */
export interface CorpusFinding extends FlatFinding {
  /** The reviewer's finding text (the prose after `path:line - ...`). */
  text: string;
}

/**
 * One ground-truth row in the corpus. One JSON object per line in the
 * committed JSONL file.
 */
export interface CorpusRow {
  /** Stable row id: `pr-<num>-r<round>-f<idx>`. */
  id: string;
  /** Corpus version this row was minted under (e.g. `"v1"`). */
  corpusVersion: string;
  /** Where this row's finding + label originated. */
  source: CorpusRowSource;
  /** Source PR number. */
  prNumber: number;
  /** Review round within the PR the finding was raised in. */
  round: number;
  /** The finding itself — `FlatFinding` fields plus the review-comment text. */
  finding: CorpusFinding;
  /** Surrounding code context window (target: +/-80 lines). */
  codeContextWindow: string;
  /** Outcome label for this row. */
  label: CorpusLabel;
  /** ISO-8601 timestamp of when this row was mined. */
  minedAt: string;
}

// ---------------------------------------------------------------------------
// Validation helpers (trust-boundary guard — corpus files are read input)
// ---------------------------------------------------------------------------

const VALID_SOURCES: ReadonlySet<string> = new Set(["git-diff-mined", "injected-bug", "clean-pr"]);

const VALID_SEVERITIES: ReadonlySet<string> = new Set(["BLOCKING", "NON-BLOCKING", "PRE-EXISTING"]);

const VALID_LABEL_VALUES: ReadonlySet<string> = new Set([
  "git-diff-fixed",
  "carried-forward-unchanged",
  "dismissed-no-change",
  "injected-exact",
  "judge-verdict",
]);

const VALID_LABEL_PROVENANCE: ReadonlySet<string> = new Set(["deterministic", "judge"]);

const VALID_LABEL_CONFIDENCE: ReadonlySet<string> = new Set([
  "gold",
  "noisy-positive",
  "noisy-negative",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate that `finding` matches the `CorpusFinding` shape at runtime.
 * `line` / `lineEnd` are optional but, when present, must be finite numbers;
 * `text` is required and must be a non-empty string.
 */
function isValidFinding(finding: unknown): finding is CorpusFinding {
  if (typeof finding !== "object" || finding === null) return false;
  const f = finding as Record<string, unknown>;
  if (!isNonEmptyString(f["file"])) return false;
  if (typeof f["severity"] !== "string" || !VALID_SEVERITIES.has(f["severity"])) return false;
  if (f["line"] !== undefined && !isFiniteNumber(f["line"])) return false;
  if (f["lineEnd"] !== undefined && !isFiniteNumber(f["lineEnd"])) return false;
  if (!isNonEmptyString(f["text"])) return false;
  return true;
}

/** Validate that `label` matches the `CorpusLabel` shape at runtime. */
function isValidLabel(label: unknown): label is CorpusLabel {
  if (typeof label !== "object" || label === null) return false;
  const l = label as Record<string, unknown>;
  if (typeof l["value"] !== "string" || !VALID_LABEL_VALUES.has(l["value"])) return false;
  if (typeof l["provenance"] !== "string" || !VALID_LABEL_PROVENANCE.has(l["provenance"])) {
    return false;
  }
  if (typeof l["confidence"] !== "string" || !VALID_LABEL_CONFIDENCE.has(l["confidence"])) {
    return false;
  }
  return true;
}

/**
 * Validate that a parsed JSON value matches the `CorpusRow` shape at
 * runtime. Defensive: corpus files are read input (trust-boundary guard per
 * the implement-task section 7 convergence checklist).
 */
function isValidCorpusRow(row: unknown): row is CorpusRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  if (!isNonEmptyString(r["id"])) return false;
  if (!isNonEmptyString(r["corpusVersion"])) return false;
  if (typeof r["source"] !== "string" || !VALID_SOURCES.has(r["source"])) return false;
  if (!isFiniteNumber(r["prNumber"])) return false;
  if (!isFiniteNumber(r["round"])) return false;
  if (!isValidFinding(r["finding"])) return false;
  if (typeof r["codeContextWindow"] !== "string") return false;
  if (!isValidLabel(r["label"])) return false;
  if (!isNonEmptyString(r["minedAt"])) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Parse / serialize
// ---------------------------------------------------------------------------

/** Result of `parseCorpusJsonlWithStats`: the valid rows plus a count of the
 * lines that were skipped because they were malformed JSON or failed
 * schema validation. */
export interface ParseCorpusJsonlResult {
  rows: CorpusRow[];
  skippedLineCount: number;
}

/**
 * Parse a JSONL corpus file's text content into typed `CorpusRow`s.
 *
 * Defensive by design (trust boundary — corpus files are read input):
 * - blank lines are silently skipped (not counted as malformed)
 * - a line that fails `JSON.parse` is skipped and counted
 * - a line that parses but doesn't match the `CorpusRow` shape is skipped
 *   and counted
 *
 * Pure: no I/O. Callers own reading the file's text content. Returns only
 * the well-typed rows; use `parseCorpusJsonlWithStats` if the skipped-line
 * count is also needed.
 */
export function parseCorpusJsonl(text: string): CorpusRow[] {
  return parseCorpusJsonlWithStats(text).rows;
}

/**
 * Same as `parseCorpusJsonl` but also returns the count of skipped
 * (malformed or schema-invalid) lines, for callers that want to surface
 * data-quality diagnostics.
 */
export function parseCorpusJsonlWithStats(text: string): ParseCorpusJsonlResult {
  const rows: CorpusRow[] = [];
  let skippedLineCount = 0;

  const lines = text.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skippedLineCount += 1;
      continue;
    }

    if (!isValidCorpusRow(parsed)) {
      skippedLineCount += 1;
      continue;
    }

    rows.push(parsed);
  }

  return { rows, skippedLineCount };
}

/**
 * Serialize `CorpusRow`s into JSONL text (one JSON object per line,
 * newline-terminated). Pure: no I/O. Callers own writing the result to
 * disk.
 */
export function serializeCorpusJsonl(rows: CorpusRow[]): string {
  if (rows.length === 0) return "";
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}
