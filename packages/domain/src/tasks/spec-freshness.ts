/**
 * Spec-freshness recheck (mt#2826).
 *
 * Specs cite other tasks (`mt#N`) and PRs (`PR #N` / `#N`). In a fast-moving
 * parallel-agent graph, the state of a cited ref can change between when the
 * spec was authored and when it's consumed at `/implement-task` entry — a
 * dependency ships, a blocker clears, a design assumption a spec relied on no
 * longer holds. Nothing checked for this "consume-time drift" before this
 * task; the agent had to re-derive the dependency landscape manually
 * mid-flight (see mt#2826 spec, evidence conversation eceb6092).
 *
 * This module is the pure detection core: given a spec's content + its
 * `updatedAt` timestamp, extract cited refs and compare each ref's current
 * state timestamp against the spec's `updatedAt`. A ref that changed AFTER
 * the spec was last edited is "drift" — the spec's picture of that ref may be
 * out of date.
 *
 * v1 is deliberately status-mechanical (per the task's Scope): it detects
 * "something about this ref changed since the spec was written," not
 * "the spec's specific claim about this ref is now false" (that would need
 * semantic diffing, out of scope for v1). It requires no LLM call.
 *
 * Known imprecision (documented, not a defect): the task-domain `updatedAt`
 * used here is a general last-modification timestamp on the task's DB row —
 * bumped by ANY mutation (status, title, tags, kind), not exclusively spec
 * content edits (the `task_specs` table tracks spec-content-only edits
 * separately, but `getTaskSpecContentFromParams` surfaces the tasks-table
 * `updatedAt`, matching what `tasks_spec_get` already returns to callers
 * throughout the codebase). Likewise a changeset's `updatedAt` is GitHub's
 * PR `updated_at`, bumped by any PR activity (comments, labels), not
 * exclusively the merge/close event. Both are proxies for "did something
 * change," not surgical status-transition timestamps — acceptable for a v1
 * mechanical check; see the task spec's Scope for the explicit boundary.
 *
 * @see mt#2826 — this file
 * @see packages/domain/src/transcripts/metadata-extractor.ts — the ref
 *   extraction utility this module reuses (already battle-tested by the
 *   transcript-ingest post-pass, mt#1329)
 */

// Deep import (not the `../transcripts` barrel) is deliberate: the barrel
// also re-exports MetadataExtractionPipeline, which pulls a Drizzle query
// module into this file's compile graph for no reason this module needs.
import { extractTaskIds, extractPrNumbers } from "../transcripts/metadata-extractor";

/** A ref's current state, as reported by whichever backend resolved it. */
export interface SpecFreshnessRefLookup {
  status: string;
  /** Absent when the backend doesn't track a last-modified timestamp (e.g. GitHub Issues tasks). */
  updatedAt?: Date;
}

/**
 * Injected lookups — kept as plain async callbacks (not a `TaskServiceInterface`
 * or a changeset-service instance) so this module stays a pure, easily-testable
 * detection core. The command layer wires these to the same `getTaskFromParams`
 * / `changesetService.get` primitives every other read-only tasks/changeset
 * command already uses.
 */
export interface SpecFreshnessDeps {
  /** Resolve a cited task ref's (`mt#N`) current status + updatedAt. Return `null` if not found. */
  getTaskInfo: (refTaskId: string) => Promise<SpecFreshnessRefLookup | null>;
  /** Resolve a cited PR ref's current status + updatedAt. Return `null` if not found. */
  getChangesetInfo: (prNumber: string) => Promise<SpecFreshnessRefLookup | null>;
}

export interface SpecFreshnessDriftEntry {
  /** Human-readable ref label, e.g. `"mt#2812"` or `"PR #1234"`. */
  ref: string;
  kind: "task" | "pr";
  currentStatus: string;
  /** ISO-8601 timestamp of the ref's last known change. */
  refUpdatedAt: string;
  /** Days between the spec's `updatedAt` and the ref's `updatedAt` (positive, rounded to 1dp). */
  daysSinceSpecEdit: number;
}

export interface SpecFreshnessResult {
  taskId: string;
  /** ISO-8601, or `null` when the citing spec itself has no tracked `updatedAt`. */
  specUpdatedAt: string | null;
  /** Refs whose current state changed after the citing spec was last edited. Empty when clean. */
  drift: SpecFreshnessDriftEntry[];
  hasDrift: boolean;
  /** Refs that could not be checked (ref not found, or backend doesn't track updatedAt), with why. */
  skipped: Array<{ ref: string; reason: string }>;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(earlier: Date, later: Date): number {
  return Math.round(((later.getTime() - earlier.getTime()) / MS_PER_DAY) * 10) / 10;
}

/**
 * Check whether the refs cited in a task's spec have drifted (changed state)
 * since the spec was last edited.
 *
 * @param taskId - the citing task's own ID (excluded from its own ref list —
 *   a spec that quotes its own task ID, e.g. in a title echo, is not self-drift).
 * @param specContent - the spec's markdown body, scanned for `mt#N` / `#N` refs.
 * @param specUpdatedAt - the citing spec's last-modified timestamp. When
 *   `undefined` (backend doesn't track it), no baseline exists to compare
 *   against — the check is skipped entirely (returns zero drift, not an error).
 * @param deps - injected ref-resolution callbacks (see {@link SpecFreshnessDeps}).
 */
export async function checkSpecFreshness(
  taskId: string,
  specContent: string,
  specUpdatedAt: Date | undefined,
  deps: SpecFreshnessDeps
): Promise<SpecFreshnessResult> {
  if (!specUpdatedAt) {
    return {
      taskId,
      specUpdatedAt: null,
      drift: [],
      hasDrift: false,
      skipped: [{ ref: "*", reason: "spec has no tracked updatedAt (backend does not track it)" }],
    };
  }

  const taskRefs = extractTaskIds(specContent).filter((ref) => ref !== taskId);
  const prNumbers = extractPrNumbers(specContent);

  const drift: SpecFreshnessDriftEntry[] = [];
  const skipped: Array<{ ref: string; reason: string }> = [];

  for (const ref of taskRefs) {
    try {
      const info = await deps.getTaskInfo(ref);
      if (!info) {
        skipped.push({ ref, reason: "task not found" });
        continue;
      }
      if (!info.updatedAt) {
        skipped.push({ ref, reason: "no updatedAt tracked for this task's backend" });
        continue;
      }
      if (info.updatedAt.getTime() > specUpdatedAt.getTime()) {
        drift.push({
          ref,
          kind: "task",
          currentStatus: info.status,
          refUpdatedAt: info.updatedAt.toISOString(),
          daysSinceSpecEdit: daysBetween(specUpdatedAt, info.updatedAt),
        });
      }
    } catch (err) {
      skipped.push({ ref, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const num of prNumbers) {
    const ref = `PR #${num}`;
    try {
      const info = await deps.getChangesetInfo(String(num));
      if (!info) {
        skipped.push({ ref, reason: "PR not found" });
        continue;
      }
      if (!info.updatedAt) {
        skipped.push({ ref, reason: "no updatedAt tracked for this changeset's platform" });
        continue;
      }
      if (info.updatedAt.getTime() > specUpdatedAt.getTime()) {
        drift.push({
          ref,
          kind: "pr",
          currentStatus: info.status,
          refUpdatedAt: info.updatedAt.toISOString(),
          daysSinceSpecEdit: daysBetween(specUpdatedAt, info.updatedAt),
        });
      }
    } catch (err) {
      skipped.push({ ref, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    taskId,
    specUpdatedAt: specUpdatedAt.toISOString(),
    drift,
    hasDrift: drift.length > 0,
    skipped,
  };
}
