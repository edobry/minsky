# 2026-05-20 reviewer-bot triple-failure on PR #1186

**Incident task:** mt#1963
**Affected PRs:** #1185 (mt#1957), #1186 (mt#1934), #1187 (mt#1961)
**Window:** 2026-05-20T18:43:01Z – 18:59:23Z (UTC)
**Detection:** Operator-observed during PR #1186 review wait; confirmed via Railway logs

## TL;DR

PR #1186 failed to receive a `minsky-reviewer[bot]` review across three nested
failures that turned out to be one cascade plus two independent degradation classes:

1. **Layer 1** — Container restart on the reviewer service between 18:44:23 and 18:45:05Z
   killed three in-flight detached-promise reviews scheduled by the webhook handler.
   The webhooks were delivered successfully (status=200 in ~0.23s); the work was lost
   when the container restarted.
2. **Layer 2** — The reviewer service's Postgres database is **missing the
   `reviewer_webhook_events` and `reviewer_inflight_reviews` tables** despite
   `migrations_applied` logging success at boot. Postgres `42P01 (undefined_table)`
   structured error. **The reviewer service is currently degraded in production:** 33
   DB query failures observed in the 1-hour visible log window. mt#1907's
   inflight-marker race prevention is structurally inert.
3. **Layer 3** — All three concurrent sweeper retriggers (including the tiny
   PR #1187) timed out at the 120s `openai.chat.completions.create.toolloop` cap.
   Diff size was the spec's original hypothesis but is disconfirmed by PR #1187's
   participation in the timeout pattern.

## Timeline (UTC)

| Time                 | Event                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 18:00:24             | Reviewer service deploy `feda989a` created                                                                                               |
| 18:43:01             | PR #1185 (mt#1957) opened                                                                                                                |
| 18:43:03             | PR #1185 `pull_request.opened` webhook delivered, status=200, dur=0.23s                                                                  |
| 18:43:54             | PR #1186 (mt#1934) opened                                                                                                                |
| 18:43:56             | PR #1186 `pull_request.opened` webhook delivered, status=200, dur=0.24s                                                                  |
| 18:44:19             | PR #1187 (mt#1961) opened                                                                                                                |
| 18:44:22             | PR #1187 `pull_request.opened` webhook delivered, status=200, dur=0.23s                                                                  |
| 18:44:23             | Last successful webhook ACK (`pull_request.labeled` for #1187)                                                                           |
| ~18:44:23 – 18:45:05 | **Container restart window (cause: NOT in visible log retention)**                                                                       |
| 18:45:05             | `migrations_applied` + `server_started` log events (NEW container ready)                                                                 |
| 18:55:05             | First sweeper cycle of new container (`sweeper.cycle_start`)                                                                             |
| 18:55:06             | `sweeper.missing_review` × 3 (PRs #1187, #1186, #1185)                                                                                   |
| 18:55:16             | `sweeper.marker_lookup_failed_proceeding` (DB 42P01); `sweeper.primary_webhook_failing` alert; sweeper retrigger × 3 starts concurrently |
| 18:55:17             | `runReview.marker_acquire_failed_fail_open` × 3 (DB 42P01 again)                                                                         |
| 18:56:08             | `webhook_event_record_failed` (DB 42P01, `relation "reviewer_webhook_events" does not exist`)                                            |
| 18:56:22             | PR #1187 auto-merged (mt#1961, separate merge path)                                                                                      |
| 18:57:23             | `sweeper.retrigger_failed` for PR #1186 (toolloop timeout @ 127s)                                                                        |
| 18:58:53             | `sweeper.retrigger_failed` for PR #1185 (toolloop timeout @ 217s)                                                                        |
| 18:59:23             | `sweeper.retrigger_failed` for PR #1187 (toolloop timeout @ 247s)                                                                        |

## Root causes per layer

### Layer 1 — Detached-promise + container restart

`services/reviewer/src/server.ts:170` (`startDetachedReview`) schedules `runReview` as a
fire-and-forget promise and returns 200 to GitHub before the work completes. If the
container exits, the promise is killed; work is lost. The 10-min sweeper backstop is
the documented recovery path but lags by up to 10 min and (during this incident) hit
Layers 2 + 3 and failed independently.

The container-restart cause is NOT in the available log retention — no SIGTERM / OOM /
health-check-failure signals are visible. Restart-cause observability gap is a sibling
follow-up.

### Layer 2 — Drizzle migration state out of sync with actual schema

The `webhook_event_record_failed` log line at 18:56:08Z (the one log site that DOES use
`extractPgErrorContext`) contains:

```
error_code="42P01"
error_detail="relation \"reviewer_webhook_events\" does not exist"
error_severity="ERROR"
```

`reviewer_webhook_events` (added in `0001_webhook_events.sql` per mt#1372) and likely
`reviewer_inflight_reviews` (added in `0002_inflight_reviews.sql` per mt#1907) don't
exist in the live database, despite drizzle's migrator logging
`migrations_applied event="migrations_applied"` on boot. Classic out-of-sync state
between `drizzle.__drizzle_migrations` (records migration as applied) and `pg_tables`
(table doesn't exist).

Three of the four DB-error log sites (sweeper.ts:298,474,529 and review-worker.ts:876)
log `error: <drizzle_message>` without the structured `extractPgErrorContext` shape,
which is why the original spec believed the error was opaque — the helper exists but
isn't called.

### Layer 3 — LLM toolloop timeout NOT diff-size correlated

PR #1187 is a tiny diff (2 files, 8 additions / 10 deletions). Its sweeper retrigger
ALSO timed out at the 120s cap, at +247s after start. Diff size cannot be the
explanation.

The 120s cap (providers.ts:29 / config.ts:149 `REVIEWER_MODEL_TIMEOUT_MS`) wraps a
SINGLE `openai.chat.completions.create.toolloop` call. The toolloop issues multiple
sequential SDK calls; timeout fires when one inner call hangs. Per
`feedback_reviewer_bot_actual_latency_calibration_data`, normal first-pass review fires
in ~80-90s, so 120s SHOULD be enough for healthy paths. The 120s cap caught genuine slow
paths uniformly across all three concurrent retriggers — pointing at either
provider-side slowness during the window or concurrent toolloop contention at the
gpt-5 endpoint.

## Filed subtasks

- **mt#1966** — Layer 1: durable detached-review schedule + restart-cause observability
- **mt#1967** — Layer 2a: drizzle migration state reconciliation (most urgent — live
  production degradation)
- **mt#1968** — Layer 2b: wire `extractPgErrorContext` into the four error log sites
  that currently lose postgres error codes
- **mt#1969** — Layer 3: bound concurrent toolloop budget (3→1) + add timeout-retry path

## Diagnostic patterns surfaced

### How to read the `minsky-reviewer` GitHub App's webhook delivery log

The GitHub App's webhook delivery log is at the App-level endpoint, NOT a repo-level
endpoint. The user-token-authenticated `gh` CLI can NOT access it — it requires the
App's JWT.

Steps:

1. Read the App's private key from `~/.config/minsky/railway-secrets.json`
   (`MINSKY_REVIEWER_PRIVATE_KEY` key)
2. Mint a JWT with claim `{iat: now-60, exp: now+540, iss: "<App ID>"}` signed RS256.
   App ID is `3470137` (hard-coded in `services/reviewer/railway.config.ts`).
3. `curl -H "Authorization: Bearer $JWT" -H "Accept: application/vnd.github+json"
https://api.github.com/app/hook/deliveries?per_page=30`
4. Each delivery record contains: `delivered_at`, `event`, `action`, `status_code`,
   `duration`, `id`, `redelivery`. `GET .../deliveries/<id>` returns the full
   request/response detail including the response body and Railway edge headers.

This pattern reproducibly distinguishes "GitHub never sent" (no delivery) from
"GitHub sent but we 5xx'd" (delivery with 5xx status) from "we ACKed 200 but lost the
work" (delivery with 200 status).

## Evidence sources

**Disclaimer.** This memo's findings are derived from runtime observability surfaces
external to the repository (Railway service logs and the GitHub App's webhook delivery
log). The log retention windows are limited (Railway: ~24h visible from CLI; GitHub
App: 30 days). Assertions about specific log events below were extracted at the time of
investigation (2026-05-20); future readers reproducing the same query against the same
deployment may encounter log rotation. For long-lived evidence, consult the `mt#1963`
spec's `## Findings` section and the four filed subtask specs, which capture the
salient log shapes verbatim.

### Railway log source

- **Service:** `minsky-reviewer-webhook` (Railway service ID
  `3913e8a4-81ab-465a-aad8-b76b5e3f66ed`, project ID
  `41e5ee9c-49e6-44ff-9bfe-7f03d0e94d4b`, environment ID
  `b3ea3f5d-8560-40ea-8824-17fe3ca0b32a`).
- **Deployment under investigation:** `feda989a-fcde-4b52-bb03-94646462eeca`
  (SUCCESS, deployed 2026-05-20T18:00:24Z UTC).
- **Query commands used:**
  - `railway logs --deployment feda989a-fcde-4b52-bb03-94646462eeca`
  - `railway logs --deployment feda989a-fcde-4b52-bb03-94646462eeca | grep -cE "marker_lookup_failed|marker_acquire_failed|webhook_event_record_failed"`
    → returned `33` (basis for the "33 DB query failures" claim).

### GitHub App webhook delivery log

- **Endpoint:** `GET /app/hook/deliveries?per_page=30` (App-JWT authenticated;
  user-token `gh` CLI returns 404).
- **App ID:** `3470137` (`minsky-reviewer`, declared in
  `services/reviewer/railway.config.ts`).
- **Reproducer:** see project-scope memory id `a154d19f-5f15-41ee-bf47-0176b1367675`
  ("How to read minsky-reviewer GitHub App's webhook delivery log via App JWT") for
  the JWT-mint + curl recipe used to verify the 6 deliveries for PRs #1185/#1186/#1187
  returned status=200 in 0.21–0.24s.

### Specific log events cited

The discriminating events extracted from Railway logs for the incident window:

| Time (UTC)    | Event name                                  | Verbatim signal                                                                                                                                                                                    |
| ------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 18:45:05.351Z | `migrations_applied`                        | `event="migrations_applied" timestamp="2026-05-20T18:45:05.016Z"` (drizzle migrator claims success)                                                                                                |
| 18:45:05.352Z | `server_started`                            | Container ready, post-restart                                                                                                                                                                      |
| 18:55:05.658Z | `merge_state_sweeper.cycle_end`             | DB was healthy at this moment (sessionsScanned=20, errors=[])                                                                                                                                      |
| 18:55:06.547Z | `sweeper.missing_review`                    | `pr=1186 headSha="66073de39d4607955106541ddda71792ad0b8610" reason="no_review_by_bot"`                                                                                                             |
| 18:55:16.623Z | `sweeper.marker_lookup_failed_proceeding`   | DB SELECT failed on `reviewer_inflight_reviews`                                                                                                                                                    |
| 18:55:16.623Z | `sweeper.primary_webhook_failing`           | `missingPrNumbers=[1187,1186,1185]`                                                                                                                                                                |
| 18:55:17.533Z | `runReview.marker_acquire_failed_fail_open` | DB INSERT failed on `reviewer_inflight_reviews`                                                                                                                                                    |
| 18:56:08.703Z | `webhook_event_record_failed`               | **`error_code="42P01" error_detail="relation \"reviewer_webhook_events\" does not exist" error_severity="ERROR"`** (the load-bearing finding — the one log site that uses `extractPgErrorContext`) |
| 18:57:23.007Z | `sweeper.retrigger_failed`                  | `pr=1186 error="Operation timed out after 120000ms: openai.chat.completions.create.toolloop"`                                                                                                      |
| 18:58:53.108Z | `sweeper.retrigger_failed`                  | `pr=1185` (same toolloop timeout)                                                                                                                                                                  |
| 18:59:23.114Z | `sweeper.retrigger_failed`                  | `pr=1187` (same toolloop timeout — **tiny diff**, disconfirms diff-size hypothesis)                                                                                                                |

### Failure-count methodology

The "33 DB query failures" claim came from running:

```bash
railway logs --deployment feda989a-fcde-4b52-bb03-94646462eeca \
  | grep -cE "marker_lookup_failed|marker_acquire_failed|webhook_event_record_failed"
```

The count covers the visible log window (from `server_started` at 18:45:05Z through
the time of investigation ~19:55Z, ~1h10m). Time-bucket distribution shows clustering
at every sweeper cycle (10-min cadence: 18:55, 19:05, 19:09) plus on every webhook
receipt (`webhook_event_record_failed` fires from `recordWebhookReceipt` for each
inbound delivery).

## Cross-references

- mt#1963 — investigation umbrella (this incident)
- mt#1260 — periodic sweeper (the recovery layer that detected the missed reviews)
- mt#1372 — webhook-events persistence (the table that's missing)
- mt#1907 — inflight-marker race prevention (structurally inert until Layer 2a fixed)
- `feedback_reviewer_bot_actual_latency_calibration_data` (id `ca0a49e6`) — empirical
  latency calibration data
- Sibling failure classes: mt#1305 (CoT-leakage), mt#1810 (422-anchor + CoT-leakage),
  mt#1656 (silent webhook miss class)
