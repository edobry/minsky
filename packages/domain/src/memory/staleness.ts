/**
 * Memory-staleness detection (mt#1709, trigger 1: author-declared retirement clause).
 *
 * A memory that documents a workaround carries a retirement clause — "Budget: retire when
 * mt#X ships", "Tracking task: mt#X", "bridge until mt#X lands". Today that clause is inert
 * prose: nothing fires when mt#X ships, so the memory persists as durable-but-wrong and
 * every reader applies its prescription without checking. This module is the read-side
 * detection core: given a memory record and a way to look up task statuses, decide whether
 * the record's own retirement condition has already been met.
 *
 * Deliberately a PURE core with INJECTED lookups — the same shape as
 * `../tasks/spec-freshness.ts`, and for the same reason: the interesting logic is the
 * extraction and the three-way verdict, and neither should need a database to test.
 *
 * ## Two sources, in priority order
 *
 * 1. `associations.tracksTask` (ADR-012 Shape A) — exact, indexed, no false positives.
 * 2. A bounded set of retirement-clause text patterns over the body.
 *
 * (1) is the direction ADR-012 chose in order to RETIRE (2) — its use case #1 is verbatim
 * this lookup, and its `## Decision` adopts the JSONB map to replace "body-text grep for
 * 'Tracking task: mt#X'". But **the association is empty in practice today**: the backfill
 * (`scripts/backfill-memory-associations.ts`, mt#2071, closed DONE 2026-05-24) was one of
 * the two dead scripts mt#3178 repaired on ~2026-07-29 — it crashed before its first query
 * for its entire post-closeout life, and there is no sign it has been re-run. So (2) carries
 * all of v1's load, and (1) is written now so it takes over for free once mt#4448 lands.
 *
 * **A clean association lookup is therefore NOT evidence that no tracking task exists.**
 * That is why an absent `tracksTask` key falls through to the text scan rather than
 * short-circuiting to "current".
 *
 * ## Why the pattern set is NARROW, and why it does not simply reuse the sibling's
 *
 * `.minsky/hooks/bridge-memory-retirement.ts`'s `isBridgeCandidate()` solves what looks like
 * the same problem and its pattern set is deliberately LOOSE — it matches the bare word
 * "bridge" anywhere in the body, or any mention of the task id at all. Copying it here would
 * be a mistake, because the two run in OPPOSITE directions and therefore have opposite error
 * budgets:
 *
 * - **That hook: task -> memories, once, at DONE time.** Recall-oriented. A human reads the
 *   candidates and discards the misses, so a false positive costs one line of reading.
 * - **This module: memory -> tasks, on EVERY search result.** Precision-oriented. A false
 *   positive is an "⚠️ POSSIBLY OBSOLETE" banner on a memory that is perfectly current, on
 *   a surface an agent reads dozens of times a session. Annotate everything and you have
 *   annotated nothing.
 *
 * Concretely: a bare `mt#4345` mention must NOT fire. Memories cite tasks constantly for
 * ordinary cross-reference, and with 500+ tasks reaching DONE in the 22 days to 2026-08-22,
 * a general task-id match would flag nearly every record in the corpus. Only a clause that
 * states a RETIREMENT RELATIONSHIP counts.
 *
 * @see mt#1709 — this module
 * @see docs/memory-staleness-annotation.md — patterns + annotation shape
 * @see docs/architecture/adr-012-memory-entity-associations.md — the association source
 * @see mt#4448 — populating `associations.tracksTask` so source (1) becomes load-bearing
 */

import { renderMeasurementNote, type MeasurementDecay } from "./measurement-decay";
import { TRACKS_TASK_ASSOCIATION } from "./associations";

/**
 * Task statuses that mean the tracked work has landed.
 *
 * Exported because BOTH triggers need it — trigger 1 to decide a tracking task completed,
 * trigger 2 to select intervening tasks — and a second hand-maintained copy in
 * `./intervening-task-lookup.ts` was flagged in review of PR #3271 as a divergence risk. One
 * array, one meaning of "landed".
 */
export const COMPLETED_TASK_STATUSES = ["DONE", "CLOSED"] as const;

const COMPLETED_STATUSES = new Set<string>(COMPLETED_TASK_STATUSES);

/**
 * The association key ADR-012 assigns to memory -> tracking-task links.
 *
 * Re-exported from `./associations.ts` rather than redeclared (mt#4448). Same reasoning as
 * `COMPLETED_TASK_STATUSES` above: a second hand-maintained copy is a divergence risk, and this
 * one would be worse — the write seam validates against the vocabulary module, so a drifted
 * literal here would read a key the validator refuses to let anyone write.
 */
export { TRACKS_TASK_ASSOCIATION };

/**
 * Retirement-clause patterns, each capturing a task id.
 *
 * Every pattern requires an explicit retirement RELATIONSHIP between the memory and the
 * task — a budget, a tracking link, a "until/once ... ships" condition, or a supersession.
 * A bare task mention is not one; see the module docblock for why that distinction is the
 * whole precision story.
 *
 * `mt#\d+` rather than a looser id shape: cross-project ids are explicitly out of scope for
 * v1 per the task's `## Scope`.
 */
/**
 * SELF-ANCHORING patterns: the phrasing itself states a retirement relationship, so no
 * surrounding context is needed to know the clause is about THIS memory's validity.
 */
const SELF_ANCHORED_PATTERNS: readonly RegExp[] = [
  // "Budget: retire when mt#1700 ships" / "retire once mt#1700 lands"
  /\bretire[sd]?\s+(?:when|once|after)\s+(mt#\d+)\b/gi,
  // "Tracking task: mt#1700" / "Tracking task is mt#1700" — the word "task" is required
  /\btracking\s+task\b(?:\s+is)?\s*[:\-—]?\s*(mt#\d+)\b/gi,
  // "Tracking: mt#1700" — the colon is required; a bare "tracking mt#1700" is prose
  /\btracking\s*:\s*(mt#\d+)\b/gi,
  // "bridge until mt#1700" / "bridge memory until mt#1700 ships"
  /\bbridge\b[^.\n]{0,60}?\buntil\s+(mt#\d+)\b/gi,
  // "superseded by mt#1700" / "subsumed by mt#1700" / "replaced by mt#1700"
  /\b(?:superseded|subsumed|replaced)\s+by\s+(mt#\d+)\b/gi,
];

/**
 * CONDITIONAL patterns: "until mt#X lands", "once mt#X ships". These are genuine retirement
 * clauses about half the time and ordinary scheduling prose the other half, so a match only
 * counts when {@link RETIREMENT_ANCHOR} also appears in the preceding window.
 *
 * Measured, not assumed. A first cut treated these as self-anchoring and fired on 194 of
 * 1206 live memories; spot-checking the output found mem#96 ("Cockpit v0 task cluster")
 * flagged because a SUBTASK line read *"push transport (polling v0 → SSE migration when
 * mt#1001 lands)"*. That sentence schedules other work; it says nothing about whether the
 * memory holding it is still true. The anchor requirement is what separates the two, and
 * without the corpus run there was no way to know the distinction mattered.
 */
const CONDITIONAL_PATTERNS: readonly RegExp[] = [
  /\b(?:until|once|when)\s+(mt#\d+)\s+(?:ships|lands|completes|merges|is\s+done)\b/gi,
];

/**
 * Words that make a conditional clause a statement about THIS memory's lifetime. Checked
 * against the text preceding the match on the same sentence.
 */
const RETIREMENT_ANCHOR =
  /\b(?:retire|retirement|budget|bridge|interim|temporary|stopgap|workaround|this memory|holds?|applies|obsolete|delete this|remove this)\b/i;

/** How far back to look for an anchor. One clause's worth of context, not a paragraph. */
const ANCHOR_WINDOW_CHARS = 140;

/** Where a set of tracking refs came from. Recorded so a reader can weigh it. */
export type StalenessRefSource = "associations" | "text";

/**
 * Three-way verdict. `unresolved` exists so that "we could not answer" never collapses into
 * "we answered, nothing is stale" — the same `checked: false` discipline
 * `../tasks/spec-freshness.ts` adopted, for the same reason: a check that could not run must
 * not read as a check that passed.
 */
export type StalenessOutcome = "stale" | "current" | "unresolved";

export interface CompletedTrackingTask {
  taskId: string;
  status: string;
}

/**
 * Staleness verdict attached to a search result. Absent entirely when the record declares no
 * retirement clause at all — which is the overwhelmingly common case, and is why this is an
 * optional field rather than an always-present `outcome: "current"`.
 */
export interface MemoryStaleness {
  outcome: StalenessOutcome;
  /** Which source supplied the refs. */
  source: StalenessRefSource;
  /** Tracking tasks that have reached a completed status. Non-empty iff outcome is "stale". */
  completedTasks: CompletedTrackingTask[];
  /** Tracking tasks whose status could not be determined (unknown id, lookup failure). */
  unresolvedTasks: string[];
  /**
   * Reader-facing line, present only when `outcome === "stale"`. Deliberately absent for
   * `current` and `unresolved` so nothing renders on those paths — see `renderStalenessNote`.
   */
  note?: string;
  /**
   * Trigger 2's finding (mt#4452): a dated measurement whose cited subsystem has changed since
   * it was taken. Independent of the retirement-clause fields above — a record can carry both,
   * either, or neither, so this is a sibling field rather than another `outcome` variant.
   *
   * When present, `outcome` is `"stale"` regardless of what the retirement clause said: a
   * record whose tracking task is still open can still have numbers that no longer describe
   * the system.
   */
  measurement?: MeasurementDecay;
}

/**
 * The subset of a memory record this module reads. Narrow on purpose: it lets the pure core
 * be exercised with object literals instead of full `MemoryRecord` fixtures.
 */
export interface StalenessDetectionInput {
  content: string;
  description?: string;
  associations?: Record<string, string[]> | null;
}

/**
 * Extract tracking-task refs from a record, preferring the structured association.
 *
 * Returns an empty `refs` array when the record declares no retirement relationship. Note
 * the fall-through: an association map that lacks `tracksTask` is NOT treated as an
 * authoritative "no tracking task" — see the module docblock.
 */
export function extractTrackingTaskRefs(record: StalenessDetectionInput): {
  refs: string[];
  source: StalenessRefSource;
} {
  const associated = record.associations?.[TRACKS_TASK_ASSOCIATION];
  if (Array.isArray(associated) && associated.length > 0) {
    return {
      refs: dedupe(associated.filter((r) => typeof r === "string" && r.length > 0)),
      source: "associations",
    };
  }

  const haystack = `${record.description ?? ""}\n${record.content}`;
  const refs: string[] = [];

  for (const pattern of SELF_ANCHORED_PATTERNS) {
    // Patterns are module-level and `g`-flagged, so lastIndex persists across calls.
    // Reset before each use rather than relying on exec-to-exhaustion.
    pattern.lastIndex = 0;
    for (const match of haystack.matchAll(pattern)) {
      const captured = match[1];
      if (captured) refs.push(captured.toLowerCase());
    }
  }

  for (const pattern of CONDITIONAL_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of haystack.matchAll(pattern)) {
      const captured = match[1];
      if (!captured) continue;
      if (hasRetirementAnchor(haystack, match.index ?? 0)) refs.push(captured.toLowerCase());
    }
  }

  return { refs: dedupe(refs), source: "text" };
}

/**
 * Turn extracted refs plus resolved statuses into a verdict.
 *
 * `statuses` maps a task id to its current status, or to `undefined` when the id could not
 * be resolved. A ref missing from the map entirely is treated the same as an explicit
 * `undefined` — both mean "we do not know", never "it is fine".
 */
export function computeStaleness(
  refs: string[],
  source: StalenessRefSource,
  statuses: ReadonlyMap<string, string | undefined>
): MemoryStaleness | undefined {
  if (refs.length === 0) return undefined;

  const completedTasks: CompletedTrackingTask[] = [];
  const unresolvedTasks: string[] = [];

  for (const ref of refs) {
    const status = statuses.get(ref) ?? statuses.get(ref.toLowerCase());
    if (status === undefined) {
      unresolvedTasks.push(ref);
      continue;
    }
    if (COMPLETED_STATUSES.has(status.toUpperCase())) {
      completedTasks.push({ taskId: ref, status: status.toUpperCase() });
    }
  }

  if (completedTasks.length > 0) {
    return {
      outcome: "stale",
      source,
      completedTasks,
      unresolvedTasks,
      note: buildNote(completedTasks),
    };
  }

  if (unresolvedTasks.length > 0) {
    return { outcome: "unresolved", source, completedTasks, unresolvedTasks };
  }

  return { outcome: "current", source, completedTasks, unresolvedTasks };
}

/**
 * Fold trigger 2's finding into trigger 1's verdict (mt#4452).
 *
 * The two triggers are independent detectors over the same record, so this is a combine, not a
 * branch. Cases, all of which occur in the live corpus:
 *
 * - **Neither fires** → `undefined`. The overwhelmingly common case; nothing renders.
 * - **Only trigger 1** → its verdict, unchanged.
 * - **Only trigger 2** → a `stale` verdict with empty tracking-task fields. mem#773 is this
 *   shape: a measurement record with no retirement clause, which is exactly why trigger 1
 *   could not reach the originating incident.
 * - **Both** → `stale`, with both notes joined. Note this can PROMOTE a `current` or
 *   `unresolved` trigger-1 verdict: an open tracking task says nothing about whether the
 *   record's numbers still hold, so the measurement finding is not subordinate to it.
 */
export function combineStaleness(
  retirement: MemoryStaleness | undefined,
  measurement: MeasurementDecay | undefined
): MemoryStaleness | undefined {
  if (!measurement) return retirement;

  const measurementNote = renderMeasurementNote(measurement);
  if (!retirement) {
    return {
      outcome: "stale",
      source: "text",
      completedTasks: [],
      unresolvedTasks: [],
      note: measurementNote,
      measurement,
    };
  }

  return {
    ...retirement,
    outcome: "stale",
    note: retirement.note ? `${retirement.note}\n\n${measurementNote}` : measurementNote,
    measurement,
  };
}

/** One memory's unresolved tracking refs, ready to be logged. */
export interface UnresolvedStalenessRef {
  memoryId: string;
  taskIds: string[];
}

/**
 * Collect the per-memory unresolved refs that warrant a warning (mt#1709, AT4).
 *
 * A pure function returning WHAT to warn about, so the decision is testable without
 * patching a logger — `tests/setup.ts` silences winston's Console under the in-process
 * harness, which would make an "assert the log line appeared" test assert nothing
 * (`claim-confidence.mdc` — a missing log line is a claim about the LOGGER, not the code
 * path). The caller does the emitting; this decides.
 *
 * Only `unresolved` verdicts qualify. A `current` or `stale` verdict resolved everything it
 * needed to, and an id that resolved is not a failure to report.
 */
export function collectUnresolvedRefs(
  entries: { memoryId: string; staleness?: MemoryStaleness }[]
): UnresolvedStalenessRef[] {
  const out: UnresolvedStalenessRef[] = [];
  for (const { memoryId, staleness } of entries) {
    if (staleness?.outcome === "unresolved" && staleness.unresolvedTasks.length > 0) {
      out.push({ memoryId, taskIds: [...staleness.unresolvedTasks] });
    }
  }
  return out;
}

/**
 * The reader-facing line, or `undefined` when nothing should render.
 *
 * Rendering is silent for BOTH `current` and `unresolved`. That is the silence contract: a
 * detector that emits on every result trains readers to skip it, so only an affirmative
 * staleness finding earns text. `unresolved` remains distinguishable from `current` in the
 * structured field for anyone who asks — it just does not shout.
 */
export function renderStalenessNote(staleness: MemoryStaleness | undefined): string | undefined {
  return staleness?.outcome === "stale" ? staleness.note : undefined;
}

function buildNote(completed: CompletedTrackingTask[]): string {
  const rendered = completed.map((t) => `${t.taskId} is ${t.status}`).join(", ");
  const plural = completed.length > 1 ? "tasks" : "task";
  return (
    `⚠️ POSSIBLY OBSOLETE — this memory's tracking ${plural} completed (${rendered}). ` +
    `The structural fix it was written to bridge may already have shipped; verify before ` +
    `acting on its prescription.`
  );
}

/**
 * Does the LINE containing `matchIndex` mark this clause as being about the memory's own
 * lifetime?
 *
 * The whole line, not just what precedes the match: the anchor lands on either side in
 * practice — *"bridge until mt#X ships"* puts it before, *"Once mt#X ships, delete this"*
 * after. Checking only backwards would have silently dropped the second form, which is one
 * of the canonical phrasings this module exists to catch.
 *
 * Bounded to the line (and to {@link ANCHOR_WINDOW_CHARS} either side) so that an anchor in
 * an unrelated bullet cannot vouch for a clause in a different one. That containment is the
 * whole point: the mem#96 false positive lived in a bulleted subtask list where a
 * neighbouring line could easily have supplied a stray "bridge".
 */
function hasRetirementAnchor(haystack: string, matchIndex: number): boolean {
  const lineStart = haystack.lastIndexOf("\n", matchIndex) + 1;
  const lineEndRaw = haystack.indexOf("\n", matchIndex);
  const lineEnd = lineEndRaw === -1 ? haystack.length : lineEndRaw;

  const start = Math.max(lineStart, matchIndex - ANCHOR_WINDOW_CHARS);
  const end = Math.min(lineEnd, matchIndex + ANCHOR_WINDOW_CHARS);

  return RETIREMENT_ANCHOR.test(haystack.slice(start, end));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((v) => v.toLowerCase()))];
}
