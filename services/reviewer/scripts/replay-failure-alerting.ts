#!/usr/bin/env bun
/**
 * Replay verification for the mt#4881 failure-alerting seam.
 *
 * READ-ONLY. It never writes a row, never creates an Ask, and never calls
 * GitHub — it replays the REAL historical `failed_at_reviewer` population
 * through the exact classifier and dedup rules the production path uses, and
 * reports what would have happened.
 *
 * ## Why a replay and not a live-fire smoke
 *
 * The two claims this change makes that a unit test cannot settle are both
 * claims about the PRODUCTION CORPUS, not about the code:
 *
 *   1. **Coverage.** The classifier's classes were derived from a 30-day sample.
 *      Does it actually name the failures the service produces, or does most of
 *      the corpus fall through to `unclassified`? A test with hand-written
 *      fixtures cannot answer that — it only proves the classifier agrees with
 *      the fixtures I wrote.
 *   2. **Alert volume (SC2).** "A burst of 88 failures must not produce 88 asks"
 *      is a claim about how the suppression window interacts with the real
 *      arrival pattern. The unit tests prove the rule works on a synthetic
 *      burst; only the real timestamps show what the operator's inbox looks like.
 *
 * This is the mt#1403 replay-verification pattern: ship the artifact in the PR,
 * run it from a context that has credentials, paste the output into the PR body.
 *
 * Usage:
 *   MINSKY_PERSISTENCE_POSTGRES_URL=... bun services/reviewer/scripts/replay-failure-alerting.ts [--days 30]
 *   bun services/reviewer/scripts/replay-failure-alerting.ts --fixture rows.json
 *
 * `--fixture` replays an exported row set instead of querying, so the SAME
 * shipped code path can be run over a production export from a context that has
 * no database credentials. The rows are the query's own projection:
 * `[{ body, errorDetails, processedAt }]`.
 *
 * Exit codes: 0 = replayed (or skipped for want of a DB URL), 1 = replay failed.
 */

import { and, eq, gt, isNotNull } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { webhookEventsTable } from "../src/db/schemas/webhook-events-schema";
import {
  aggregatePriorFailures,
  classifyReviewFailure,
  extractPrCoordinates,
  SUPPRESSION_WINDOW_MS,
  SYSTEMIC_DISTINCT_PR_THRESHOLD,
  type ReviewFailureClass,
} from "../src/failure-alert";

interface ReplayRow {
  processedAt: Date;
  owner: string;
  repo: string;
  prNumber: number;
  errorClass: ReviewFailureClass;
}

function parseDays(argv: string[]): number {
  const idx = argv.indexOf("--days");
  if (idx === -1) return 30;
  const value = Number(argv[idx + 1]);
  return Number.isFinite(value) && value > 0 ? value : 30;
}

/** The query's projection — also the shape `--fixture` accepts. */
interface SourceRow {
  body: unknown;
  errorDetails: unknown;
  processedAt: Date | string | null;
}

function fixturePath(argv: string[]): string | null {
  const idx = argv.indexOf("--fixture");
  return idx === -1 ? null : (argv[idx + 1] ?? null);
}

async function loadRows(argv: string[]): Promise<{ rows: SourceRow[]; source: string } | null> {
  const fixture = fixturePath(argv);
  if (fixture !== null) {
    const parsed: unknown = JSON.parse(await Bun.file(fixture).text());
    if (!Array.isArray(parsed)) throw new Error(`fixture ${fixture} is not an array`);
    return { rows: parsed as SourceRow[], source: `fixture:${fixture}` };
  }

  const hasUrl =
    process.env.MINSKY_PERSISTENCE_POSTGRES_URL ||
    process.env.MINSKY_SESSIONDB_POSTGRES_URL ||
    process.env.MINSKY_POSTGRES_URL;
  if (!hasUrl) {
    // Skip gracefully so the script is safe to invoke from an environment
    // without credentials (per /implement-task §7a).
    console.log("SKIP: no Postgres URL in env (MINSKY_PERSISTENCE_POSTGRES_URL).");
    return null;
  }

  const days = parseDays(argv);
  const db = createDb();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const raw = await db
    .select({
      body: webhookEventsTable.body,
      errorDetails: webhookEventsTable.errorDetails,
      processedAt: webhookEventsTable.processedAt,
    })
    .from(webhookEventsTable)
    .where(
      and(
        eq(webhookEventsTable.outcome, "failed_at_reviewer"),
        gt(webhookEventsTable.processedAt, cutoff),
        isNotNull(webhookEventsTable.processedAt)
      )
    );

  return { rows: raw, source: `db:last-${days}-days` };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const days = parseDays(argv);
  const loaded = await loadRows(argv);
  if (loaded === null) return 0;
  const { rows: raw, source } = loaded;

  const rows: ReplayRow[] = [];
  let uncoordinated = 0;
  for (const r of raw) {
    const coords = extractPrCoordinates(r.body);
    if (!coords || r.processedAt === null || r.processedAt === undefined) {
      uncoordinated++;
      continue;
    }
    // A fixture export carries an ISO string where the driver gives a Date.
    const processedAt = r.processedAt instanceof Date ? r.processedAt : new Date(r.processedAt);
    if (Number.isNaN(processedAt.getTime())) {
      uncoordinated++;
      continue;
    }
    const details = r.errorDetails as { message?: unknown } | null;
    const message = typeof details?.message === "string" ? details.message : null;
    rows.push({
      processedAt,
      ...coords,
      errorClass: classifyReviewFailure(message).errorClass,
    });
  }

  rows.sort((a, b) => a.processedAt.getTime() - b.processedAt.getTime());

  // Classification coverage.
  const byClass = new Map<string, number>();
  for (const row of rows) byClass.set(row.errorClass, (byClass.get(row.errorClass) ?? 0) + 1);

  // Replay the suppression decision in arrival order, through the SHIPPED
  // `aggregatePriorFailures` — not a local re-implementation of it. A replay
  // that re-derives the rule measures the copy, and the copy is exactly what
  // drifts; this way a change to the production rule changes this number.
  let wouldAlert = 0;
  let wouldSuppress = 0;
  let systemicAlerts = 0;

  let index = 0;
  for (const row of rows) {
    const at = row.processedAt.getTime();
    const priors = rows
      .slice(0, index++)
      .filter((o) => at - o.processedAt.getTime() < SUPPRESSION_WINDOW_MS)
      .map((o) => ({
        owner: o.owner,
        repo: o.repo,
        prNumber: o.prNumber,
        errorClass: o.errorClass,
      }));

    const aggregation = aggregatePriorFailures(priors, {
      owner: row.owner,
      repo: row.repo,
      prNumber: row.prNumber,
      errorClass: row.errorClass,
    });

    if (aggregation.priorOccurrencesOnPr > 0 || aggregation.alreadySystemic) {
      wouldSuppress++;
      continue;
    }
    wouldAlert++;
    if (aggregation.systemic) systemicAlerts++;
  }

  const unclassified =
    (byClass.get("unclassified") ?? 0) + (byClass.get("unclassified_empty") ?? 0);

  const report = {
    source,
    windowDays: days,
    failuresReplayed: rows.length,
    rowsWithoutUsableCoordinates: uncoordinated,
    classification: {
      distribution: Object.fromEntries([...byClass.entries()].sort((a, b) => b[1] - a[1])),
      unclassified,
      coveragePct:
        rows.length === 0
          ? null
          : Math.round(((rows.length - unclassified) / rows.length) * 1000) / 10,
    },
    alerting: {
      suppressionWindowMinutes: SUPPRESSION_WINDOW_MS / 60_000,
      systemicDistinctPrThreshold: SYSTEMIC_DISTINCT_PR_THRESHOLD,
      wouldAlert,
      wouldSuppress,
      systemicAlerts,
      asksPerFailure:
        rows.length === 0 ? null : Math.round((wouldAlert / rows.length) * 1000) / 1000,
      // `wouldAlert` is an UPPER BOUND on production volume, not an estimate of
      // it. This replay reads only reviewer_webhook_events, so it cannot see
      // the circuit-breaker ownership check `recordReviewFailure` runs first —
      // every `github_submit_rejected` counted here is suppressed in production
      // as already owned by mt#2350. Do not report this figure as "the number
      // of asks the operator will get".
      upperBoundCaveat:
        "excludes the circuit-breaker suppression; production volume is lower by the github_submit_rejected count",
    },
  };

  console.log(JSON.stringify(report, null, 2));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("REPLAY FAILED:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
