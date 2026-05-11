# Reviewer Webhook Investigation Guide

**Purpose:** Given a missed review on PR #N at time T, this guide explains how to
query the persisted webhook-event data to determine where processing failed.

**Shipped by:** mt#1372 (forward-instrumentation rescope, 2026-05-10)

---

## Background

Three confirmed instances (PR #677, #748, #761, 2026-04-23–24) showed the
`minsky-reviewer[bot]` failing to post a review with no forensic trail. The root
cause could not be determined because:

1. GitHub App webhook delivery history retention (~14 days) had expired.
2. Railway log retention was insufficient for the investigation window.
3. The agent cannot authenticate to App-admin endpoints (`/app/hook/deliveries`)
   from its normal context.

This document describes the `reviewer_webhook_events` table added by mt#1372 to
capture full forensic context for every future missed-review incident.

---

## Table Schema

Table: `reviewer_webhook_events`

| Column          | Type        | Description                                                                                                          |
| --------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`            | uuid        | Surrogate PK                                                                                                         |
| `delivery_id`   | text UNIQUE | GitHub `X-GitHub-Delivery` header (idempotency key)                                                                  |
| `event_type`    | text        | GitHub `X-GitHub-Event` header (e.g. `pull_request`)                                                                 |
| `headers`       | jsonb       | Subset of HTTP headers: `x-github-delivery`, `x-github-event`, `x-hub-signature-256-prefix` (12 chars), `user-agent` |
| `body`          | jsonb       | Full parsed webhook body (PR number, author, head SHA, action, etc.)                                                 |
| `outcome`       | enum        | Processing stage reached (see below)                                                                                 |
| `error_details` | jsonb       | Error message + stage + stack when outcome is a failure variant                                                      |
| `received_at`   | timestamptz | When the webhook arrived at the service                                                                              |
| `processed_at`  | timestamptz | When a terminal outcome was recorded (null for non-terminal)                                                         |

### Outcome enum values

| Value                    | Meaning                                                      |
| ------------------------ | ------------------------------------------------------------ |
| `received`               | Webhook arrived and row was inserted; further stages pending |
| `tier_resolved`          | Reserved for future tier-routing instrumentation             |
| `reviewer_called`        | `runReview` dispatch started (detached promise launched)     |
| `review_submitted`       | `runReview` completed with `status=reviewed`                 |
| `skipped`                | Webhook intentionally skipped (draft PR, non-PR event)       |
| `failed_at_signature`    | Signature verification failed                                |
| `failed_at_tier_resolve` | Unexpected dispatch error during `verifyAndReceive`          |
| `failed_at_reviewer`     | `runReview` threw or returned non-reviewed status            |

---

## Investigation Queries

### 1. Find all events for a specific PR number

```sql
SELECT
  delivery_id,
  event_type,
  outcome,
  received_at,
  processed_at,
  body->'pull_request'->>'number' AS pr_number,
  body->'pull_request'->'head'->>'sha' AS head_sha,
  error_details
FROM reviewer_webhook_events
WHERE (body->'pull_request'->>'number')::int = <PR_NUMBER>
ORDER BY received_at DESC;
```

### 2. Find all events by delivery ID

```sql
SELECT *
FROM reviewer_webhook_events
WHERE delivery_id = '<DELIVERY_ID>';
```

GitHub App delivery IDs appear in:

- The GitHub App settings UI under "Recent Deliveries"
- The `X-GitHub-Delivery` header logged by the reviewer service

### 3. Find all events in a time window

```sql
SELECT
  delivery_id,
  event_type,
  outcome,
  received_at,
  (body->'pull_request'->>'number')::int AS pr_number,
  body->'pull_request'->'head'->>'sha' AS head_sha
FROM reviewer_webhook_events
WHERE received_at BETWEEN '<START_ISO>' AND '<END_ISO>'
ORDER BY received_at DESC;
```

### 4. Find all failed events

```sql
SELECT
  delivery_id,
  event_type,
  outcome,
  received_at,
  error_details,
  (body->'pull_request'->>'number')::int AS pr_number
FROM reviewer_webhook_events
WHERE outcome LIKE 'failed_%'
ORDER BY received_at DESC
LIMIT 50;
```

### 5. Find events that never progressed past "received"

These are the most suspicious — the row was inserted but no outcome update followed.
This typically means the process crashed or was restarted between receipt and dispatch.

```sql
SELECT
  delivery_id,
  event_type,
  received_at,
  (body->'pull_request'->>'number')::int AS pr_number
FROM reviewer_webhook_events
WHERE outcome = 'received'
  AND received_at < now() - interval '5 minutes'
ORDER BY received_at DESC;
```

### 6. Find events where reviewer was called but review was never submitted

```sql
SELECT
  delivery_id,
  event_type,
  received_at,
  (body->'pull_request'->>'number')::int AS pr_number,
  body->'pull_request'->'head'->>'sha' AS head_sha
FROM reviewer_webhook_events
WHERE outcome = 'reviewer_called'
  AND received_at < now() - interval '10 minutes'
ORDER BY received_at DESC;
```

This class (reviewer called, no submission) is the most interesting failure mode —
it means `runReview` was dispatched but never completed. Look for corresponding
Railway log lines with `event=review_error` or a process restart at that timestamp.

---

## Cross-Reference with Calibration Data

The calibration data at `~/.claude/projects/.../memory/project_mt1110_calibration_data.md`
records observed instances with PR numbers and approximate timestamps. To cross-reference:

1. Find the push timestamp from the calibration data (e.g. PR #677, push at ~12:41 UTC 2026-04-23).
2. Query `reviewer_webhook_events` with `received_at BETWEEN '2026-04-23T12:35:00Z' AND '2026-04-23T13:00:00Z'`.
3. Compare the `delivery_id` against GitHub App delivery history (if still within retention window).
4. Check the `outcome` column for the failure stage.

Note: The 3 historical instances (PR #677, #748, #761) pre-date mt#1372 and have no rows.
This table captures all events from the deployment of mt#1372 onwards.

---

## Investigation Workflow for a Missed Review

Given: reviewer bot did not post a review on PR #N at time T.

**Step 1: Query for webhook receipt**

```sql
SELECT delivery_id, outcome, received_at, error_details
FROM reviewer_webhook_events
WHERE (body->'pull_request'->>'number')::int = N
  AND received_at BETWEEN '<T - 5 min>' AND '<T + 5 min>';
```

**Step 2: Classify by outcome**

- **No row found** → Webhook was never received. Likely a GitHub-side delivery failure
  or network/DNS issue. Check GitHub App delivery history (`/app/hook/deliveries`
  via a JWT-authenticated call or the GitHub App settings UI).

- **outcome = `received`** (stuck, never advanced) → Process crashed or was restarted
  between receipt and dispatch. Check Railway logs for pod restart events near `received_at`.

- **outcome = `reviewer_called`** (stuck) → `runReview` was dispatched but never
  completed. Check Railway logs for `event=review_error` or process restart. May
  indicate a long LLM call that timed out or a Railway pod OOM.

- **outcome = `failed_at_reviewer`** → `runReview` threw or returned non-reviewed status.
  Check `error_details.message` for the specific error. Also check Railway logs for
  `event=review_error` and `event=webhook_processing_failed`.

- **outcome = `review_submitted`** → Review was posted from the service's perspective.
  If the review still doesn't appear on GitHub, the GitHub API call succeeded from the
  service but the review may be hidden or the bot account may lack visibility. Check
  the `minsky-reviewer[bot]` reviews tab on the PR directly.

- **outcome = `failed_at_signature`** → Signature mismatch. Likely a misconfigured
  webhook secret. Not a missed-review scenario — no review was attempted.

**Step 3: Railway log correlation**

With the `received_at` timestamp from the DB row:

```
railway logs --service minsky-reviewer-webhook --since "<received_at - 1m>" --until "<received_at + 15m>"
```

Look for:

- `event=webhook_received` — confirms the service received the request
- `event=review_result` — confirms the review was dispatched and completed
- `event=review_error` — confirms a runReview failure with error details
- `event=webhook_processing_failed` — confirms the operator alert was emitted
- Container restart events (typically `Stopping container` or `Starting container`)

---

## Retention Policy

Rows are pruned after `MINSKY_REVIEWER_WEBHOOK_EVENT_RETENTION_DAYS` days (default: 90).
The pruner runs once per 24 hours (in-process `setInterval`).

90 days is sufficient for any plausible post-mortem investigation window. If an incident
is discovered after 90 days, the GitHub App delivery history (30-day retention) is likely
also expired — both the DB and GitHub-side sources will be unavailable at that point.

To extend retention, set the env var on the Railway service before deploying:

```
MINSKY_REVIEWER_WEBHOOK_EVENT_RETENTION_DAYS=180
```

---

## Operator Alert: webhook_processing_failed

When a dispatch error or reviewer failure occurs, the service emits:

```json
{
  "event": "webhook_processing_failed",
  "delivery_id": "...",
  "github_event": "pull_request",
  "stage": "reviewer",
  "error": "...",
  "level": "error"
}
```

This is the `OperatorNotify` equivalent for the Railway-deployed reviewer service.
Railway log monitoring can alert on `event=webhook_processing_failed` for automated
escalation. Distinct from mt#1310 alerts (which fire when an expected review is absent
from GitHub's perspective — a different detection point).

---

## Related

- mt#1372 — this task (forward instrumentation)
- mt#1310 — sibling alert: fires when expected review is absent from GitHub
- mt#1260 — sweeper: retriggers reviews when they're missing at sweep time
- mt#1110 — calibration data with historical missed-review instances
- `services/reviewer/src/webhook-events.ts` — persistence module
- `services/reviewer/src/db/schemas/webhook-events-schema.ts` — Drizzle schema
- `services/reviewer/scripts/smoke-webhook-events.ts` — verification smoke script
