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

/** Task statuses that mean the tracked work has landed. */
const COMPLETED_STATUSES = new Set(["DONE", "CLOSED"]);

/** The association key ADR-012 assigns to memory -> tracking-task links. */
export const TRACKS_TASK_ASSOCIATION = "tracksTask";

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
const RETIREMENT_CLAUSE_PATTERNS: readonly RegExp[] = [
  // "Budget: retire when mt#1700 ships" / "retire when mt#1700 lands"
  /\bretire[sd]?\s+(?:when|once|after)\s+(mt#\d+)\b/gi,
  // "Tracking task: mt#1700" / "tracking: mt#1700" / "Tracking task is mt#1700"
  /\btracking(?:\s+task)?(?:\s+is)?\s*[:\-—]?\s*(mt#\d+)\b/gi,
  // "until mt#1700 ships" / "once mt#1700 lands" / "when mt#1700 ships"
  /\b(?:until|once|when)\s+(mt#\d+)\s+(?:ships|lands|completes|merges|is\s+done)\b/gi,
  // "bridge until mt#1700" / "bridge memory until mt#1700"
  /\bbridge\b[^.\n]{0,60}?\buntil\s+(mt#\d+)\b/gi,
  // "superseded by mt#1700" / "subsumed by mt#1700" / "replaced by mt#1700"
  /\b(?:superseded|subsumed|replaced|closed)\s+by\s+(mt#\d+)\b/gi,
  // "structural fix: mt#1700" / "structural fix is mt#1700"
  /\bstructural\s+fix(?:\s+is)?\s*[:\-—]?\s*(mt#\d+)\b/gi,
];

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
  for (const pattern of RETIREMENT_CLAUSE_PATTERNS) {
    // Patterns are module-level and `g`-flagged, so lastIndex persists across calls.
    // Reset before each use rather than relying on exec-to-exhaustion.
    pattern.lastIndex = 0;
    for (const match of haystack.matchAll(pattern)) {
      const captured = match[1];
      if (captured) refs.push(captured.toLowerCase());
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

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((v) => v.toLowerCase()))];
}
