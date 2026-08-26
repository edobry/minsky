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
 * Known imprecision, on BOTH sides of the comparison. The two sides are not
 * symmetric, and the asymmetry is the point: REF-side noise produces spurious
 * drift rows — a false positive, costing one `tasks_get` to dismiss — while
 * BASELINE-side noise suppresses every row at once, costing the whole check
 * and reporting a clean pass while doing it.
 *
 * Ref side (false positives): a changeset's `updatedAt` is GitHub's PR
 * `updated_at`, bumped by any PR activity (comments, labels), not exclusively
 * the merge/close event; a cited task's `updatedAt` is likewise its entire DB
 * row's timestamp. Both are proxies for "did something change," not surgical
 * status-transition timestamps — acceptable for a mechanical check.
 *
 * Baseline side (false negatives): the baseline was the citing task's
 * tasks-table `updatedAt` until mt#4415, which ANY mutation bumps — so a status
 * transition shortly before the check moved it to ~now, no ref could be newer
 * than it, and `hasDrift: false` came back regardless of the state of the
 * world. That ordering is not exotic: `/plan-task`'s Step 1 IS a status
 * transition, so the check was vacuous in the workflow most likely to call it.
 * Observed 2026-08-22, hiding a real three-day-old drift.
 *
 * mt#4415 moved it to the spec-CONTENT timestamp (`task_specs.updated_at`),
 * which fixed that case and left its sibling: `updated_at` advances on ANY
 * spec-content write, so editing one section reset the baseline for the whole
 * document and hid every ref whose drift predated your own edit.
 *
 * mt#4420 closes it by comparing against a FLOOR that no edit moves — the
 * spec's authoring timestamp (`task_specs.created_at`, set once at insert and
 * never re-set by the update paths) — and reporting where each drifted ref
 * falls relative to the last edit rather than suppressing the ones beneath it:
 *
 *   authored ──────────── last edited ──────────── now
 *            [precedesLastSpecEdit: true]  [false]
 *            was INVISIBLE until mt#4420    always reported
 *
 * Why a floor rather than per-claim provenance, which would be more precise:
 * the schema carries no per-claim timestamp, and adding one means a migration
 * plus a change at all three spec-write paths — the same paths mt#4642 is
 * independently reworking to add a spec-write event. This fix reads two columns
 * that already exist on a row already being fetched. The precise version stays
 * open, and mt#4642's ledger is the natural substrate for it.
 *
 * What it costs, measured on prod (4,535 specs; 28,988 cited refs) before the
 * change: mean drift rows per spec rises 2.32 -> 3.79. What it buys, same
 * corpus: of 566 specs reporting a CLEAN PASS, 244 (43%) had a ref that had
 * drifted since authoring — and among specs authored in the last 7 days, the
 * population where this check actually runs, 29 of 41 clean passes (71%) were
 * false. That trade is the direction this docblock's own asymmetry prescribes:
 * a spurious row costs one `tasks_get` to dismiss, a suppressed one costs the
 * whole check while reporting a clean pass.
 *
 * What the floor still cannot see, and it is bounded: 360 of 4,535 specs (7.9%)
 * were created in the `task_specs` backfill of 2025-08-21, so for those
 * `created_at` is the migration date rather than true authoring, and drift
 * between the two remains invisible. Every other creation date is genuinely
 * spread (146 distinct days, no other above 101).
 *
 * When NO baseline exists at all, the check does not run. That case is reported
 * as `checked: false` (see {@link SpecFreshnessResult}) precisely so it stays
 * distinguishable from a clean pass instead of collapsing into `hasDrift:
 * false` — a check that could not run must never read as a check that passed.
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
  /**
   * Days between the spec's LAST EDIT and the ref's `updatedAt`, rounded to 1dp.
   *
   * **Signed as of mt#4420.** It was positive by construction while the last
   * edit was also the detection floor; now that the floor is the AUTHORING
   * timestamp, a ref can legitimately sit between the two and report a NEGATIVE
   * value — "this drifted N days before the spec was last written". Read the
   * sign, or read {@link precedesLastSpecEdit}, which says the same thing
   * without arithmetic.
   */
  daysSinceSpecEdit: number;
  /**
   * Whether this ref changed STRICTLY before the spec's last edit (mt#4420).
   *
   * A ref stamped at the exact same instant as the last edit reports `false`:
   * it did not precede anything, and the same tie convention governs the floor
   * comparison, where a ref exactly at the floor is not drift.
   *
   * `true` is the class that was INVISIBLE before mt#4420 and is the reason
   * this check was reporting false clean passes: the drift is real, it happened
   * while the spec already existed, and whoever last edited the spec did not
   * necessarily see it — an edit to one section silently vouched for the whole
   * document. Treat these as needing the same disposition as any other drift
   * row; they are not a lower tier of finding.
   *
   * `false` is the ordinary case — the ref changed after the last edit.
   */
  precedesLastSpecEdit: boolean;
}

export interface SpecFreshnessResult {
  taskId: string;
  /** ISO-8601 spec-CONTENT timestamp (last edit), or `null` when unavailable. */
  specUpdatedAt: string | null;
  /**
   * ISO-8601 spec AUTHORING timestamp — the detection floor (mt#4420), or
   * `null` when the backend tracks none.
   *
   * When this is present it, not `specUpdatedAt`, is what a ref is compared
   * against. When it is absent the check falls back to `specUpdatedAt` and
   * behaves exactly as it did before mt#4420 — narrower, not broken. Read
   * {@link baselineUsed} rather than inferring which happened.
   */
  specCreatedAt: string | null;
  /**
   * Which timestamp the comparison actually used (mt#4420).
   *
   * `"spec-authored"` is the full check. `"spec-last-edited"` is the degraded
   * one — no authoring timestamp was available, so drift predating the last
   * edit is still invisible and a clean result is correspondingly weaker
   * evidence. Reported rather than inferred so a caller never has to guess
   * which of the two it is looking at.
   *
   * **`null` when `checked` is false** (PR #3389 R2): no comparison ran, so
   * there is no baseline to name. Naming one anyway would be this module's own
   * documented hazard turned on itself — a field that manufactures a plausible
   * value where it has no information, indistinguishable from a real answer.
   * Same reason `checked` exists at all (mt#4415).
   */
  baselineUsed: "spec-authored" | "spec-last-edited" | null;
  /**
   * Whether a comparison actually ran (mt#4415).
   *
   * `false` means NO baseline existed, so nothing was compared and nothing
   * could have been found. Read this BEFORE `hasDrift`: `hasDrift: false` with
   * `checked: false` is "not checked", not "clean". They are reported as two
   * fields rather than one tri-state so that no existing consumer of
   * `hasDrift` silently changes meaning.
   */
  checked: boolean;
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
 * The two spec-side timestamps this check reads (mt#4420).
 *
 * Deliberately ONE named object rather than two positional `Date | undefined`
 * parameters: they are the same type and would sit adjacent in the argument
 * list, so a positional pair can be transposed with nothing to catch it — and
 * transposing THESE two silently reinstates the exact defect mt#4420 removes,
 * because the floor becomes the last-edit timestamp again. Named fields make
 * that mistake unrepresentable rather than merely unlikely.
 */
export interface SpecFreshnessBaseline {
  /** `task_specs.updated_at` — when the spec text was last written. */
  updatedAt?: Date;
  /**
   * `task_specs.created_at` — when the spec was first authored. The detection
   * FLOOR: written once at insert and never re-set by any update path, so an
   * edit to one section cannot move it.
   */
  createdAt?: Date;
}

/**
 * Check whether the refs cited in a task's spec have drifted (changed state)
 * since the spec was AUTHORED, and report which of them drifted before its last
 * edit.
 *
 * @param taskId - the citing task's own ID (excluded from its own ref list —
 *   a spec that quotes its own task ID, e.g. in a title echo, is not self-drift).
 * @param specContent - the spec's markdown body, scanned for `mt#N` / `#N` refs.
 * @param baseline - the spec's authoring + last-edit timestamps (see
 *   {@link SpecFreshnessBaseline}). Comparison runs against `createdAt` when
 *   present, falling back to `updatedAt`; `updatedAt` then classifies each
 *   reported ref. Neither is the task ROW's `updatedAt`, which any status
 *   transition bumps — that was the mt#4415 defect. When BOTH are absent no
 *   baseline exists, the check does not run, and the result carries
 *   `checked: false` — not an error, and not a clean pass.
 * @param deps - injected ref-resolution callbacks (see {@link SpecFreshnessDeps}).
 */
export async function checkSpecFreshness(
  taskId: string,
  specContent: string,
  baseline: SpecFreshnessBaseline,
  deps: SpecFreshnessDeps
): Promise<SpecFreshnessResult> {
  const { updatedAt: specUpdatedAt, createdAt: specCreatedAt } = baseline;

  // The FLOOR decides what gets REPORTED; the last edit only decides how a
  // reported ref is LABELLED. Preferring `createdAt` here is the whole of
  // mt#4420 — everything else in this function is bookkeeping around it.
  const floor = specCreatedAt ?? specUpdatedAt;
  // When no last-edit timestamp exists the floor stands in, so every entry
  // reports `precedesLastSpecEdit: false`. That is accurate rather than a
  // fallback: with no recorded edit there is nothing for a ref to precede.
  const lastEdit = specUpdatedAt ?? specCreatedAt;

  if (!floor || !lastEdit) {
    return {
      taskId,
      specUpdatedAt: null,
      specCreatedAt: null,
      // Nothing was compared, so no baseline was used. See the field's docblock.
      baselineUsed: null,
      checked: false,
      drift: [],
      hasDrift: false,
      skipped: [
        {
          ref: "*",
          reason:
            "no spec-content timestamp for this task's backend — no baseline to compare against, so no refs were checked",
        },
      ],
    };
  }

  const taskRefs = extractTaskIds(specContent).filter((ref) => ref !== taskId);
  const prNumbers = extractPrNumbers(specContent);

  const drift: SpecFreshnessDriftEntry[] = [];
  const skipped: Array<{ ref: string; reason: string }> = [];

  // Shared by both loops so the floor comparison and the classification cannot
  // drift apart between task refs and PR refs — they did not before only
  // because the two blocks were kept identical by hand.
  const driftEntryFor = (
    ref: string,
    kind: "task" | "pr",
    status: string,
    refUpdatedAt: Date
  ): SpecFreshnessDriftEntry => ({
    ref,
    kind,
    currentStatus: status,
    refUpdatedAt: refUpdatedAt.toISOString(),
    daysSinceSpecEdit: daysBetween(lastEdit, refUpdatedAt),
    // STRICTLY before. A ref stamped at the exact same instant as the last edit
    // is not "before" it, and the command renders this count as "BEFORE the
    // spec was last edited" — so `<=` would make that sentence false for the
    // equality case. Ties resolving to `false` also matches the floor
    // comparison above, which is likewise strict: a ref exactly AT the floor is
    // not drift. One convention, both boundaries.
    precedesLastSpecEdit: refUpdatedAt.getTime() < lastEdit.getTime(),
  });

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
      if (info.updatedAt.getTime() > floor.getTime()) {
        drift.push(driftEntryFor(ref, "task", info.status, info.updatedAt));
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
      if (info.updatedAt.getTime() > floor.getTime()) {
        drift.push(driftEntryFor(ref, "pr", info.status, info.updatedAt));
      }
    } catch (err) {
      skipped.push({ ref, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    taskId,
    specUpdatedAt: specUpdatedAt?.toISOString() ?? null,
    specCreatedAt: specCreatedAt?.toISOString() ?? null,
    baselineUsed: specCreatedAt ? "spec-authored" : "spec-last-edited",
    checked: true,
    drift,
    hasDrift: drift.length > 0,
    skipped,
  };
}
