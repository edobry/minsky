/**
 * mt#5044's one known true positive, verbatim.
 *
 * mt#5042 was created 2026-09-09 with a title about `CLAUDE.md`'s compaction DROP LIST over a
 * spec about compaction's TRIGGER, and corrected minutes later. Both strings below are verbatim
 * from that `tasks_edit` call's recorded `previousValues` / new value — read from the authoring
 * conversation's transcript, not from a later account of it.
 *
 * Shared by the test and the measurement shell so the fixture cannot drift between the thing
 * that asserts it fires and the thing that measures what firing would cost.
 */

/** The title as filed — about the drop list. */
export const MT5042_WRONG_TITLE =
  'CLAUDE.md §Compact Instructions tells compaction to drop "resolved debugging steps", ' +
  "which also drops the dead ends a successor then retries";

/** The corrected title — about the trigger, which is what the spec is about. */
export const MT5042_CORRECT_TITLE =
  "Compaction is triggered by context exhaustion rather than by a work boundary, so it lands " +
  "mid-narrative after paying the maximum re-upload tail";

/** The task whose spec both titles sat over. */
export const MT5042_TASK_ID = "mt#5042";
