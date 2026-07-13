#!/usr/bin/env bun
/**
 * Smoke script: durable webhook-event persistence (mt#1372)
 *
 * Verifies that the reviewer service correctly persists incoming webhook
 * events to the reviewer_webhook_events table in Postgres.
 *
 * What this script does:
 *   1. Synthesizes a signed pull_request.opened webhook payload.
 *   2. POSTs it to the reviewer service /webhook endpoint.
 *   3. Queries the DB for the persisted row by delivery ID.
 *   4. Asserts the row exists with correct fields (outcome=received or
 *      reviewer_called, depending on timing).
 *
 * Required environment variables:
 *   MINSKY_REVIEWER_WEBHOOK_SECRET — webhook HMAC secret
 *   MINSKY_SESSIONDB_POSTGRES_URL  — Postgres connection string (or MINSKY_POSTGRES_URL)
 *   SMOKE_REVIEWER_BASE_URL        — base URL of the reviewer service (default: http://localhost:3000)
 *
 * Optional:
 *   SMOKE_DELIVERY_ID              — custom delivery ID for this run
 *
 * Exit codes:
 *   0 — smoke test passed (or skipped due to missing env vars)
 *   1 — smoke test failed
 *
 * Skips gracefully when required env vars are absent.
 *
 * Per §7a: this script is the verification artifact for the structural change
 * (new persistence backend path). The main agent runs it post-PR with env
 * vars present.
 *
 * R1 BLOCKING #2 fix: this script uses raw SQL via postgres-js tagged
 * template literals. It does NOT import the Drizzle schema from the src/
 * tree because the deployed reviewer service only ships compiled JS in
 * /app/dist (or wherever the Docker image places it) — src/ may not be
 * present at runtime. The raw SQL query is self-contained and verifies the
 * actual table shape end-to-end.
 */

import { sign } from "@octokit/webhooks-methods";
import postgres from "postgres";

// ---------------------------------------------------------------------------
// Environment resolution
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = process.env["MINSKY_REVIEWER_WEBHOOK_SECRET"];
const POSTGRES_URL =
  process.env["MINSKY_SESSIONDB_POSTGRES_URL"] ?? process.env["MINSKY_POSTGRES_URL"];
const BASE_URL = process.env["SMOKE_REVIEWER_BASE_URL"] ?? "http://localhost:3000";
const DELIVERY_ID = process.env["SMOKE_DELIVERY_ID"] ?? `smoke-webhook-events-${Date.now()}`;

function skip(reason: string): never {
  console.log(`SKIP: ${reason}`);
  process.exit(0);
}

if (!WEBHOOK_SECRET) {
  skip("MINSKY_REVIEWER_WEBHOOK_SECRET is not set");
}
if (!POSTGRES_URL) {
  skip("MINSKY_SESSIONDB_POSTGRES_URL (or MINSKY_POSTGRES_URL) is not set");
}

// TypeScript can't narrow through the `never`-returning skip() calls above,
// so we reassert the narrowed type here using a type guard pattern.
// The skip() calls above guarantee these are non-null at this point.
const webhookSecret: string = WEBHOOK_SECRET ?? "";
const postgresUrl: string = POSTGRES_URL ?? "";

// ---------------------------------------------------------------------------
// Row shape (raw SQL — not coupled to Drizzle schema in src/)
// ---------------------------------------------------------------------------

/**
 * Subset of the reviewer_webhook_events row shape this script asserts on.
 * Defined inline rather than imported from src/ so this script can be run
 * against a deployed reviewer service where src/ isn't shipped.
 */
interface WebhookEventRow {
  id: number;
  delivery_id: string;
  event_type: string;
  outcome: string;
  headers: Record<string, unknown>;
  body: Record<string, unknown>;
  received_at: Date;
  processed_at: Date | null;
}

// ---------------------------------------------------------------------------
// Synthesize and send a webhook
// ---------------------------------------------------------------------------

const PAYLOAD = JSON.stringify({
  action: "opened",
  pull_request: {
    number: 9999,
    user: { login: "smoke-test-author" },
    draft: false,
    head: { sha: "smoke000000000000000000000000000000000001" },
  },
  repository: {
    owner: { login: "edobry" },
    name: "minsky",
  },
});

console.log(`Smoke: smoke-webhook-events delivery_id=${DELIVERY_ID}`);
console.log(`Smoke: posting to ${BASE_URL}/webhook ...`);

let httpStatus: number;
try {
  const signature = await sign(webhookSecret, PAYLOAD);
  const response = await fetch(`${BASE_URL}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      "x-github-delivery": DELIVERY_ID,
      "x-github-event": "pull_request",
    },
    body: PAYLOAD,
  });
  httpStatus = response.status;
  const text = await response.text();
  console.log(`Smoke: HTTP ${httpStatus} — ${text}`);
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`FAIL: could not POST to ${BASE_URL}/webhook: ${message}`);
  process.exit(1);
}

if (httpStatus !== 200) {
  console.error(`FAIL: expected HTTP 200, got ${httpStatus}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Query the DB for the persisted row (raw SQL — no Drizzle schema import)
// ---------------------------------------------------------------------------

// Brief wait for the async persistence to flush. The server writes
// recordWebhookReceipt fire-and-forget; 500ms is more than enough on localhost.
await new Promise<void>((resolve) => setTimeout(resolve, 500));

const sql = postgres(postgresUrl);

let rows: WebhookEventRow[];
try {
  // Raw SQL — script is decoupled from Drizzle schema in src/.
  // Column names match the table layout in migrations/pg/0001_webhook_events.sql.
  // postgres-js's sql<T>`` generic types the result as T[].
  rows = await sql<WebhookEventRow[]>`
    SELECT id, delivery_id, event_type, outcome, headers, body, received_at, processed_at
    FROM reviewer_webhook_events
    WHERE delivery_id = ${DELIVERY_ID}
  `;
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`FAIL: DB query failed: ${message}`);
  await sql.end();
  process.exit(1);
}

await sql.end();

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

if (rows.length === 0) {
  console.error(`FAIL: no row found in reviewer_webhook_events for delivery_id=${DELIVERY_ID}`);
  process.exit(1);
}

const row = rows[0];
if (!row) {
  console.error(`FAIL: row unexpectedly undefined for delivery_id=${DELIVERY_ID}`);
  process.exit(1);
}

console.log(
  "Smoke: persisted row:",
  JSON.stringify(
    {
      id: row.id,
      delivery_id: row.delivery_id,
      event_type: row.event_type,
      outcome: row.outcome,
      received_at: row.received_at,
      processed_at: row.processed_at,
      headersKeys: Object.keys(row.headers),
    },
    null,
    2
  )
);

// Assertions
const failures: string[] = [];

if (row.delivery_id !== DELIVERY_ID) {
  failures.push(`delivery_id: expected ${DELIVERY_ID}, got ${row.delivery_id}`);
}
if (row.event_type !== "pull_request") {
  failures.push(`event_type: expected pull_request, got ${row.event_type}`);
}
// Outcome will be "received" immediately after the insert, possibly "reviewer_called"
// if the review dispatch already ran. Both are valid within a smoke run.
const VALID_OUTCOMES = new Set([
  "received",
  "reviewer_called",
  "review_submitted",
  "failed_at_reviewer",
  "skipped",
]);
if (!VALID_OUTCOMES.has(row.outcome)) {
  failures.push(`outcome: unexpected value ${row.outcome}`);
}
if (!row.received_at) {
  failures.push("received_at: null/undefined (expected a timestamp)");
}

const headers = row.headers;
if (!headers["x-github-delivery"]) {
  failures.push("headers missing x-github-delivery");
}
if (!headers["x-github-event"]) {
  failures.push("headers missing x-github-event");
}
if (!headers["x-hub-signature-256-prefix"]) {
  failures.push("headers missing x-hub-signature-256-prefix");
}

// Body should contain action=opened
const body = row.body;
if (body["action"] !== "opened") {
  failures.push(`body.action: expected opened, got ${String(body["action"])}`);
}

if (failures.length > 0) {
  console.error("FAIL: assertions failed:");
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log("PASS: smoke-webhook-events — row persisted with correct fields");
process.exit(0);
