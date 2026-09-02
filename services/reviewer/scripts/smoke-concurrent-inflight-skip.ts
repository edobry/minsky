#!/usr/bin/env bun
/**
 * L4 of the `concurrent_inflight` ladder (mt#4895 SC2/SC3): does a REAL reviewer
 * process, given two overlapping deliveries for one PR+sha, log the skip — and
 * does it then attempt to publish the `skipped` check-run (mt#4271)?
 *
 * Structural sibling of `kill-test.ts`: spawn a real server against a real
 * Postgres, drive real signed webhook POSTs, and assert on a STRUCTURED STDOUT
 * LOG LINE rather than on full pipeline correctness.
 *
 * The logic that DECIDES anything lives in `./inflight-skip-harness`, which the
 * suite covers directly (`inflight-skip-harness.test.ts`). This file is the
 * imperative shell — spawn, post, poll, clean up.
 *
 * ## Why a real target PR IS required here — unlike `kill-test.ts`
 *
 * `kill-test.ts` needs no real PR because `boot_recovery.dispatch` is emitted
 * BEFORE `runReview` is even called. **That does not carry over to this
 * mechanism, and mt#4895's spec originally claimed it did.**
 *
 * `runReview` reaches `acquireMarker` only after `createOctokit`
 * (`review-worker.ts:402`) and `fetchPullRequestContext` (`:404`), because the
 * marker is keyed on `pr.headSha` — which does not exist until the fetch
 * returns. `createOctokit` is a pure constructor and validates nothing, so it is
 * NOT the blocker; `fetchPullRequestContext` is, because it really calls
 * `pulls.get`. Against a synthetic PR or unusable credentials it throws, and
 * `runReview` dies BEFORE the marker — so no marker is acquired, no contention
 * is possible, and `runReview.skipped_concurrent_inflight` can never be emitted.
 *
 * So this script requires App credentials that can actually read a real PR. The
 * model call is still avoided (it runs after the marker check), which is the one
 * third of the original "no PR, no model call, no App token" claim that holds.
 *
 * ## Why it does not race
 *
 * Firing two webhooks back-to-back and hoping they overlap is a race whose
 * verdict is not stable across runs (mt#4895 AT2 asks for exactly that
 * stability). Instead the script SEQUENCES on observed state: it fires delivery
 * A, then polls `reviewer_inflight_reviews` until A's marker row actually
 * EXISTS, and only then fires delivery B. B is therefore guaranteed to meet a
 * live marker. Polling the row also supplies the head sha, so the operator does
 * not have to pass one that matches the PR's current head.
 *
 * ## Negative control (mt#4895 AT3) — `--negative-control`
 *
 * Same sequence, except the marker row is DELETED after A acquires it and
 * before B is fired (standing in for a release or a TTL expiry). B must then
 * observe NO skip. Without this the script cannot distinguish "contention
 * detected" from "always reports a skip" — the pass in the normal mode would
 * carry no information.
 *
 * Both modes must be exercised before this script is trusted (mt#2776: running
 * only the safe branch of a dual-mode script leaves the other branch's code
 * unexecuted).
 *
 * ## Required environment (script SKIPs with exit 0 if any is absent)
 *
 *   MINSKY_REVIEWER_APP_ID           — REAL; must be able to read the target PR
 *   MINSKY_REVIEWER_INSTALLATION_ID  — REAL
 *   MINSKY_REVIEWER_PRIVATE_KEY      — REAL
 *   MINSKY_REVIEWER_WEBHOOK_SECRET   — any value; shared by this script and the server
 *   REVIEWER_PROVIDER                — one of openai|google|anthropic
 *   <matching provider key>          — OPENAI_API_KEY / GOOGLE_AI_API_KEY / ANTHROPIC_API_KEY
 *   MINSKY_PERSISTENCE_POSTGRES_URL  — reachable Postgres (or MINSKY_POSTGRES_URL)
 *   INFLIGHT_TEST_OWNER              — owner of a real, open, readable PR
 *   INFLIGHT_TEST_REPO               — its repo
 *   INFLIGHT_TEST_PR                 — its number
 *
 * ## Operator note — this touches a real PR
 *
 * Delivery A starts a REAL review of the named PR (it is only interrupted when
 * this script exits), and the skip path posts a status comment and a `skipped`
 * check-run on it. Point it at a PR you own and are willing to have the reviewer
 * act on. That is why every coordinate is required rather than defaulted.
 *
 * ## Optional environment
 *
 *   INFLIGHT_TEST_PORT               — port for the spawned server (default 34601)
 *   INFLIGHT_TEST_MARKER_TIMEOUT_MS  — how long to wait for A's marker (default 60000)
 *   INFLIGHT_TEST_SKIP_TIMEOUT_MS    — how long to wait for B's verdict (default 30000)
 *
 * ## Exit codes
 *
 *   0 — pass, or skipped due to missing required env vars
 *   1 — fail (the expected verdict was not observed, or a setup error)
 */

import { sign } from "@octokit/webhooks-methods";
import postgres from "postgres";
import { join } from "node:path";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import {
  collectStdoutLines,
  deriveVerdict,
  findEvents,
  type HarnessMode,
} from "./inflight-skip-harness";

const NEGATIVE_CONTROL = process.argv.includes("--negative-control");

const SKIP_EVENT = "runReview.skipped_concurrent_inflight";
const PUBLISH_FAILED_EVENT = "review_skip_check_run_failed";
const CHECK_RUN_NAME = "minsky-reviewer/findings";

function skip(reason: string): never {
  console.log(`SKIP: ${reason}`);
  process.exit(0);
}

/**
 * Abort the run from INSIDE `main`'s try block.
 *
 * Deliberately a throw rather than `process.exit` (PR #3566 R1): `process.exit`
 * terminates immediately and the `finally` never runs, orphaning the spawned
 * reviewer server and leaving the Postgres connection open. Throwing lets the
 * cleanup run first; the top-level handler then sets the exit code.
 */
class HarnessFailure extends Error {}

function bail(reason: string): never {
  throw new HarnessFailure(reason);
}

// ---------------------------------------------------------------------------
// Environment resolution & skip gate
//
// `process.exit` IS correct in this section: it runs before anything is
// spawned or connected, so there is no cleanup to bypass.
// ---------------------------------------------------------------------------

const REQUIRED_PRESENT_ENV_VARS = [
  "MINSKY_REVIEWER_APP_ID",
  "MINSKY_REVIEWER_INSTALLATION_ID",
  "MINSKY_REVIEWER_PRIVATE_KEY",
  "MINSKY_REVIEWER_WEBHOOK_SECRET",
  "REVIEWER_PROVIDER",
  "INFLIGHT_TEST_OWNER",
  "INFLIGHT_TEST_REPO",
  "INFLIGHT_TEST_PR",
];

for (const name of REQUIRED_PRESENT_ENV_VARS) {
  if (!process.env[name]) skip(`${name} is not set`);
}

const PROVIDER = process.env["REVIEWER_PROVIDER"] as string;
const PROVIDER_KEY_ENV_BY_PROVIDER: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_AI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};
const providerKeyEnvName = PROVIDER_KEY_ENV_BY_PROVIDER[PROVIDER];
if (!providerKeyEnvName) {
  skip(`REVIEWER_PROVIDER="${PROVIDER}" is not one of openai|google|anthropic`);
}
if (!process.env[providerKeyEnvName]) {
  skip(`${providerKeyEnvName} is not set (required for REVIEWER_PROVIDER=${PROVIDER})`);
}

const POSTGRES_URL =
  process.env["MINSKY_PERSISTENCE_POSTGRES_URL"] ?? process.env["MINSKY_POSTGRES_URL"];
if (!POSTGRES_URL) {
  skip("MINSKY_PERSISTENCE_POSTGRES_URL (or MINSKY_POSTGRES_URL) is not set");
}

const WEBHOOK_SECRET = process.env["MINSKY_REVIEWER_WEBHOOK_SECRET"] as string;
const OWNER = process.env["INFLIGHT_TEST_OWNER"] as string;
const REPO = process.env["INFLIGHT_TEST_REPO"] as string;
const PR_NUMBER = Number(process.env["INFLIGHT_TEST_PR"]);
if (!Number.isInteger(PR_NUMBER) || PR_NUMBER <= 0) {
  console.error(
    `FAIL: INFLIGHT_TEST_PR must be a positive integer (got "${process.env["INFLIGHT_TEST_PR"]}")`
  );
  process.exit(1);
}

const PORT = Number(process.env["INFLIGHT_TEST_PORT"] ?? "34601");
const MARKER_TIMEOUT_MS = Number(process.env["INFLIGHT_TEST_MARKER_TIMEOUT_MS"] ?? "60000");
const SKIP_TIMEOUT_MS = Number(process.env["INFLIGHT_TEST_SKIP_TIMEOUT_MS"] ?? "30000");

const SERVER_ENTRY = join(import.meta.dir, "..", "src", "server.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StructuredResult {
  pass: boolean;
  mode: HarnessMode;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string | null;
  deliveryA: string;
  deliveryB: string;
  skipObservedForDeliveryB: boolean;
  skipObservedForDeliveryA: boolean;
  skipCheckRunAttempted: boolean | null;
  skipCheckRunConclusion: string | null;
  reason: string;
}

function baseEnv(port: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    PORT: String(port),
    // Only the mechanism under test should run — a sweeper firing its own
    // review of this PR would acquire the marker and make the verdict
    // unattributable to delivery A.
    SWEEPER_ENABLED: "false",
    MERGE_STATE_SWEEPER_ENABLED: "false",
    PR_WATCH_ENABLED: "false",
    ASKS_RECONCILE_ENABLED: "false",
    ADOPTION_SWEEPER_ENABLED: "false",
    REVIEWER_BOOT_RECOVERY_ENABLED: "false",
  };
}

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.status === 200) return true;
    } catch {
      // Not up yet — retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function terminateWithGrace(
  proc: ReturnType<typeof Bun.spawn>,
  graceMs: number
): Promise<void> {
  proc.kill("SIGTERM");
  const exited = proc.exited.then(() => "exited" as const);
  const grace = new Promise<"timed_out">((resolve) =>
    setTimeout(() => resolve("timed_out"), graceMs)
  );
  const outcome = await Promise.race([exited, grace]);
  if (outcome === "timed_out" && proc.exitCode === null) {
    console.warn(`inflight-skip: server did not exit within ${graceMs}ms of SIGTERM — SIGKILLing.`);
    proc.kill("SIGKILL");
    await proc.exited;
  }
}

function signedWebhookBody(headSha: string): string {
  return JSON.stringify({
    action: "synchronize",
    pull_request: {
      number: PR_NUMBER,
      user: { login: "inflight-skip-test" },
      draft: false,
      head: { sha: headSha },
    },
    repository: { owner: { login: OWNER }, name: REPO },
  });
}

async function postWebhook(payload: string, deliveryId: string): Promise<number> {
  const signature = await sign(WEBHOOK_SECRET, payload);
  const res = await fetch(`http://localhost:${PORT}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      "x-github-delivery": deliveryId,
      "x-github-event": "pull_request",
    },
    body: payload,
  });
  return res.status;
}

/**
 * Poll `reviewer_inflight_reviews` until a LIVE marker row exists for this PR,
 * and return its head sha. This is the sequencing point that makes the verdict
 * deterministic: until it returns, delivery A has not yet acquired anything and
 * firing B would be a race.
 */
async function waitForLiveMarker(
  sql: ReturnType<typeof postgres>,
  timeoutMs: number
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql<{ head_sha: string }[]>`
      SELECT head_sha FROM reviewer_inflight_reviews
      WHERE owner = ${OWNER} AND repo = ${REPO} AND pr_number = ${PR_NUMBER}
        AND expires_at > now()
      LIMIT 1`;
    const row = rows[0];
    if (row !== undefined) return row.head_sha;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function deleteMarker(sql: ReturnType<typeof postgres>, headSha: string): Promise<number> {
  const deleted = await sql`
    DELETE FROM reviewer_inflight_reviews
    WHERE owner = ${OWNER} AND repo = ${REPO} AND pr_number = ${PR_NUMBER}
      AND head_sha = ${headSha}
    RETURNING id`;
  return deleted.length;
}

/**
 * SC3: the skip is only useful if it SURFACES. Read the check-runs on the sha
 * and report the `minsky-reviewer/findings` conclusion, so a pass distinguishes
 * "the skip happened" from "the skip happened and was published".
 */
async function readSkipCheckRunConclusion(headSha: string): Promise<string | null> {
  try {
    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: Number(process.env["MINSKY_REVIEWER_APP_ID"]),
        privateKey: process.env["MINSKY_REVIEWER_PRIVATE_KEY"] as string,
        installationId: Number(process.env["MINSKY_REVIEWER_INSTALLATION_ID"]),
      },
    });
    const res = await octokit.rest.checks.listForRef({
      owner: OWNER,
      repo: REPO,
      ref: headSha,
      check_name: CHECK_RUN_NAME,
      per_page: 20,
    });
    const latest = res.data.check_runs[0];
    return latest?.conclusion ?? null;
  } catch (err: unknown) {
    console.warn(
      `inflight-skip: could not read check-runs for ${headSha}: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const stamp = Date.now();
  const deliveryA = `inflight-skip-a-${stamp}`;
  const deliveryB = `inflight-skip-b-${stamp}`;
  const mode: HarnessMode = NEGATIVE_CONTROL ? "negative-control" : "contention";

  console.log(
    `inflight-skip: mode=${mode} owner=${OWNER} repo=${REPO} pr=${PR_NUMBER} port=${PORT}`
  );

  const sql = postgres(POSTGRES_URL as string);
  const proc = Bun.spawn({
    cmd: ["bun", "run", SERVER_ENTRY],
    env: baseEnv(PORT),
    stdout: "pipe",
    stderr: "pipe",
  });
  const { lines, done } = collectStdoutLines(proc.stdout);

  let headSha: string | null = null;
  let checkRunConclusion: string | null = null;

  try {
    if (!(await waitForHealth(PORT, 20_000))) bail("server did not become healthy within 20s");
    console.log("inflight-skip: server healthy — firing delivery A...");

    // Delivery A's payload carries a placeholder sha; `runReview` keys the
    // marker on the sha it FETCHES from GitHub, which is the authoritative one
    // and the one we then read back out of the marker row.
    const statusA = await postWebhook(signedWebhookBody("0".repeat(40)), deliveryA);
    if (statusA !== 200) bail(`delivery A did not return 200 (got ${statusA})`);

    console.log("inflight-skip: waiting for delivery A's marker row...");
    headSha = await waitForLiveMarker(sql, MARKER_TIMEOUT_MS);
    if (headSha === null) {
      bail(
        `no live marker row appeared for ${OWNER}/${REPO}#${PR_NUMBER} within ${MARKER_TIMEOUT_MS}ms. ` +
          `Delivery A never reached acquireMarker — most likely the App credentials cannot read ` +
          `that PR, which is a prerequisite (see this file's header).`
      );
    }
    console.log(`inflight-skip: marker held for head_sha=${headSha}`);

    if (NEGATIVE_CONTROL) {
      const removed = await deleteMarker(sql, headSha);
      if (removed === 0) bail("negative control could not delete the marker row it just observed");
      console.log(
        `inflight-skip: [negative control] deleted the marker row (${removed}) — B should NOT skip`
      );
    }

    console.log("inflight-skip: firing delivery B against the same PR+sha...");
    const statusB = await postWebhook(signedWebhookBody(headSha), deliveryB);
    if (statusB !== 200) bail(`delivery B did not return 200 (got ${statusB})`);

    // Wait for B's verdict. In contention mode the skip should appear quickly;
    // in negative-control mode we wait the SAME budget to give a (wrong) skip
    // every chance to show up — a control that waits less than the positive case
    // could pass merely by not looking long enough.
    const deadline = Date.now() + SKIP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (findEvents(lines, SKIP_EVENT).some((e) => e["delivery_id"] === deliveryB)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (!NEGATIVE_CONTROL) {
      checkRunConclusion = await readSkipCheckRunConclusion(headSha);
    }
  } finally {
    await terminateWithGrace(proc, 10_000);
    // Drain the reader BEFORE anything reads `lines` (PR #3566 R1): the process
    // has exited, but buffered output may still be in flight, and a terminal
    // event is exactly what arrives last.
    await done;
    await sql.end().catch(() => {});
  }

  const skipEvents = findEvents(lines, SKIP_EVENT);
  const verdict = deriveVerdict({
    mode,
    skipForB: skipEvents.some((e) => e["delivery_id"] === deliveryB),
    skipForA: skipEvents.some((e) => e["delivery_id"] === deliveryA),
    publishFailed: findEvents(lines, PUBLISH_FAILED_EVENT).length > 0,
    checkRunConclusion,
  });

  const result: StructuredResult = {
    pass: verdict.pass,
    mode,
    owner: OWNER,
    repo: REPO,
    prNumber: PR_NUMBER,
    headSha,
    deliveryA,
    deliveryB,
    skipObservedForDeliveryB: skipEvents.some((e) => e["delivery_id"] === deliveryB),
    skipObservedForDeliveryA: skipEvents.some((e) => e["delivery_id"] === deliveryA),
    skipCheckRunAttempted: verdict.skipCheckRunAttempted,
    skipCheckRunConclusion: checkRunConclusion,
    reason: verdict.reason,
  };

  console.log(JSON.stringify(result, null, 2));

  if (!verdict.pass) {
    console.error(`FAIL: ${verdict.reason}`);
    console.error("--- server stdout tail ---");
    console.error(lines.slice(-40).join("\n"));
  } else {
    console.log(`PASS: ${verdict.reason}`);
  }

  process.exitCode = verdict.pass ? 0 : 1;
}

try {
  await main();
} catch (err: unknown) {
  // Cleanup has already run in `main`'s finally by the time we get here.
  console.error(`FAIL: ${err instanceof HarnessFailure ? err.message : String(err)}`);
  process.exitCode = 1;
}
