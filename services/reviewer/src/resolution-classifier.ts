/**
 * "Argued out of BLOCKING" resolution classification (mt#3300 SC#1).
 *
 * At APPROVE time, `findings.ts`'s `resolveOutstandingFindingsOnApproval`
 * (mt#3295 SC#2) marks every still-open (disposition IS NULL) BLOCKING
 * finding from an earlier round `unknown` — a deliberately coarse, safe
 * default, since mt#3295 explicitly left the deeper classification (fixed by
 * code vs. argued away without one) to this task.
 *
 * This module supersedes that coarse default at the live call site
 * (`review-finalize.ts`): for each such finding, it determines whether ANY
 * commit between the finding's own round (its `headSha`) and the APPROVE
 * round's head touched the finding's cited `file`. Touched -> a genuine code
 * change addressed it (`fixed-by-code-change`); untouched ->
 * `resolved-without-code-change` — the "argued out of BLOCKING" case named
 * in the mt#3295 spec's Measured corpus results §2 (PR #1798-family,
 * PR #2235's "not wired into CI" finding approved on script-robustness prose
 * with no CI-wiring commit at all).
 *
 * Sealed: no imports from src/.
 */

import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import type { ReviewerDb } from "./db/client";
import { reviewerFindingsTable, type FindingDisposition } from "./db/schemas/findings-schema";
import { extractPgErrorContext } from "./webhook-events";
import { log } from "./logger";

/** One changed file between two commits — matches `github-client.ts`'s `ChangedFileEntry`. */
export interface ChangedFileEntry {
  filename: string;
}

/**
 * Injectable diff-fetcher: returns the files changed between `baseSha` and
 * `headSha`, or `undefined` when the comparison could not be computed (API
 * failure, unreachable SHA pair after a force-push). Production callers pass
 * a closure over `github-client.ts`'s `fetchChangedFilesSince`; tests inject
 * a fixture function.
 */
export type ChangedFilesFetcherFn = (
  baseSha: string,
  headSha: string
) => Promise<ReadonlyArray<ChangedFileEntry> | undefined>;

/**
 * True when `file` appears in the changed-files list. Pure function.
 * Exported for unit testing.
 */
export function isFileTouched(
  changedFiles: ReadonlyArray<ChangedFileEntry>,
  file: string
): boolean {
  return changedFiles.some((f) => f.filename === file);
}

/**
 * Classify a finding's resolution from the single diff-mining signal SC#1
 * defines: was the cited file touched since the finding's round? Pure
 * function. Exported for unit testing.
 */
export function classifyFindingResolution(fileTouched: boolean): FindingDisposition {
  return fileTouched ? "fixed-by-code-change" : "resolved-without-code-change";
}

export interface ClassifyOutstandingFindingsParams {
  prOwner: string;
  prRepo: string;
  prNumber: number;
  /** The APPROVING round's 1-based index; only rows with round < this are eligible. */
  approvingRound: number;
  /** PR HEAD sha at APPROVE time — the upper bound for the diff-touched check. */
  approvingHeadSha: string;
}

/**
 * Classify each still-open (disposition IS NULL) prior BLOCKING finding on a
 * PR that just converged (event === APPROVE) as `fixed-by-code-change` or
 * `resolved-without-code-change`, based on whether any commit between the
 * finding's own round `headSha` and `params.approvingHeadSha` touched the
 * finding's cited `file` (mt#3300 SC#1).
 *
 * Scoping mirrors `resolveOutstandingFindingsOnApproval` exactly (same row
 * set: `severity = 'BLOCKING' AND disposition IS NULL AND round <
 * approvingRound`, same PR) — this function classifies that set more
 * precisely instead of stamping it `unknown`.
 *
 * Findings are grouped by `headSha` before fetching, so a round that raised
 * several findings costs only ONE diff fetch, not one per finding. On a
 * fetch failure for a given `headSha` group (or the defensive same-sha edge
 * case), those findings fall back to `unknown` — the pre-mt#3300 safe
 * default — rather than guessing.
 *
 * No-ops when there are no eligible rows. Wrapped in try/catch at the top
 * level — logs on failure but never throws; reviews proceed regardless of
 * classification failures (mirrors every other write path in findings.ts).
 */
export async function classifyOutstandingFindings(
  db: ReviewerDb,
  params: ClassifyOutstandingFindingsParams,
  fetchChangedFiles: ChangedFilesFetcherFn
): Promise<void> {
  try {
    const rows = await db
      .select({
        id: reviewerFindingsTable.id,
        file: reviewerFindingsTable.file,
        headSha: reviewerFindingsTable.headSha,
      })
      .from(reviewerFindingsTable)
      .where(
        and(
          eq(reviewerFindingsTable.prOwner, params.prOwner),
          eq(reviewerFindingsTable.prRepo, params.prRepo),
          eq(reviewerFindingsTable.prNumber, params.prNumber),
          eq(reviewerFindingsTable.severity, "BLOCKING"),
          isNull(reviewerFindingsTable.disposition),
          lt(reviewerFindingsTable.round, params.approvingRound)
        )
      );

    if (rows.length === 0) return;

    // Group finding ids by the round headSha they were raised against, to
    // minimize diff fetches.
    const byHeadSha = new Map<string, Array<{ id: string; file: string }>>();
    for (const row of rows) {
      const list = byHeadSha.get(row.headSha) ?? [];
      list.push({ id: row.id, file: row.file });
      byHeadSha.set(row.headSha, list);
    }

    const idsByDisposition = new Map<FindingDisposition, string[]>();
    const addIds = (disposition: FindingDisposition, entries: Array<{ id: string }>): void => {
      const list = idsByDisposition.get(disposition) ?? [];
      for (const entry of entries) list.push(entry.id);
      idsByDisposition.set(disposition, list);
    };

    for (const [headSha, findings] of byHeadSha) {
      // mt#3300 PR #2394 R1 BLOCKING #1: if the finding's own round headSha
      // equals the APPROVING round's headSha, there is NO commit window to
      // examine at all (zero commits separate them) — most plausibly a
      // stale/duplicate headSha or a same-round classification pass, not
      // proof the file went untouched. Asserting `resolved-without-code-change`
      // here would be an unsupported "argued out" accusation with zero
      // evidence behind it; classify as the safe `unknown` default instead
      // WITHOUT calling the fetcher (there is nothing to compare).
      if (headSha === params.approvingHeadSha) {
        addIds("unknown", findings);
        continue;
      }

      let changedFiles: ReadonlyArray<ChangedFileEntry> | undefined;
      try {
        changedFiles = await fetchChangedFiles(headSha, params.approvingHeadSha);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("finding_resolution_classify_fetch_error", {
          event: "finding_resolution_classify_fetch_error",
          prOwner: params.prOwner,
          prRepo: params.prRepo,
          prNumber: params.prNumber,
          headSha,
          error: message,
        });
      }

      if (changedFiles === undefined) {
        addIds("unknown", findings);
        continue;
      }

      for (const finding of findings) {
        const disposition = classifyFindingResolution(isFileTouched(changedFiles, finding.file));
        addIds(disposition, [finding]);
      }
    }

    for (const [disposition, ids] of idsByDisposition) {
      if (ids.length === 0) continue;
      await db
        .update(reviewerFindingsTable)
        .set({ disposition, dispositionSetAt: new Date() })
        .where(inArray(reviewerFindingsTable.id, ids));
    }
  } catch (err: unknown) {
    log.error("finding_resolution_classify_error", {
      event: "finding_resolution_classify_error",
      ...extractPgErrorContext(err),
      prOwner: params.prOwner,
      prRepo: params.prRepo,
      prNumber: params.prNumber,
    });
    // Intentionally swallow — reviews proceed regardless of classification failures.
  }
}
