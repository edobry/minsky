/**
 * Trigger 3 — task-STATE assertions (mt#4743).
 *
 * Triggers 1 and 2 detect a memory that declares its own expiry: a retirement clause
 * ("Budget: retire when mt#X ships"), or a dated measurement whose subsystem moved under it.
 * The most common thing a long-lived family root actually contains is NEITHER. It is a
 * **statement about another task's state** — its status, its scope, what it can currently
 * observe. Lineage sections are almost entirely such statements, and they rot silently: the
 * sentence was true when written and nothing re-derives it.
 *
 * ## The originating incident
 *
 * `/plan-task mt#1873` fetched mem#367 by id and carried forward its description of Surface 4
 * as "still blind", writing it into a spec as current fact. The analyzer had shipped twelve
 * days earlier. Neither shipped trigger could see it: mem#367 declares no retirement clause
 * about ITSELF, and the sentence carries no dated measurement.
 *
 * ## Why the pattern set is this narrow — measured, not invented
 *
 * SC2 requires the pattern set be "stated with its basis". Measured over the live corpus
 * (1,339 memories, 2026-08-30):
 *
 * | Candidate form | Memories | Shipped? |
 * | --- | --- | --- |
 * | `mt#N (STATUS)` — parenthetical | 120 (9.0%) | **yes** |
 * | `mt#N is/was still\|now\|scoped\|already …` | 53 (4.0%) | no |
 * | `mt#N remains …` | 9 (0.7%) | no |
 *
 * The split is not by frequency, it is by **checkability**. The parenthetical form names a
 * status TOKEN, so the claim can be compared against the task record and a mismatch is a
 * FACT. "mt#4196 is still blind" names no status — deciding whether it is now false requires
 * reading what "blind" meant, which is a judgment no comparison can make. Shipping only the
 * checkable form is what keeps this trigger's precision a property of the mechanism rather
 * than of a heuristic that has to be calibrated.
 *
 * And the checkable form is worth having on its own. Of **174** parenthetical claims across
 * those 120 memories: **121 still accurate, 53 (30.5%) now WRONG**, of which **47** assert a
 * non-terminal status for a task that has since reached DONE or CLOSED. Zero refs failed to
 * resolve. Roughly a third of the explicit status claims in this corpus are false, which is
 * the population this trigger exists for.
 *
 * ## Two deliberate non-behaviors
 *
 * 1. **This never touches `extractTrackingTaskRefs`.** That function has a SECOND consumer:
 *    `memory.create` derives `associations.tracksTask` from it (mt#4448), and the read path
 *    then takes the association fast path without ever re-scanning the text. A false match
 *    there is minted once into structured data and is immune to every later fix (mt#4765).
 *    Trigger 3 is a sibling of trigger 2's `annotateMeasurementDecay` — read-path only — so
 *    its worst case is a transient advisory a reader dismisses, not a permanent association.
 * 2. **No quotation prefilter.** A status claim inside a code fence or a blockquote will
 *    match. That defect class is real and is owned by mt#4454 (gated on mt#4386's prose-
 *    quotation primitive); this trigger should adopt that primitive when it lands. It is
 *    tolerable here for exactly the reason in (1): the annotation is advisory and
 *    per-response, and it is NOT written back anywhere.
 *
 * @see mt#4743 — this trigger's originating task
 * @see mt#4765 — why this stays off the write path
 * @see mt#4454 — the quotation prefilter this should consume when it exists
 */

/** The task statuses a memory can assert, exactly as the task record spells them. */
const ASSERTABLE_STATUSES = [
  "TODO",
  "PLANNING",
  "READY",
  "IN-PROGRESS",
  "IN-REVIEW",
  "DONE",
  "CLOSED",
  "BLOCKED",
] as const;

/**
 * `mt#N (STATUS` — the closing paren is deliberately NOT required.
 *
 * The corpus routinely qualifies the status inside the same parenthetical: "mt#4141 (DONE
 * 2026-08-14, PR #2998)", "mt#2052 (PLANNING, stalled ~83 days as of 2026-08-03)". Anchoring
 * on the closing paren would miss both, and those annotated forms are if anything MORE likely
 * to be stale than a bare one — they are what a lineage section is made of.
 */
const PARENTHETICAL_STATUS = new RegExp(
  `\\b(mt#\\d+)\\s*\\(\\s*(${ASSERTABLE_STATUSES.join("|")})\\b`,
  "gi"
);

/** One `mt#N (STATUS)` claim found in a memory's text. */
export interface TaskStateAssertion {
  taskId: string;
  /** The status the memory asserts, upper-cased. */
  assertedStatus: string;
}

/** A claim whose asserted status no longer matches the task record. */
export interface DriftedAssertion extends TaskStateAssertion {
  currentStatus: string;
  /** True when the task has since reached a terminal state — the highest-value subset. */
  nowTerminal: boolean;
}

export interface TaskStateDrift {
  drifted: DriftedAssertion[];
}

const TERMINAL_STATUSES = new Set(["DONE", "CLOSED"]);

/**
 * Extract every `mt#N (STATUS)` claim from a record's description + content.
 *
 * Deduplicated on (taskId, assertedStatus): a lineage section naming the same task at the
 * same status twice is one claim, not two, and rendering it twice would be noise. The SAME
 * task asserted at DIFFERENT statuses is deliberately kept as two — that is a record
 * contradicting itself, which is worth surfacing rather than collapsing.
 */
export function extractTaskStateAssertions(record: {
  description?: string | null;
  content: string;
}): TaskStateAssertion[] {
  const haystack = `${record.description ?? ""}\n${record.content}`;
  const seen = new Set<string>();
  const assertions: TaskStateAssertion[] = [];

  PARENTHETICAL_STATUS.lastIndex = 0;
  for (const match of haystack.matchAll(PARENTHETICAL_STATUS)) {
    const taskId = match[1]?.toLowerCase();
    const assertedStatus = match[2]?.toUpperCase();
    if (!taskId || !assertedStatus) continue;

    const key = `${taskId}::${assertedStatus}`;
    if (seen.has(key)) continue;
    seen.add(key);
    assertions.push({ taskId, assertedStatus });
  }

  return assertions;
}

/**
 * Compare asserted statuses against the task record.
 *
 * `statuses` maps a task id to its current status, or `undefined` when unresolvable. An
 * unresolvable ref yields NO drift finding: unlike trigger 1 — where an unknown id means "we
 * could not check whether this memory expired" and must stay visible as `unresolved` — here
 * an unknown id means the memory cites a task the graph cannot account for, which is a
 * different defect and not this trigger's to report. Silence is correct; a made-up mismatch
 * would not be.
 */
export function computeTaskStateDrift(
  assertions: TaskStateAssertion[],
  statuses: ReadonlyMap<string, string | undefined>
): TaskStateDrift | undefined {
  const drifted: DriftedAssertion[] = [];

  for (const assertion of assertions) {
    const current = statuses.get(assertion.taskId) ?? statuses.get(assertion.taskId.toLowerCase());
    if (current === undefined) continue;

    const currentStatus = current.toUpperCase();
    if (currentStatus === assertion.assertedStatus) continue;

    drifted.push({
      ...assertion,
      currentStatus,
      nowTerminal: TERMINAL_STATUSES.has(currentStatus),
    });
  }

  return drifted.length > 0 ? { drifted } : undefined;
}

/**
 * Render the reader-facing note.
 *
 * Says what the record CLAIMS and what is TRUE, both, because the reader's next action
 * depends on which claim moved — and names the terminal case explicitly, since a task that
 * has completed is the case where a memory's prescription is most likely to be obsolete
 * rather than merely dated.
 */
export function renderTaskStateNote(drift: TaskStateDrift): string {
  const lines = drift.drifted.map((d) => {
    const terminal = d.nowTerminal ? ", which is terminal" : "";
    return `  • this record says ${d.taskId} is ${d.assertedStatus}; it is now ${d.currentStatus}${terminal}.`;
  });

  const anyTerminal = drift.drifted.some((d) => d.nowTerminal);
  const head = anyTerminal
    ? "⚠️ POSSIBLY OBSOLETE — this memory asserts a task status that has since changed, and the task has completed."
    : "⚠️ STATUS DRIFT — this memory asserts a task status that no longer matches the task record.";

  return `${head}\n${lines.join("\n")}\nThe assertion was accurate when written; re-derive before relying on it.`;
}

/** Every task id this record makes a status claim about — for unioning into one lookup. */
export function assertedTaskIds(assertions: TaskStateAssertion[]): string[] {
  return [...new Set(assertions.map((a) => a.taskId))];
}
