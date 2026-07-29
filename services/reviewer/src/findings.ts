/**
 * Reviewer finding persistence (mt#3295 SC#1 + SC#2).
 *
 * Converts a review round's findings — either the model's own structured
 * `submit_finding` tool calls (output-tools path) or a parsed review body
 * (prose path / historical backfill) — into `reviewer_findings` rows, and
 * populates the per-finding `disposition` field with the cheap signals
 * already computed by the existing recovery/convergence-detector passes.
 *
 * Deliberately NOT the full argued-out-of-BLOCKING classifier (mt#3300's
 * job): this module only wires two cheap, already-computed signals —
 * "a structural recovery pass downgraded this finding" (bypassed) and "this
 * PR converged and the finding is gone" (unknown) — leaving the deeper
 * fixed-by-code-change / dismissed-as-FP / resolved-without-code-change
 * classification (which requires diff-mining, per
 * scripts/mine-ground-truth-corpus.ts's `deriveLabel`) for mt#3300.
 *
 * Errors are swallowed — finding-persistence failures MUST NOT propagate to
 * the review path, mirroring metrics.ts's recordConvergenceMetric contract.
 *
 * Sealed: no imports from src/.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { ReviewerDb } from "./db/client";
import {
  reviewerFindingsTable,
  VALID_FINDING_SEVERITIES,
  VALID_FINDING_DISPOSITIONS,
  type FindingDisposition,
} from "./db/schemas/findings-schema";
import { extractPgErrorContext } from "./webhook-events";
import { parseFindingsFromBody, type FlatFinding } from "./replay-summary";
import type { ReviewToolCall } from "./output-tools";
import { log } from "./logger";
import { safeTruncate } from "@minsky/shared/safe-truncate";

// ---------------------------------------------------------------------------
// Shared context + input shapes
// ---------------------------------------------------------------------------

/** Fields identifying which PR + round a batch of findings belongs to. */
export interface FindingPersistContext {
  prOwner: string;
  prRepo: string;
  prNumber: number;
  headSha: string;
  /** 1-indexed review round (matches reviewer_convergence_metrics.iteration_index). */
  round: number;
}

/** One finding ready to insert into reviewer_findings. */
export interface FindingRecordInput extends FindingPersistContext {
  severity: string;
  file: string;
  line?: number;
  lineEnd?: number;
  title: string;
  body: string;
  disposition?: FindingDisposition | null;
}

/** A minimal file/line locator shared by every recovery pass's downgrade-audit entry. */
export interface DowngradeLocator {
  file: string;
  line?: number;
  lineEnd?: number;
}

// ---------------------------------------------------------------------------
// Locator keys (for matching a finding against a downgrade-audit entry)
// ---------------------------------------------------------------------------

/**
 * Build a stable key identifying a finding's location, for matching a
 * `submit_finding` call (or a parsed body finding) against a downgrade-audit
 * entry emitted by one of the recovery passes (severity-recovery,
 * convergence-detector, diff-scoper, refutation-recovery). All four audit
 * entry shapes carry `file`/`line?`/`lineEnd?`, so one key function serves
 * all of them.
 *
 * Exported for unit testing and for review-worker.ts's call site (building
 * the bypassed-locator set from the four downgrade arrays).
 */
export function findingLocatorKey(locator: DowngradeLocator): string {
  const line = locator.line ?? "";
  const lineEnd = locator.lineEnd ?? "";
  return `${locator.file}::${line}::${lineEnd}`;
}

/**
 * Build the set of locator keys for findings that were downgraded (BLOCKING
 * -> NON-BLOCKING) by ANY structural recovery pass within the SAME round —
 * the cheap "bypassed" disposition signal (mt#3295 SC#2). Callers pass the
 * four downgrade-audit arrays already computed by `applyRecoveryAndCompose`
 * (severity-monotonicity, composition-convergence, diff-scope-bounded,
 * refutation-aware re-assertion) — empty arrays are fine (no-op).
 */
export function buildBypassedLocatorSet(
  ...downgradeArrays: ReadonlyArray<ReadonlyArray<DowngradeLocator>>
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const arr of downgradeArrays) {
    for (const entry of arr) {
      keys.add(findingLocatorKey(entry));
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Record builders
// ---------------------------------------------------------------------------

/**
 * Derive a short title from a parsed finding's free-text description.
 *
 * The prose/backfill path has no separate summary/details split (unlike the
 * output-tools path's `submit_finding.summary`/`.details`), so a title is
 * derived from the text: up to the first sentence boundary (". ") or 120
 * characters, whichever is shorter. Falls back to a synthesized
 * "<SEVERITY> finding at <file>:<line>" string when there is no text at all
 * (mirrors the fallback already used in scripts/mine-ground-truth-corpus.ts).
 *
 * Pure function. Exported for unit testing.
 */
export function deriveTitleFromText(finding: FlatFinding): string {
  const text = finding.text?.trim();
  if (!text) {
    return `${finding.severity} finding at ${finding.file}:${finding.line ?? "?"}`;
  }
  const sentenceBoundary = text.indexOf(". ");
  const cut = sentenceBoundary >= 0 ? sentenceBoundary + 1 : text.length;
  const candidate = safeTruncate(text, cut, "head").trim();
  return candidate.length > 120 ? `${safeTruncate(candidate, 117, "head")}...` : candidate;
}

/**
 * Build FindingRecordInput rows from the model's own structured
 * `submit_finding` tool calls (output-tools path — the production default).
 * `title`/`body` map directly to the model's `summary`/`details` fields.
 *
 * `bypassedLocators`, when provided, marks any finding whose file/line
 * matches a downgrade-audit entry with `disposition: "bypassed"` — see
 * `buildBypassedLocatorSet`. Findings not in the set get `disposition:
 * undefined` (left NULL — still open / not yet evaluated).
 *
 * Pure function. Exported for unit testing.
 */
export function buildFindingRecordsFromToolCalls(
  toolCalls: ReadonlyArray<ReviewToolCall>,
  ctx: FindingPersistContext,
  bypassedLocators?: ReadonlySet<string>
): FindingRecordInput[] {
  const records: FindingRecordInput[] = [];
  for (const tc of toolCalls) {
    if (tc.name !== "submit_finding") continue;
    const { severity, file, line, lineEnd, summary, details } = tc.args;
    const isBypassed =
      bypassedLocators !== undefined &&
      bypassedLocators.has(findingLocatorKey({ file, line, lineEnd }));
    records.push({
      ...ctx,
      severity,
      file,
      ...(line !== undefined ? { line } : {}),
      ...(lineEnd !== undefined ? { lineEnd } : {}),
      title: summary,
      body: details,
      disposition: isBypassed ? "bypassed" : undefined,
    });
  }
  return records;
}

/**
 * Build FindingRecordInput rows by parsing a rendered review-body markdown
 * string (the prose path, and the one-shot backfill from
 * `reviewer_webhook_events`). Reuses `parseFindingsFromBody` (already shared
 * with the mt#2726 corpus miner) so live-parsed and backfilled rows use
 * identical extraction semantics.
 *
 * No disposition detection on this path — the recovery/downgrade passes only
 * run on the output-tools path (see recovery-compose.ts), so there is no
 * cheap bypass signal available here. `disposition` is always left
 * undefined (NULL).
 *
 * Pure function. Exported for unit testing.
 */
export function buildFindingRecordsFromBody(
  body: string,
  ctx: FindingPersistContext
): FindingRecordInput[] {
  const findings = parseFindingsFromBody(body);
  return findings.map((finding) => ({
    ...ctx,
    severity: finding.severity,
    file: finding.file,
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    ...(finding.lineEnd !== undefined ? { lineEnd: finding.lineEnd } : {}),
    title: deriveTitleFromText(finding),
    body: finding.text ?? deriveTitleFromText(finding),
  }));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Persist a batch of findings for one review round.
 *
 * No-ops on an empty array (nothing to insert). Wrapped in try/catch — logs
 * on failure but never throws; reviews must not fail because a finding write
 * fails. Invalid severity/disposition values are dropped (with a warning)
 * before the insert rather than left to the DB to reject the whole batch.
 */
export async function recordFindings(
  db: ReviewerDb,
  records: ReadonlyArray<FindingRecordInput>
): Promise<void> {
  if (records.length === 0) return;

  const values = records
    .filter((r) => {
      if (!VALID_FINDING_SEVERITIES.has(r.severity)) {
        log.warn("finding_severity_invalid", {
          event: "finding_severity_invalid",
          severity: r.severity,
          prOwner: r.prOwner,
          prRepo: r.prRepo,
          prNumber: r.prNumber,
          file: r.file,
        });
        return false;
      }
      if (r.disposition != null && !VALID_FINDING_DISPOSITIONS.has(r.disposition)) {
        log.warn("finding_disposition_invalid", {
          event: "finding_disposition_invalid",
          disposition: r.disposition,
          prOwner: r.prOwner,
          prRepo: r.prRepo,
          prNumber: r.prNumber,
          file: r.file,
        });
        return false;
      }
      return true;
    })
    .map((r) => ({
      prOwner: r.prOwner,
      prRepo: r.prRepo,
      prNumber: r.prNumber,
      headSha: r.headSha,
      round: r.round,
      severity: r.severity,
      file: r.file,
      line: r.line ?? null,
      lineEnd: r.lineEnd ?? null,
      title: r.title,
      body: r.body,
      disposition: r.disposition ?? null,
      dispositionSetAt: r.disposition != null ? new Date() : null,
    }));

  if (values.length === 0) return;

  try {
    await db.insert(reviewerFindingsTable).values(values);
  } catch (err: unknown) {
    log.error("finding_write_error", {
      event: "finding_write_error",
      ...extractPgErrorContext(err),
      prOwner: records[0]?.prOwner,
      prRepo: records[0]?.prRepo,
      prNumber: records[0]?.prNumber,
      count: values.length,
    });
    // Intentionally swallow — reviews proceed regardless of finding write failures.
  }
}

/**
 * Resolve outstanding (disposition IS NULL) BLOCKING findings for a PR once
 * it converges (the current round's event is APPROVE) — the second cheap
 * disposition signal (mt#3295 SC#2). Marks them `disposition: "unknown"`
 * rather than guessing HOW they were resolved (fixed / dismissed / resolved-
 * without-code-change): that deeper classification needs diff-mining and is
 * mt#3300's job. This just ensures every finding on a converged PR carries a
 * non-NULL disposition (per the mt#3295 spec's AT#2), honestly labeled as
 * "resolved, mechanism unknown" rather than a specific (and possibly wrong)
 * claim.
 *
 * No-ops when db is undefined at the call site (callers check before
 * calling). Wrapped in try/catch — logs on failure but never throws.
 */
export async function resolveOutstandingFindingsOnApproval(
  db: ReviewerDb,
  params: { prOwner: string; prRepo: string; prNumber: number }
): Promise<void> {
  try {
    await db
      .update(reviewerFindingsTable)
      .set({ disposition: "unknown", dispositionSetAt: new Date() })
      .where(
        and(
          eq(reviewerFindingsTable.prOwner, params.prOwner),
          eq(reviewerFindingsTable.prRepo, params.prRepo),
          eq(reviewerFindingsTable.prNumber, params.prNumber),
          eq(reviewerFindingsTable.severity, "BLOCKING"),
          isNull(reviewerFindingsTable.disposition)
        )
      );
  } catch (err: unknown) {
    log.error("finding_disposition_resolve_error", {
      event: "finding_disposition_resolve_error",
      ...extractPgErrorContext(err),
      prOwner: params.prOwner,
      prRepo: params.prRepo,
      prNumber: params.prNumber,
    });
    // Intentionally swallow — reviews proceed regardless of disposition-write failures.
  }
}
