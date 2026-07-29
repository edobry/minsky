#!/usr/bin/env bun
/**
 * One-shot backfill: mine historical reviewer findings out of
 * `reviewer_webhook_events` into the new `reviewer_findings` table (mt#3295).
 *
 * Before mt#3295, finding content only ever existed as markdown prose inside
 * GitHub review bodies, mirrored (unparsed) in `reviewer_webhook_events.body`
 * for every `pull_request_review` webhook delivery the reviewer service
 * received — including deliveries for its OWN posted reviews (GitHub sends a
 * `pull_request_review` webhook for every review submitted on a PR,
 * regardless of author, as long as the receiving App is subscribed to the
 * event). This script mines that historical corpus using the same
 * `parseFindingsFromBody` parser the live writer (review-finalize.ts) uses,
 * so backfilled and live-written rows share identical extraction semantics.
 *
 * ## Round numbering
 *
 * Webhook events have no explicit "iteration index" field. This script
 * derives `round` by ordering each PR's `pull_request_review` deliveries by
 * `received_at` ascending and assigning 1, 2, 3, ... — the same convention
 * `reviewer_convergence_metrics.iteration_index` uses (1-based, oldest
 * first). A delivery whose `received_at` is unreliable (e.g. a re-delivered
 * webhook UPSERTed in place) would shift subsequent rounds; this is a known
 * limitation of a webhook-event-sourced backfill and is acceptable for a
 * one-shot historical mining pass (not the live write path, which reads the
 * authoritative iteration index directly from `priorReviewIngestion`).
 *
 * ## Safety (per CLAUDE.md "Operational Safety: Dry-Run First" + mt#2785)
 *
 * Defaults to `--dry-run` (prints a summary: rows examined, PRs covered,
 * findings that would be inserted, per-severity breakdown). Writing requires
 * the explicit `--execute` flag. This script inserting into
 * `reviewer_findings` is exactly the ">10 records, bulk mutation of
 * shared/production state" case mt#2785 requires a task wrapper for — mt#3295
 * IS that task wrapper; running `--execute` against production is a
 * deliberate follow-up operational step, not something this PR runs
 * automatically.
 *
 * Usage:
 *   bun services/reviewer/scripts/backfill-findings-from-webhook-events.ts
 *   bun services/reviewer/scripts/backfill-findings-from-webhook-events.ts --limit 50
 *   bun services/reviewer/scripts/backfill-findings-from-webhook-events.ts --execute
 *
 * Requires MINSKY_PERSISTENCE_POSTGRES_URL (or a legacy alias — see
 * db/client.ts's resolveConnectionString) pointing at the reviewer's
 * Postgres database. Skips gracefully (exit 0) when unset.
 */

import { asc, eq } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { webhookEventsTable } from "../src/db/schemas/webhook-events-schema";
import {
  buildFindingRecordsFromBody,
  recordFindings,
  type FindingRecordInput,
} from "../src/findings";

const BOT_LOGIN = "minsky-reviewer[bot]";

/** Batch size for the --execute insert path — keeps individual statements bounded. */
const INSERT_BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Payload extraction (pure — exported for unit testing)
// ---------------------------------------------------------------------------

export interface ParsedReviewDelivery {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  reviewBody: string;
}

/**
 * Extract the fields needed for backfill from one `pull_request_review`
 * webhook payload (the JSONB `body` column of `reviewer_webhook_events`).
 * Returns `null` when the payload is not a `submitted` review by the
 * reviewer bot, or is missing/malformed fields — defensive, since webhook
 * payload shape is external input.
 *
 * Pure function. Exported for unit testing.
 */
export function extractReviewDelivery(body: unknown): ParsedReviewDelivery | null {
  if (typeof body !== "object" || body === null) return null;
  const rec = body as Record<string, unknown>;
  if (rec["action"] !== "submitted") return null;

  const review = rec["review"];
  const pr = rec["pull_request"];
  const repository = rec["repository"];
  if (
    typeof review !== "object" ||
    review === null ||
    typeof pr !== "object" ||
    pr === null ||
    typeof repository !== "object" ||
    repository === null
  ) {
    return null;
  }
  const reviewRec = review as Record<string, unknown>;
  const prRec = pr as Record<string, unknown>;
  const repoRec = repository as Record<string, unknown>;

  const user = reviewRec["user"];
  const userLogin =
    typeof user === "object" && user !== null
      ? (user as Record<string, unknown>)["login"]
      : undefined;
  if (userLogin !== BOT_LOGIN) return null;

  const owner = repoRec["owner"];
  const ownerLogin =
    typeof owner === "object" && owner !== null
      ? (owner as Record<string, unknown>)["login"]
      : undefined;
  const repoName = repoRec["name"];
  const prNumber = prRec["number"];
  const headSha = reviewRec["commit_id"];
  const reviewBody = reviewRec["body"];

  if (
    typeof ownerLogin !== "string" ||
    typeof repoName !== "string" ||
    typeof prNumber !== "number" ||
    typeof headSha !== "string" ||
    typeof reviewBody !== "string"
  ) {
    return null;
  }

  return { owner: ownerLogin, repo: repoName, prNumber, headSha, reviewBody };
}

/**
 * Assign 1-based round numbers to a PR's ordered list of review deliveries
 * (oldest first). Pure function. Exported for unit testing.
 */
export function assignRounds(
  deliveries: ReadonlyArray<ParsedReviewDelivery>
): ReadonlyArray<ParsedReviewDelivery & { round: number }> {
  return deliveries.map((d, idx) => ({ ...d, round: idx + 1 }));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  execute: boolean;
  limit: number | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  let execute = false;
  let limit: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    if (arg === "--dry-run") {
      execute = false;
      continue;
    }
    if (arg === "--limit") {
      const val = argv[i + 1];
      if (val !== undefined) {
        const parsed = parseInt(val, 10);
        if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
        i++;
      }
      continue;
    }
  }
  return { execute, limit };
}

async function main(): Promise<void> {
  const connectionConfigured =
    process.env["MINSKY_PERSISTENCE_POSTGRES_URL"] ||
    process.env["MINSKY_SESSIONDB_POSTGRES_URL"] ||
    process.env["MINSKY_POSTGRES_URL"];
  if (!connectionConfigured) {
    console.log("SKIP: no Postgres connection string configured");
    process.exit(0);
  }

  const args = parseArgs(process.argv.slice(2));
  const db = getDb();

  console.log(
    `Mining reviewer findings from reviewer_webhook_events (pull_request_review, bot=${BOT_LOGIN})...`
  );

  const rows = await db
    .select({ body: webhookEventsTable.body, receivedAt: webhookEventsTable.receivedAt })
    .from(webhookEventsTable)
    .where(eq(webhookEventsTable.eventType, "pull_request_review"))
    .orderBy(asc(webhookEventsTable.receivedAt))
    .limit(args.limit ?? 1_000_000);

  console.log(`Examined ${rows.length} pull_request_review webhook event row(s).`);

  // Group deliveries per (owner, repo, prNumber), preserving received_at
  // ascending order within each group (the query above is already sorted).
  const byPr = new Map<string, ParsedReviewDelivery[]>();
  let skippedCount = 0;
  for (const row of rows) {
    const parsed = extractReviewDelivery(row.body);
    if (!parsed) {
      skippedCount++;
      continue;
    }
    const key = `${parsed.owner}/${parsed.repo}#${parsed.prNumber}`;
    const existing = byPr.get(key) ?? [];
    existing.push(parsed);
    byPr.set(key, existing);
  }

  console.log(
    `Parsed ${rows.length - skippedCount} bot-authored review submission(s) across ${byPr.size} PR(s) ` +
      `(${skippedCount} row(s) skipped — not a bot 'submitted' review, or malformed payload).`
  );

  const allRecords: FindingRecordInput[] = [];
  for (const deliveries of byPr.values()) {
    const withRounds = assignRounds(deliveries);
    for (const delivery of withRounds) {
      const records = buildFindingRecordsFromBody(delivery.reviewBody, {
        prOwner: delivery.owner,
        prRepo: delivery.repo,
        prNumber: delivery.prNumber,
        headSha: delivery.headSha,
        round: delivery.round,
      });
      allRecords.push(...records);
    }
  }

  const bySeverity = new Map<string, number>();
  for (const r of allRecords) {
    bySeverity.set(r.severity, (bySeverity.get(r.severity) ?? 0) + 1);
  }

  console.log(
    JSON.stringify(
      {
        prsCovered: byPr.size,
        totalFindings: allRecords.length,
        bySeverity: Object.fromEntries(bySeverity),
      },
      null,
      2
    )
  );

  if (!args.execute) {
    console.log(
      "Dry-run complete (no rows written). Re-run with --execute to insert into reviewer_findings."
    );
    return;
  }

  console.log(
    `--execute: inserting ${allRecords.length} row(s) in batches of ${INSERT_BATCH_SIZE}...`
  );
  for (let i = 0; i < allRecords.length; i += INSERT_BATCH_SIZE) {
    const batch = allRecords.slice(i, i + INSERT_BATCH_SIZE);
    await recordFindings(db, batch);
    console.log(`  inserted batch ${i / INSERT_BATCH_SIZE + 1} (${batch.length} row(s))`);
  }
  console.log("Backfill complete.");
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Fatal:", message);
    process.exit(1);
  });
}
