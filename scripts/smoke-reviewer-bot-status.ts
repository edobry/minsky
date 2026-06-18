#!/usr/bin/env bun
/**
 * Live smoke test for the reviewer-bot status widget (mt#2076).
 *
 * The widget's correctness depends on live external behavior no unit test can
 * fully cover: (a) the reviewer `/health` endpoint actually answers, and (b) the
 * eight direct-Postgres queries against the four reviewer tables
 * (reviewer_webhook_events, reviewer_convergence_metrics, review_timing,
 * reviewer_inflight_reviews) parse and execute against the REAL schema — most
 * importantly the new `head_ref` column (mt#2076 Part A, migration 0005) and the
 * `received_at` (not `created_at`) column on reviewer_webhook_events. The widget
 * is fail-open (it returns an `ok` payload with `db: null` when the DB is
 * unreachable), so a unit test with injected deps cannot catch a malformed SQL
 * string — only running it against a live DB can. This script does that.
 *
 * Run from the repo root:
 *
 *   bun scripts/smoke-reviewer-bot-status.ts
 *
 * Env gating (degrade gracefully, never crash):
 *   - A Postgres URL (MINSKY_PERSISTENCE_POSTGRES_URL | MINSKY_POSTGRES_URL |
 *     DATABASE_URL) must be set for the DB half to be meaningful. Absent → the
 *     script SKIPs with exit 0 (the documented §7a no-env path).
 *   - Network access for the HTTP /health probe. Absent → `health.ok` is false
 *     and A1 fires (the widget's documented degraded path); not a smoke failure.
 *
 * Exit code: 0 when the widget returns a non-crashing `ok` payload AND the live
 * DB queries resolved (`db` is non-null); 0 with SKIP when no Postgres URL is
 * set; 1 when the widget returns `degraded` (an unexpected internal error) or
 * the DB half silently returned null despite a configured URL.
 */

// The shared PersistenceService transitively pulls in tsyringe, which requires
// the reflect-metadata polyfill at the entry point (the real cockpit boots via
// src/cli.ts, which imports it first). This script is its own entry point, so
// it must load the polyfill before importing widget code.
import "reflect-metadata";
import { reviewerBotStatusWidget } from "../src/cockpit/widgets/reviewer-bot-status";

const POSTGRES_URL_ENV_VARS = [
  "MINSKY_PERSISTENCE_POSTGRES_URL",
  "MINSKY_POSTGRES_URL",
  "DATABASE_URL",
] as const;

function hasPostgresUrl(): boolean {
  return POSTGRES_URL_ENV_VARS.some((name) => {
    const v = process.env[name];
    return typeof v === "string" && v.length > 0;
  });
}

async function main(): Promise<number> {
  if (!hasPostgresUrl()) {
    console.log(
      `SKIP: no Postgres URL set (${POSTGRES_URL_ENV_VARS.join(" | ")}). ` +
        "The DB half of the widget cannot be exercised without one."
    );
    return 0;
  }

  const data = await reviewerBotStatusWidget.fetch({ id: "reviewer-bot-status" });

  if (data.state !== "ok") {
    console.error("FAIL: widget returned degraded:", data.reason);
    return 1;
  }

  const payload = data.payload as Record<string, unknown>;
  console.log(JSON.stringify(payload, null, 2));

  const health = payload["health"] as { ok: boolean } | undefined;
  const db = payload["db"];
  console.log("");
  console.log(`health probe reached 200: ${health?.ok ? "yes" : "no"}`);
  console.log(`db queries resolved:      ${db !== null ? "yes" : "no"}`);

  if (db === null) {
    console.error(
      "FAIL: a Postgres URL is set but the widget's DB half returned null — " +
        "the live SQL queries did not execute (schema mismatch, bad SQL, or " +
        "connection failure). This is exactly the class §7a exists to catch."
    );
    return 1;
  }

  console.log("PASS: widget returned an ok payload and the live DB queries resolved.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("FAIL: smoke threw unexpectedly:", err);
    process.exit(1);
  });
