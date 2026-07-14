#!/usr/bin/env bun
/**
 * Pure classification logic for scripts/migrate-task-kinds.ts (mt#2761).
 *
 * Extracted into its own module so `classifyTaskKind` can be unit-tested
 * without booting the Postgres connection the parent script requires.
 *
 * ## Promote-only semantics (mt#2761)
 *
 * A task whose CURRENT kind is not "implementation" is NEVER changed by this
 * classifier, regardless of what the hasChildren/hasPr heuristic below would
 * otherwise propose. This protects deliberate manual classifications — e.g.
 * `kind: "state-ops"` (mt#2661) or a hand-set `kind: "umbrella"` on a leaf
 * task (mt#1451 reclassification) — that predate or fall outside the
 * heuristic's signal. Prior to this change, a re-run of the backfill would
 * silently DEMOTE those tasks back to "implementation" because the heuristic
 * only ever computes "umbrella" or "implementation" and does not know about
 * any other kind.
 *
 * Only "implementation" (the default kind, and the kind every task had
 * before mt#1812 shipped) is eligible for promotion to "umbrella".
 */

/** The three possible dispositions the classifier can reach for a task. */
export type ClassificationAction = "promote" | "skip-non-default-kind" | "no-change";

export interface ClassificationInput {
  taskId: string;
  /** Raw `kind` column value; null/undefined defaults to "implementation". */
  currentKind: string | null | undefined;
  /** Task appears as `toTaskId` in a `parent`-type relationship. */
  hasChildren: boolean;
  /** Any session linked to this task has a non-null `prBranch` or `prState`. */
  hasPr: boolean;
}

export interface ClassificationResult {
  taskId: string;
  /** Normalized current kind (defaults to "implementation" when unset). */
  currentKind: string;
  /** What the hasChildren/hasPr heuristic alone would suggest. */
  heuristicKind: string;
  /** The kind the script would actually write (--execute) or propose (dry-run). */
  proposedKind: string;
  action: ClassificationAction;
  /** True only for action === "promote" — the only case that writes to the DB. */
  changed: boolean;
  reason: string;
}

/**
 * Classify a single task's kind using the promote-only heuristic.
 *
 * Heuristic (unchanged from the original mt#1812 backfill):
 *   umbrella        when hasChildren AND NOT hasPr
 *   implementation  otherwise
 *
 * Promote-only guard (mt#2761): the heuristic result is only ever APPLIED
 * when the task's current kind is "implementation". Any other current kind
 * is left untouched — the heuristic's suggestion is reported for visibility
 * (dry-run "skipped" line) but never written.
 */
export function classifyTaskKind(input: ClassificationInput): ClassificationResult {
  const currentKind = input.currentKind || "implementation";
  const heuristicKind = input.hasChildren && !input.hasPr ? "umbrella" : "implementation";

  if (currentKind !== "implementation") {
    if (heuristicKind !== currentKind) {
      return {
        taskId: input.taskId,
        currentKind,
        heuristicKind,
        proposedKind: currentKind,
        action: "skip-non-default-kind",
        changed: false,
        reason:
          `manually classified as "${currentKind}"; heuristic would suggest ` +
          `"${heuristicKind}" — preserving manual classification (promote-only, mt#2761)`,
      };
    }
    return {
      taskId: input.taskId,
      currentKind,
      heuristicKind,
      proposedKind: currentKind,
      action: "no-change",
      changed: false,
      reason: `already "${currentKind}" and heuristic agrees — no change needed`,
    };
  }

  if (heuristicKind === "umbrella") {
    return {
      taskId: input.taskId,
      currentKind,
      heuristicKind,
      proposedKind: "umbrella",
      action: "promote",
      changed: true,
      reason: "has child tasks and no associated PR",
    };
  }

  return {
    taskId: input.taskId,
    currentKind,
    heuristicKind,
    proposedKind: "implementation",
    action: "no-change",
    changed: false,
    reason:
      input.hasChildren && input.hasPr
        ? "has child tasks but also has an associated PR — keeping as implementation"
        : "default: no special signals",
  };
}
