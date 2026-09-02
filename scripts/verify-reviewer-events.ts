#!/usr/bin/env bun
/**
 * Live verification for `observability.reviewer-events` (mt#4118).
 *
 * Runs the REAL `queryReviewerEvents()` — the same function the registered
 * command calls — against the configured shared Postgres. The command's pure
 * half (classification, verdict derivation, formatting) is covered by
 * `src/adapters/shared/commands/reviewer-events.test.ts`; this covers the half
 * unit tests cannot reach: whether the SQL's jsonb extraction actually finds
 * the rows, on a table with no owner/repo/pr columns where each event shape
 * stores the PR number at a different path.
 *
 * The four checks are this task's acceptance tests, and they are specimen-based
 * rather than synthetic — every one names a real incident whose rows are still
 * in the table:
 *
 *   AT1  edobry/minsky #2719, 2026-08-08 — the mt#3852 submit-path 422. The
 *        originating incident: every ladder rung reported "absent" while this
 *        row existed.
 *   AT2  edobry/peezombie.me #2, 2026-09-01 — the mt#4879 provider 400. Same
 *        agent-visible signature, completely different cause.
 *   AT3  a PR number with no deliveries — the negative case. Must report
 *        `no-record` / `isSilence: true`, or the rung would never let the
 *        ladder reach a legitimate bypass.
 *   AT5  a comment-triggered failure — must be found, which it can only be if
 *        the PR-number extraction reaches `body->'issue'->>'number'` and not
 *        just `body->'pull_request'->>'number'`.
 *
 * Usage: bun scripts/verify-reviewer-events.ts
 * Exit 0 on pass or graceful skip (no Postgres configured); 1 on failure.
 * Output: JSON on stdout. No connection string is printed on any path.
 */
import "reflect-metadata";
import { setupConfiguration } from "../packages/domain/src/config-setup";
import {
  queryReviewerEvents,
  type ReviewerEventsDb,
  type ReviewerEventsReport,
} from "../src/adapters/shared/commands/reviewer-events";

interface CheckResult {
  id: string;
  what: string;
  pass: boolean;
  observed: Record<string, unknown>;
}

function emit(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

try {
  await setupConfiguration();
} catch (err) {
  emit({
    status: "SKIP",
    reason: `configuration unavailable: ${err instanceof Error ? err.message : String(err)}`,
  });
  process.exit(0);
}

let db: ReviewerEventsDb;
try {
  const { getSharedPersistenceService } = await import("../src/cockpit/shared-persistence");
  const svc = await getSharedPersistenceService();
  const provider = svc.getProvider() as {
    getDatabaseConnection?: () => Promise<unknown>;
  };
  if (typeof provider.getDatabaseConnection !== "function") {
    emit({
      status: "SKIP",
      reason:
        "persistence provider has no Drizzle connection (no shared Postgres configured) — reviewer-events is Postgres-only by design",
    });
    process.exit(0);
  }
  const conn = await provider.getDatabaseConnection();
  if (!conn) {
    emit({ status: "SKIP", reason: "getDatabaseConnection() returned null" });
    process.exit(0);
  }
  db = conn as ReviewerEventsDb;
} catch (err) {
  emit({
    status: "SKIP",
    reason: `persistence unavailable: ${err instanceof Error ? err.message : String(err)}`,
  });
  process.exit(0);
}

/** Compact a report down to what a reader needs to judge the check. */
function summarize(r: ReviewerEventsReport): Record<string, unknown> {
  return {
    verdictKind: r.verdict.kind,
    isSilence: r.verdict.isSilence,
    rowCount: r.rowCount,
    verdicts: r.rows.map((row) => row.verdict),
    firstErrorMessage: r.rows.find((row) => row.errorMessage)?.errorMessage?.slice(0, 120) ?? null,
    repoWideFailureClasses: r.repoWideFailures.length,
    boundsCount: r.bounds.length,
  };
}

const checks: CheckResult[] = [];

// AT1 — the mt#3852 submit-path 422 on the originating PR.
{
  const report = await queryReviewerEvents(db, {
    owner: "edobry",
    repo: "minsky",
    pr: 2719,
    since: "2026-08-08T00:00:00Z",
    limit: 50,
  });
  const failed = report.rows.filter((r) => r.verdict === "ran-and-failed");
  checks.push({
    id: "AT1",
    what: "mt#3852 submit-path 422 on edobry/minsky #2719 reads as ran-and-failed, not silence",
    pass:
      report.verdict.kind === "ran-and-failed" &&
      report.verdict.isSilence === false &&
      failed.length >= 2 &&
      failed.every((r) => (r.errorMessage ?? "").includes("DraftPullRequestReviewComment")),
    observed: { ...summarize(report), failedRows: failed.length },
  });
}

// AT2 — the mt#4879 provider 400, a pre-submit failure with the same signature.
{
  const report = await queryReviewerEvents(db, {
    owner: "edobry",
    repo: "peezombie.me",
    pr: 2,
    since: "2026-09-01T00:00:00Z",
    limit: 50,
  });
  const failed = report.rows.filter((r) => r.verdict === "ran-and-failed");
  checks.push({
    id: "AT2",
    what: "mt#4879 provider 400 on edobry/peezombie.me #2 reads as ran-and-failed",
    pass:
      report.verdict.isSilence === false &&
      failed.length >= 4 &&
      failed.every((r) => (r.errorMessage ?? "").includes("Input tokens exceed")),
    observed: { ...summarize(report), failedRows: failed.length },
  });
}

// AT3 — the negative case. A PR with no deliveries must report no-record, or
// the rung would block every legitimate bypass instead of only the wrong ones.
{
  const report = await queryReviewerEvents(db, {
    owner: "edobry",
    repo: "minsky",
    pr: 999_999,
    since: "2026-08-01T00:00:00Z",
    limit: 50,
  });
  checks.push({
    id: "AT3",
    what: "a PR with no deliveries reports no-record / isSilence true, with its bounds attached",
    pass:
      report.verdict.kind === "no-record" &&
      report.verdict.isSilence === true &&
      report.rowCount === 0 &&
      report.bounds.length === 4,
    observed: summarize(report),
  });
}

// AT5 — comment-triggered coverage. The PR-number extraction must reach
// `body->'issue'->>'number'`; a pull_request-only extraction returns null for
// every one of these and the rows become unfindable by PR.
{
  const report = await queryReviewerEvents(db, {
    owner: "edobry",
    repo: "minsky",
    pr: null,
    since: "2026-06-01T00:00:00Z",
    limit: 200,
  });
  const commentRows = report.rows.filter(
    (r) => r.eventType === "issue_comment" && r.prNumber !== null
  );
  checks.push({
    id: "AT5",
    what: "issue_comment deliveries carry a resolved prNumber (extraction is not pull_request-only)",
    pass: commentRows.length > 0,
    observed: {
      commentRowsWithPrNumber: commentRows.length,
      sample: commentRows.slice(0, 3).map((r) => ({ pr: r.prNumber, verdict: r.verdict })),
      totalRowsScanned: report.rowCount,
    },
  });
}

// AT4 — a `concurrent_inflight` refusal must NOT read as a failure. Both are
// persisted with outcome `failed_at_reviewer`; only the message separates them,
// and they have opposite remedies (a new head vs. a service fix). The
// classification is unit-tested; this asserts a real specimen still reaches it.
{
  const report = await queryReviewerEvents(db, {
    owner: "edobry",
    repo: "minsky",
    pr: 3504,
    since: "2026-08-31T00:00:00Z",
    limit: 50,
  });
  const declined = report.rows.filter((r) => r.verdict === "declined-to-run");
  checks.push({
    id: "AT4",
    what: "a concurrent_inflight row classifies as declined-to-run, not ran-and-failed",
    pass:
      declined.length >= 1 &&
      report.rows.every((r) => r.verdict !== "ran-and-failed") &&
      report.verdict.isSilence === false,
    observed: { ...summarize(report), declinedRows: declined.length },
  });
}

const failures = checks.filter((c) => !c.pass);
emit({
  status: failures.length === 0 ? "PASS" : "FAIL",
  checks,
  failed: failures.map((c) => c.id),
});
process.exit(failures.length === 0 ? 0 : 1);
