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
  const havePg = hasPostgresUrl();

  // Always exercise the widget. The health half (HTTP GET /health) needs no DB,
  // so it is verified live in ANY environment with network — this confirms the
  // probe wiring and the resolved REVIEWER_HEALTH_URL. The DB half degrades
  // gracefully without a Postgres URL (queries return empty), so its assertions
  // are gated on `havePg`. The widget is fail-open by design, so an unreachable
  // reviewer is NOT a smoke failure (it surfaces A1) — only a crash is.
  const data = await reviewerBotStatusWidget.fetch({ id: "reviewer-bot-status" });

  if (data.state !== "ok") {
    console.error("FAIL: widget returned degraded:", data.reason);
    return 1;
  }

  const payload = data.payload as Record<string, unknown>;
  console.log(JSON.stringify(payload, null, 2));

  const health = payload["health"] as { ok: boolean; statusCode: number | null } | undefined;
  const db = payload["db"];
  console.log("");
  console.log(
    `reviewer /health reachable (200): ${health?.ok ? "yes" : "no"} (status ${health?.statusCode ?? "n/a"})`
  );
  console.log(`db queries resolved:              ${db !== null ? "yes" : "no"}`);

  // When a Postgres URL IS present, the DB half MUST execute — a null payload
  // means the live SQL did not run (schema mismatch, bad SQL, or connection
  // failure). This is exactly the class §7a exists to catch (e.g. the R2/R3
  // invalid rate-limit query).
  if (havePg && db === null) {
    console.error(
      "FAIL: a Postgres URL is set but the widget's DB half returned null — " +
        "the live SQL queries did not execute against the real schema."
    );
    return 1;
  }

  if (!havePg) {
    console.log(
      `NOTE: no Postgres URL set (${POSTGRES_URL_ENV_VARS.join(" | ")}) — the DB ` +
        "half was not meaningfully exercised (queries returned empty). The health " +
        "half above IS verified live. Run with a Postgres URL to exercise the eight " +
        "reviewer-table queries (incl. the rate-limit unnest) against the real schema."
    );
  }

  console.log("PASS: widget returned a non-crashing ok payload; health probe exercised live.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("FAIL: smoke threw unexpectedly:", err);
    process.exit(1);
  });
