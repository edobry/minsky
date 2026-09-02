/**
 * Measurement-decay detection (mt#4452, trigger 2 of the memory-staleness annotation).
 *
 * Trigger 1 (`./staleness.ts`) keys on a clause the AUTHOR WROTE — "Budget: retire when mt#X
 * ships". This keys on something the author could not have written, because they could not
 * have known which future task would invalidate their numbers: a **dated measurement** whose
 * measured subsystem has changed since the measurement date.
 *
 * ## The incident this exists for
 *
 * mem#773 carries transcript-storage figures measured 2026-07-30/31. On 2026-08-20 mt#4345
 * shipped — *"Transcript ingest rewrites every unchanged turn: 19.2M updates against 327k
 * rows"* — which was a large part of what those figures were measuring. Two days later the
 * figures drove a live principal-facing advisory; a dispatched Fable advisor repeated them
 * under the same "not re-run this session" marking, and the principal caught it from the
 * numbers alone. Trigger 1 cannot reach this: mem#773 declares no retirement clause and
 * correctly should not — it is a measurement record, not a bridge. Full shape: mem#1205.
 *
 * ## Why this is a separate module from `./staleness.ts`
 *
 * Deliberate deviation from mt#4452's `## Scope`, which named `staleness.ts` for the second
 * extractor. That file is already 333 lines against a 400-line warn threshold, and the two
 * triggers share only their OUTPUT type — no patterns, no extraction logic, no verdict shape.
 * Co-locating them would push the file over for no cohesion gain. The shared `MemoryStaleness`
 * type stays in `./staleness.ts`; this module contributes the `measurement` half of it.
 *
 * ## Calibrated, not designed
 *
 * The pattern set below is the SECOND cut. Measured against the live corpus (1215 records) at
 * planning time:
 *
 * | date definition | candidates | share | handoff share |
 * | --- | --- | --- | --- |
 * | loose (`as of <date>`, `verified <date>`, …) | 118 | 9.71% | ~75% of sampled |
 * | **measurement-bound (below)** | **28** | **2.30%** | 11/28 |
 *
 * The loose cut was dominated by `handoff_*` records, because `verified <date>` matches a
 * handoff's *"Statuses verified in-turn at …"* line — a status check, not a measurement.
 * Requiring the date to bind to MEASURING A QUANTITY is what separates them. mem#773 remains
 * caught, so the tightening cost no recall on the canonical target.
 *
 * @see mt#4452 — this module · mt#1709 — trigger 1 · mem#1205 — the failure shape
 * @see docs/memory-staleness-annotation.md
 */

import { safeTruncate } from "@minsky/shared/safe-truncate";
import { elideQuotedAndMarkdown } from "../text/prose-elision";

/**
 * The date must bind to MEASURING A QUANTITY. Each pattern captures an ISO date.
 *
 * Deliberately NOT here: `as of <date>`, `verified <date>`, `<date>` in a title. Those match
 * session boundaries and status checks — see the calibration table above.
 */
const MEASUREMENT_DATE_PATTERNS: readonly RegExp[] = [
  // "Measured on prod 2026-07-30", "measured 2026-07-30", "measured on 2026-07-30"
  /\bmeasured\s+(?:on\s+)?(?:prod(?:uction)?\s+)?(?:on\s+)?(\d{4}-\d{2}-\d{2})/gi,
  // "Baseline 2026-05-12", "measurement taken 2026-07-30", "benchmark of 2026-06-30"
  /\b(?:measurement|baseline|benchmark)\b[^.\n]{0,30}?(\d{4}-\d{2}-\d{2})/gi,
  // "2026-07-30 measurement", "(2026-06-30, measured)"
  /\b(\d{4}-\d{2}-\d{2})[^.\n]{0,30}?\bmeasure(?:d|ment)?\b/gi,
];

/**
 * A figure is a number carrying a MAGNITUDE UNIT. A bare integer is a task id, a count of
 * bullet points, a year — none of which decay. Requiring a unit is most of the precision.
 *
 * Terminated with `(?!\w)`, NOT `\b`. A trailing `\b` after an alternation containing `%`
 * silently drops every percentage: `\b` needs a word/non-word transition, and `%` followed by
 * a space is non-word on both sides, so `40% of budget` never matched while `623 MB` did.
 * Same trailing-boundary trap as mt#3357 (`cach[ei]\b` matching "cache" but not "caching"),
 * and it fails the same way — silently, on a subset. Caught here by the unit test, not by
 * reading the pattern.
 *
 * The optional `[kKMGT]\s+` carries an SI magnitude prefix standing between the number and
 * its unit — `14.2 M updates`, `239 k rows`. mem#773 writes its own headline figures that
 * way, so omitting it would have left the canonical target's detection resting on the OTHER
 * figures in that record (`2,047 live rows`, `141,631 updates`), which do match. The replay
 * test passed either way; only a phrasing test surfaced the gap. Whitespace after the prefix
 * is REQUIRED so `623 MB` still parses as the unit `MB` rather than prefix `M` + stray `B`.
 */
const FIGURE_PATTERN =
  /\b\d[\d,.]*\s*(?:[kKMGT]\s+)?(?:%|MB|GB|KB|TB|ms|rows?|updates?|tuples?|req\/s)(?!\w)/i;

/**
 * A measurement younger than this is never reported as decayed, however much has landed.
 *
 * Grounded in observed cadence per `decision-defaults.mdc §Thresholds`, not picked round: 5
 * days is this project's budget window, and it is the interval below which "something touched
 * that subsystem" carries no information — roughly 23 tasks reach a completed status per day
 * here, so on any given week almost every subsystem has been touched by something.
 *
 * The floor exists because the intervening-task signal rests on `tasks.updatedAt`, which is
 * bumped by any later row mutation rather than by completion (see
 * `./intervening-task-lookup.ts`). Measured without it: 38 of 39 candidates fired, including a
 * baseline recorded ONE DAY before the run. The floor does not fix that proxy — it bounds how
 * embarrassing its failures can be.
 */
const MIN_DECAY_AGE_DAYS = 5;

/**
 * Minimum length for a NON-PATH subsystem token to be usable as a match key.
 *
 * A short snake_case identifier (`task_specs`, `agent_id`) appears in a large share of task
 * specs, so matching on it means the SUBSYSTEM is not what selected the intervening tasks. The
 * measured tell: the same few task ids recurred as "intervening" across unrelated memories.
 * Paths carry an extension and are inherently specific, so they are exempt.
 */
const MIN_SUBSYSTEM_TOKEN_LENGTH = 14;

/** A backticked path with a source-file extension — the strongest subsystem signal. */
const CITED_PATH_PATTERN = /`([^`\n]*\.(?:ts|tsx|sql|json))`/g;

/** A backticked snake_case identifier, which in this corpus is nearly always a table name. */
const CITED_TABLE_PATTERN = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;

/** Bare-word table mentions: "the agent_transcript_turns table", "agent_transcripts rows". */
const BARE_TABLE_PATTERN = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b(?=\s+(?:table|rows?))/gi;

export interface InterveningTask {
  taskId: string;
  title: string;
  /**
   * ISO timestamp of the task ROW's last update — deliberately NOT named `completedAt`.
   *
   * It is a weak proxy for completion: any later mutation bumps it (a status correction, a
   * spec patch, a reparent), so it can be arbitrarily later than the work actually landing.
   * Naming it `completedAt` would assert something the value does not carry, which is the
   * same quiet misnomer this whole module exists to catch one level up — a stored figure that
   * reads as current and is not. Renamed on PR #3271 R2.
   */
  rowUpdatedAt?: string;
}

/**
 * A dated measurement found in a memory body, before any staleness judgment.
 */
export interface DetectedMeasurement {
  /** ISO date (YYYY-MM-DD) parsed out of the BODY — never from a column. */
  measuredOn: string;
  /**
   * The sentence the date was found in.
   *
   * Carried because a memory can quote SOMEONE ELSE'S measurement. mem#773's oldest date is
   * `2026-06-30` — ADR-025's blob measurement, which mem#773 quotes while arguing against it
   * — not its own `2026-07-30/31` figures. Showing the sentence puts that attribution in
   * front of the reader instead of hiding it behind a bare date. Same quoted-versus-declared
   * problem mt#4454 covers for retirement clauses; when mt#4386's prose-quotation primitive
   * lands, prefer an UNQUOTED date and fall back to the oldest.
   */
  matchedSentence: string;
  /** Paths and table names the memory cites, used to scope the intervening-change query. */
  subsystems: string[];
}

/**
 * The measurement half of a staleness verdict. Present only when a dated measurement was
 * found AND something has landed on its subsystem since.
 */
export interface MeasurementDecay {
  measuredOn: string;
  /** Whole days between the measurement date and the evaluation time. */
  ageDays: number;
  matchedSentence: string;
  subsystems: string[];
  interveningTasks: InterveningTask[];
}

export interface MeasurementDetectionInput {
  content: string;
  description?: string;
}

/**
 * Find the memory's dated measurement, or `undefined` when it carries none.
 *
 * Requires BOTH a measurement-bound date and a figure with a magnitude unit: a memory that
 * mentions a date without quantities is not a measurement record, and one with quantities but
 * no date cannot be aged.
 *
 * Takes the OLDEST date when several match. Oldest is the conservative direction — it can
 * over-flag, never under-flag — and `matchedSentence` carries the attribution so an
 * over-flag is legible rather than mysterious.
 */
export function extractMeasurement(
  record: MeasurementDetectionInput
): DetectedMeasurement | undefined {
  const raw = `${record.description ?? ""}\n${record.content ?? ""}`;

  // ADR-024 Rung 1 (mt#4785), applied as a SPLIT rather than a wholesale swap — and the split
  // is measured, not stylistic.
  //
  // The GATE — is this record ASSERTING a dated measurement, or QUOTING someone else's? — is a
  // question about the FIGURE and the DATE, so it reads the elided residual. A date inside a
  // code span (mem#1105 quotes its own `## MEASURED 2026-08-19` heading) is not this record
  // taking a measurement.
  //
  // The SUBJECTS are read from RAW, and must be. `CITED_PATH_PATTERN` and
  // `CITED_TABLE_PATTERN` require literal backticks — a cited subject is backticked precisely
  // BECAUSE it is a symbol — so elision destroys exactly what they exist to find. Measured
  // over the live corpus (1343 records, 2026-09-01): 60 records carry a measurement; eliding
  // the whole haystack fixes the gate on **1** and strips the cited subsystems from **55**.
  // Since `subsystems` feeds the intervening-change lookup, that is not cosmetic — it is the
  // input the decay verdict is computed from.
  //
  // Same-length filler (`ELISION_FILL`, mt#4792) is what makes this legal: an offset found in
  // `elided` indexes `raw` identically, so `matchedSentence` slices the ORIGINAL and shows the
  // reader real prose rather than a row of dots.
  const elided = elideQuotedAndMarkdown(raw);
  if (!FIGURE_PATTERN.test(elided)) return undefined;

  let oldest: { date: string; index: number } | undefined;
  for (const pattern of MEASUREMENT_DATE_PATTERNS) {
    // Module-level `g` patterns keep `lastIndex` across calls; reset before each use.
    pattern.lastIndex = 0;
    for (const match of elided.matchAll(pattern)) {
      const date = match[1];
      if (!date || !isValidIsoDate(date)) continue;
      if (!oldest || date < oldest.date) oldest = { date, index: match.index ?? 0 };
    }
  }
  if (!oldest) return undefined;

  return {
    measuredOn: oldest.date,
    matchedSentence: sentenceAround(raw, oldest.index),
    subsystems: extractCitedSubsystems(raw),
  };
}

/**
 * Paths and table names the memory cites, deduped and capped.
 *
 * The cap is a query bound, not a correctness one: a long memory can cite dozens of paths, and
 * the intervening-change lookup turns each into a LIKE predicate. Capping keeps that query
 * bounded; the most-cited subsystems survive because ordering is by citation count.
 */
export function extractCitedSubsystems(haystack: string, limit = 12): string[] {
  const counts = new Map<string, number>();
  const bump = (raw: string | undefined) => {
    if (!raw) return;
    const value = raw.trim();
    // A path is specific by construction; a bare identifier has to earn it on length, or it
    // matches too many task specs to have selected anything. See MIN_SUBSYSTEM_TOKEN_LENGTH.
    const isPath = /\.[a-z]+$/i.test(value);
    if (!isPath && value.length < MIN_SUBSYSTEM_TOKEN_LENGTH) return;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  };

  for (const pattern of [CITED_PATH_PATTERN, CITED_TABLE_PATTERN, BARE_TABLE_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of haystack.matchAll(pattern)) bump(match[1]);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

/**
 * Turn a detected measurement plus the tasks that landed on its subsystem into a verdict.
 *
 * Returns `undefined` when nothing intervened — that is the SILENT case, and it is the common
 * one. A dated measurement is not stale merely for being old; it is stale when the thing it
 * measured has changed.
 */
export function computeMeasurementDecay(
  measurement: DetectedMeasurement,
  interveningTasks: InterveningTask[],
  now: Date
): MeasurementDecay | undefined {
  if (interveningTasks.length === 0) return undefined;
  if (wholeDaysBetween(measurement.measuredOn, now) < MIN_DECAY_AGE_DAYS) return undefined;
  return {
    measuredOn: measurement.measuredOn,
    ageDays: wholeDaysBetween(measurement.measuredOn, now),
    matchedSentence: measurement.matchedSentence,
    subsystems: measurement.subsystems,
    interveningTasks,
  };
}

/**
 * The reader-facing line for a measurement decay.
 *
 * States the observed DELTA and does not assert the figures are wrong — the detector has no
 * standing to reach that verdict, and the reader has the context to. "May no longer describe"
 * is the strongest claim the evidence supports.
 */
export function renderMeasurementNote(decay: MeasurementDecay): string {
  const tasks = decay.interveningTasks
    .slice(0, 3)
    .map((t) => t.taskId)
    .join(", ");
  const more =
    decay.interveningTasks.length > 3 ? ` (+${decay.interveningTasks.length - 3} more)` : "";
  const subsystems = decay.subsystems.slice(0, 3).join(", ");
  return (
    `⚠️ MEASUREMENT MAY BE STALE — figures here were measured ${decay.ageDays} days ago ` +
    `(${decay.measuredOn}), and ${tasks}${more} have since completed against ` +
    `${subsystems || "the cited subsystem"}. Re-measure before relying on these numbers.`
  );
}

function isValidIsoDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function wholeDaysBetween(isoDate: string, now: Date): number {
  const then = new Date(`${isoDate}T00:00:00Z`).getTime();
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}

/**
 * The sentence containing `index`, trimmed and capped so a note stays one line.
 *
 * `safeTruncate` rather than `.slice`: memory prose is emoji-bearing in practice — the corpus
 * these run over contains `⚠️` decay banners — and a raw slice can split a UTF-16 surrogate
 * pair into a replacement character mid-note.
 */
function sentenceAround(haystack: string, index: number, cap = 160): string {
  const start = Math.max(
    haystack.lastIndexOf(". ", index) + 1,
    haystack.lastIndexOf("\n", index) + 1
  );
  const dot = haystack.indexOf(". ", index);
  const nl = haystack.indexOf("\n", index);
  const candidates = [dot, nl].filter((n) => n !== -1);
  const end = candidates.length > 0 ? Math.min(...candidates) : haystack.length;
  return safeTruncate(haystack.slice(start, end).trim(), cap, "head");
}
