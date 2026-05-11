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
 */

import { sign } from "@octokit/webhooks-methods";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { webhookEventsTable } from "../src/db/schemas/webhook-events-schema";

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
// Query the DB for the persisted row
// ---------------------------------------------------------------------------

// Brief wait for the async persistence to flush. The server writes
// recordWebhookReceipt fire-and-forget; 500ms is more than enough on localhost.
await new Promise<void>((resolve) => setTimeout(resolve, 500));

const sql = postgres(postgresUrl);
const db = drizzle(sql, { schema: { webhookEventsTable } });

let rows: (typeof webhookEventsTable.$inferSelect)[];
try {
  rows = await db
    .select()
    .from(webhookEventsTable)
    .where(eq(webhookEventsTable.deliveryId, DELIVERY_ID));
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
      deliveryId: row.deliveryId,
      eventType: row.eventType,
      outcome: row.outcome,
      receivedAt: row.receivedAt,
      processedAt: row.processedAt,
      headersKeys: Object.keys(row.headers as Record<string, unknown>),
    },
    null,
    2
  )
);

// Assertions
const failures: string[] = [];

if (row.deliveryId !== DELIVERY_ID) {
  failures.push(`deliveryId: expected ${DELIVERY_ID}, got ${row.deliveryId}`);
}
if (row.eventType !== "pull_request") {
  failures.push(`eventType: expected pull_request, got ${row.eventType}`);
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
if (!row.receivedAt) {
  failures.push("receivedAt: null/undefined (expected a timestamp)");
}

const headers = row.headers as Record<string, unknown>;
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
const body = row.body as Record<string, unknown>;
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
