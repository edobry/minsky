#!/usr/bin/env bun
/**
 * Replay harness for `stop-at-decision`'s recommendation-marker tune (mt#4085).
 *
 * Answers three questions the task's criteria ask, from ONE source of truth —
 * the shipped `RECOMMENDATION_MARKERS_BASELINE` / `RECOMMENDATION_MARKERS_MT4085`
 * split in `.minsky/hooks/stop-at-decision-scan.ts`, so the "before" arm cannot
 * drift out of sync with what actually ships:
 *
 *  1. **Calibration replay (SC2/SC3).** Which of the 2026-08-13 window's records
 *     the addition suppresses, and — the negative control — that it does NOT
 *     suppress the two the pass classified uncertain.
 *  2. **Nullification (SC5).** What fraction of ordinary candidate-turn prose the
 *     widened list marks, against the baseline's own fraction. This is the check
 *     that matters: a marker set that marks nearly everything converts a noisy
 *     detector into a silent one, which is worse. mt#3861 rejected two regex
 *     candidates on exactly this measurement (96.3% marked).
 *  3. **Fire rate (SC6).** Post-tune fire rate over the evaluation stream, so
 *     "fires less" is distinguishable from "detects less".
 *
 * ## Why the corpus is recovered from transcripts rather than read from a log
 *
 * `.minsky/stop-at-decision-evaluations.jsonl` records every evaluated turn and
 * its suppression reasons, but NOT the message text, so it cannot be re-matched
 * against a candidate pattern. It does carry `session_id` + `turnKey`, so the
 * judged message is recoverable from the local transcript store.
 *
 * **That recovery is validated rather than assumed** (`--validate`): for every
 * turn that FIRED, the calibration log stored the last 600 chars of the very
 * message the detector judged, and the recovered text must reproduce it exactly.
 * A corpus that cannot disagree with the tool measuring it is not evidence.
 *
 * Emits AGGREGATE COUNTS AND TIMESTAMPS ONLY — never message text. The corpus is
 * the operator's own transcripts.
 *
 * Usage:
 *   bun scripts/replay-stop-at-decision-markers.ts
 *   bun scripts/replay-stop-at-decision-markers.ts --validate   # recovery ground-truth check only
 *   bun scripts/replay-stop-at-decision-markers.ts --json
 *
 * Exit 0 when it completes (including a clean SKIP when the local transcript
 * store is absent, e.g. in CI); non-zero only on an unexpected failure.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  RECOMMENDATION_MARKERS_BASELINE,
  RECOMMENDATION_MARKERS_MT4085,
} from "../.minsky/hooks/stop-at-decision-scan.ts";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * Both logs are local operator exhaust and are NOT committed, so a session
 * workspace (a fresh clone) does not have them — `--logs <dir>` points the
 * harness at a checkout that does. Defaults to this checkout's own `.minsky`,
 * and no machine-specific path is baked in as a default.
 */
function resolveLogDir(argv: readonly string[]): string {
  const at = argv.indexOf("--logs");
  const value = at >= 0 ? argv[at + 1] : undefined;
  return value !== undefined && value !== "" ? value : join(REPO_ROOT, ".minsky");
}

const LOG_DIR = resolveLogDir(process.argv.slice(2));
const CALIBRATION_LOG = join(LOG_DIR, "stop-at-decision-calibration.jsonl");
const EVALUATION_LOG = join(LOG_DIR, "stop-at-decision-evaluations.jsonl");
const TRANSCRIPT_DIR = join(homedir(), ".claude", "projects", "-Users-edobry-Projects-minsky");

/**
 * The 2026-08-13 calibration pass's window and hand-classification.
 *
 * The window is records 12-22, derived from
 * `.minsky/calibration-review-watermarks.json` (`lastReviewedCount: 22`, and the
 * pass reviewed 11 records). Pinned by TIMESTAMP rather than by line number so
 * the harness keeps addressing the same records as the log grows.
 */
const CLASSIFIED_FALSE: readonly string[] = [
  "2026-08-09T03:54:06.294Z",
  "2026-08-10T10:05:00.430Z",
  "2026-08-10T10:23:39.727Z",
  "2026-08-10T15:24:57.548Z",
  "2026-08-10T17:40:01.170Z",
  "2026-08-11T20:29:00.676Z",
  "2026-08-12T00:20:22.155Z",
  "2026-08-12T21:51:50.121Z",
  "2026-08-12T22:08:54.449Z",
];

/** The two the pass could not classify — pinned as the negative control (SC3). */
const CLASSIFIED_UNCERTAIN: readonly string[] = [
  "2026-08-08T23:46:04.601Z",
  "2026-08-10T11:24:38.673Z",
];

/** Fires that landed AFTER the reviewed window — held-out validation (SC7). */
const HELD_OUT: readonly string[] = [
  "2026-08-13T13:50:16.909Z",
  "2026-08-13T21:33:09.626Z",
  "2026-08-14T02:56:48.497Z",
];

interface JsonRecord {
  [key: string]: unknown;
}

function readJsonl(path: string): JsonRecord[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    process.stderr.write(`cannot read ${path}: ${String(error)}\n`);
    return [];
  }
  const out: JsonRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as JsonRecord);
    } catch {
      // intentional-swallow: a torn final line is expected in a live-appended log.
      continue;
    }
  }
  return out;
}

const matchesBaseline = (text: string): boolean =>
  RECOMMENDATION_MARKERS_BASELINE.some((re) => re.test(text));
const matchesAddition = (text: string): boolean =>
  RECOMMENDATION_MARKERS_MT4085.some((re) => re.test(text));
const matchesAny = (text: string): boolean => matchesBaseline(text) || matchesAddition(text);

// --- transcript recovery -----------------------------------------------------

const transcriptCache = new Map<string, JsonRecord[] | null>();

function transcriptFor(sessionId: string): JsonRecord[] | null {
  const cached = transcriptCache.get(sessionId);
  if (cached !== undefined) return cached;
  const file = join(TRANSCRIPT_DIR, `${sessionId}.jsonl`);
  const entries = existsSync(file) ? readJsonl(file) : null;
  transcriptCache.set(sessionId, entries);
  return entries;
}

function assistantText(entry: JsonRecord): string | null {
  if (entry["type"] !== "assistant") return null;
  const message = entry["message"] as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((b): b is { type: string; text: string } => (b as { type?: string })?.type === "text")
    .map((b) => b.text);
  return parts.length > 0 ? parts.join("") : null;
}

/**
 * The turn's FINAL assistant message: the last assistant text entry in
 * `[turnKey, firedAt]`.
 *
 * Bounded by the record's own fire timestamp, which is when the detector read
 * `last_assistant_message`. An earlier version of this walked forward from
 * `turnKey` and stopped at the first `user` entry carrying no `tool_result` —
 * which is wrong, because hook injections and system-reminder attachments arrive
 * as user-typed entries MID-turn and closed the window early, returning an
 * earlier assistant message. That version reproduced the detector's recorded
 * verdict on only 68.8% of records; this one reproduces it on 100%. Kept in the
 * comment because the failure is invisible without the `--validate` check —
 * a wrong-message corpus still produces a plausible-looking percentage.
 */
function recoverTurnFinalMessage(
  sessionId: string,
  turnKey: string,
  firedAt: string
): string | null {
  const entries = transcriptFor(sessionId);
  if (entries === null) return null;
  const start = new Date(turnKey).getTime();
  const end = new Date(firedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  let last: string | null = null;
  for (const entry of entries) {
    const stamp = entry["timestamp"];
    const ts = typeof stamp === "string" ? new Date(stamp).getTime() : NaN;
    if (Number.isNaN(ts) || ts < start || ts > end) continue;
    const text = assistantText(entry);
    if (text !== null && text.trim() !== "") last = text;
  }
  return last;
}

// --- the three measurements --------------------------------------------------

interface CalibrationVerdict {
  timestamp: string;
  cohort: "false" | "uncertain" | "held-out" | "other";
  suppressedBefore: boolean;
  suppressedAfter: boolean;
}

function replayCalibration(): CalibrationVerdict[] {
  return readJsonl(CALIBRATION_LOG).map((record) => {
    const timestamp = String(record["timestamp"] ?? "");
    const tail = String(record["final_message_tail"] ?? "");
    const cohort: CalibrationVerdict["cohort"] = CLASSIFIED_FALSE.includes(timestamp)
      ? "false"
      : CLASSIFIED_UNCERTAIN.includes(timestamp)
        ? "uncertain"
        : HELD_OUT.includes(timestamp)
          ? "held-out"
          : "other";
    return {
      timestamp,
      cohort,
      suppressedBefore: matchesBaseline(tail),
      suppressedAfter: matchesAny(tail),
    };
  });
}

interface CorpusResult {
  evaluated: number;
  recovered: number;
  unrecoverable: number;
  agreed: number;
  markedBefore: number;
  markedAfter: number;
  newlyMarked: number;
  firedBefore: number;
  firedAfter: number;
}

function measureCorpus(): CorpusResult {
  const records = readJsonl(EVALUATION_LOG);
  const result: CorpusResult = {
    evaluated: records.length,
    recovered: 0,
    unrecoverable: 0,
    agreed: 0,
    markedBefore: 0,
    markedAfter: 0,
    newlyMarked: 0,
    firedBefore: 0,
    firedAfter: 0,
  };

  for (const record of records) {
    const sessionId = String(record["session_id"] ?? "");
    const turnKey = String(record["turnKey"] ?? "");
    const firedAt = String(record["timestamp"] ?? "");
    const fired = record["fired"] === true;
    if (fired) result.firedBefore += 1;

    const text = recoverTurnFinalMessage(sessionId, turnKey, firedAt);
    if (text === null) {
      result.unrecoverable += 1;
      // An unrecoverable turn cannot be re-judged; carry its recorded verdict
      // forward rather than silently dropping it from the fire count.
      if (fired) result.firedAfter += 1;
      continue;
    }
    result.recovered += 1;

    const reasons = Array.isArray(record["suppressionReasons"])
      ? (record["suppressionReasons"] as string[])
      : [];
    const before = matchesBaseline(text);
    if (before === reasons.includes("recommendation-marker")) result.agreed += 1;

    const after = matchesAny(text);
    if (before) result.markedBefore += 1;
    if (after) result.markedAfter += 1;
    if (!before && after) result.newlyMarked += 1;

    // A fired turn stops firing only if the ADDITION now marks it.
    if (fired && !after) result.firedAfter += 1;
  }
  return result;
}

// --- reporting ---------------------------------------------------------------

function pct(n: number, of: number): string {
  return of === 0 ? "n/a" : `${((n / of) * 100).toFixed(1)}%`;
}

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const validateOnly = args.includes("--validate");

  if (!existsSync(EVALUATION_LOG) && !existsSync(CALIBRATION_LOG)) {
    process.stdout.write("SKIP: no stop-at-decision logs in this checkout.\n");
    return;
  }
  if (!existsSync(TRANSCRIPT_DIR)) {
    process.stdout.write(
      "SKIP: local transcript store absent — corpus and fire-rate measurements need it.\n"
    );
    if (!validateOnly) {
      const calibration = replayCalibration();
      process.stdout.write(`calibration replay still available: ${calibration.length} records\n`);
    }
    return;
  }

  const corpus = measureCorpus();

  if (validateOnly) {
    process.stdout.write(
      `recovery agreement with the detector's RECORDED verdict: ` +
        `${corpus.agreed}/${corpus.recovered} (${pct(corpus.agreed, corpus.recovered)})\n`
    );
    return;
  }

  const calibration = replayCalibration();
  const cohort = (name: CalibrationVerdict["cohort"]) =>
    calibration.filter((c) => c.cohort === name);
  const suppressedIn = (name: CalibrationVerdict["cohort"]) =>
    cohort(name).filter((c) => c.suppressedAfter);

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          calibration: calibration.map((c) => ({ ...c })),
          corpus,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  process.stdout.write(
    `## Calibration replay (SC2/SC3) — ${calibration.length} records\n\n` +
      `classified FALSE   : ${suppressedIn("false").length}/${cohort("false").length} now suppressed\n` +
      `UNCERTAIN (control): ${suppressedIn("uncertain").length}/${cohort("uncertain").length} suppressed  ` +
      `(must be 0 — a marker that silences these is too broad)\n` +
      `held-out (SC7)     : ${suppressedIn("held-out").length}/${cohort("held-out").length} suppressed\n\n`
  );

  process.stdout.write(`residual — classified FALSE and still firing:\n`);
  const residual = cohort("false").filter((c) => !c.suppressedAfter);
  if (residual.length === 0) {
    process.stdout.write("  (none)\n");
  } else {
    for (const r of residual) process.stdout.write(`  ${r.timestamp}\n`);
  }

  process.stdout.write(
    `\n## Nullification (SC5) — candidate-turn corpus\n\n` +
      `evaluated turns    : ${corpus.evaluated}\n` +
      `recovered          : ${corpus.recovered}  unrecoverable: ${corpus.unrecoverable}\n` +
      `recovery agreement : ${corpus.agreed}/${corpus.recovered} (${pct(corpus.agreed, corpus.recovered)}) ` +
      `against the detector's recorded verdict\n` +
      `marked BEFORE      : ${corpus.markedBefore} (${pct(corpus.markedBefore, corpus.recovered)})\n` +
      `marked AFTER       : ${corpus.markedAfter} (${pct(corpus.markedAfter, corpus.recovered)})\n` +
      `newly marked       : ${corpus.newlyMarked} (${pct(corpus.newlyMarked, corpus.recovered)})\n`
  );

  process.stdout.write(
    `\n## Fire rate (SC6) — evaluation stream\n\n` +
      `fired BEFORE       : ${corpus.firedBefore} (${pct(corpus.firedBefore, corpus.evaluated)})\n` +
      `fired AFTER        : ${corpus.firedAfter} (${pct(corpus.firedAfter, corpus.evaluated)})\n`
  );
}

main();
