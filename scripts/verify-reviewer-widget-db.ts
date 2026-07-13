#!/usr/bin/env bun
/**
 * Live verification for the reviewer-bot-status widget DB query layer (mt#2757).
 *
 * Exercises the REAL `buildQueryRows()` wiring (postgres-js `sql.unsafe`) against
 * the configured shared Postgres — the exact path the cockpit widget uses in
 * production. The original mt#2076 wiring called the postgres-js Sql instance as
 * a plain function (NOT_TAGGED_CALL on every query) and silently fail-opened to
 * `[]`, so every DB field rendered as zero since birth; unit tests inject the
 * queryRows seam and cannot catch that class of regression.
 *
 * Discriminator: `SELECT 1 AS one` through the widget's queryRows MUST return a
 * row regardless of data volume. `[]` means the query layer is broken (the
 * fail-open catch ate an error), NOT that there is no data.
 *
 * Usage: bun scripts/verify-reviewer-widget-db.ts
 * Exits 0 on pass or graceful skip (no DB configured / non-Postgres provider);
 * 1 on genuine query-layer failure (raw SQL available but the probe returns
 * no rows). Output: JSON on stdout.
 */
import "reflect-metadata";
import { setupConfiguration } from "../packages/domain/src/config-setup";
import { buildQueryRows } from "../src/cockpit/widgets/reviewer-bot-status";

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

// Capability gate: distinguish "no shared Postgres configured" (SKIP) from
// "query layer broken" (FAIL). buildQueryRows() intentionally degrades to an
// always-[] function when the provider lacks raw SQL support, which would
// otherwise read as a false FAIL from the SELECT 1 probe below.
try {
  const { getSharedPersistenceService } = await import("../src/cockpit/shared-persistence");
  const svc = await getSharedPersistenceService();
  const provider = svc.getProvider() as { getRawSqlConnection?: () => Promise<unknown> };
  if (typeof provider.getRawSqlConnection !== "function") {
    emit({
      status: "SKIP",
      reason:
        "persistence provider has no raw SQL connection (no shared Postgres configured) — reviewer widget DB stats are disabled by design on this backend",
    });
    process.exit(0);
  }
} catch (err) {
  emit({
    status: "SKIP",
    reason: `persistence unavailable: ${err instanceof Error ? err.message : String(err)}`,
  });
  process.exit(0);
}

const queryRows = await buildQueryRows();

// Discriminator: must return exactly one row on ANY reachable Postgres.
const probe = await queryRows("SELECT 1 AS one");
if (probe.length !== 1) {
  emit({
    status: "FAIL",
    reason:
      "SELECT 1 through the widget query layer returned no rows — the query layer is broken (or the DB is unreachable); see cockpit logs for the suppressed warn",
    probe,
  });
  process.exit(1);
}

// Informational: the two widget stats that make staleness obvious at a glance.
const window24hIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const throughput = await queryRows(
  `SELECT COUNT(*) AS count FROM reviewer_webhook_events
   WHERE outcome = 'review_submitted' AND received_at >= $1`,
  [window24hIso]
);
const lastWebhook = await queryRows(
  `SELECT received_at FROM reviewer_webhook_events ORDER BY received_at DESC LIMIT 1`
);

emit({
  status: "PASS",
  probe,
  reviewCount24h: Number(throughput[0]?.["count"] ?? 0),
  lastWebhookReceivedAt: lastWebhook[0]?.["received_at"] ?? null,
});
process.exit(0);
