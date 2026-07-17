#!/usr/bin/env bun
/**
 * Kill-test: boot-time review recovery after an interrupted redeploy
 * (mt#2799 Layer 2 — durable review queue, re-escalation of mt#1966's
 * deferred durable-queue half per bridge memory 22dd1b42's step 5).
 *
 * ## What this verifies
 *
 * Spawns TWO reviewer server processes in sequence against the SAME
 * Postgres database, simulating a Railway redeploy that kills the old
 * container mid-review:
 *
 *   1. Process 1 ("victim") boots, receives a real signed webhook POST to
 *      /webhook (so the server's normal pre-ACK persistence path runs —
 *      see server.ts's AWAITed `recordWebhookReceipt` call, mt#2799 SC#3).
 *   2. The INSTANT the 200 ACK is received, process 1 is SIGKILLed — no
 *      grace period. This is the worst case Layer 1's drain window is
 *      meant to avoid; Layer 2 (boot recovery) must cover it independently
 *      of whether the drain ever got a chance to run.
 *   3. Process 2 ("successor") boots against the same database and runs
 *      its boot-time recovery pass (boot-recovery.ts). The script watches
 *      process 2's stdout for the `boot_recovery.dispatch` structured log
 *      line carrying the `recovered-<original-delivery-id>` tag, and
 *      measures the time from process 2's spawn to that log line.
 *
 * PASS criterion (mt#2799 AT#3 — "service boot dispatches the review
 * within 30s"): the `boot_recovery.dispatch` log line for the recovered
 * delivery ID appears within KILL_TEST_DISPATCH_DEADLINE_MS (default
 * 30000) of process 2's boot. This script deliberately asserts DISPATCH,
 * not full review completion — a real review's GitHub+model round trip
 * commonly takes 60-90s (see review-worker.ts config comments), which
 * would make "completes within 30s" an unreconcilable criterion; AT#3's
 * literal wording is "dispatches ... within 30s", which is what's checked.
 *
 * ## Why a real target GitHub PR is NOT required
 *
 * The `boot_recovery.dispatch` log line is emitted BEFORE runReviewFn is
 * even called (see boot-recovery.ts) — dispatch is independent of whether
 * the recovered review can actually complete against a real PR. Unless
 * KILL_TEST_OWNER/REPO/PR/HEAD_SHA are set to a real, reachable PR, the
 * recovered review will itself fail at the GitHub-fetch step (persisted as
 * failed_at_reviewer) — that failure is EXPECTED and does not affect this
 * script's pass/fail verdict, which is scoped to the recovery MECHANISM,
 * not full review-pipeline correctness (covered elsewhere).
 *
 * ## Why MINSKY_REVIEWER_WEBHOOK_SECRET does not need to be a live secret
 *
 * Both this script (which signs the synthetic webhook payload) and the
 * spawned server processes (which verify it) read the SAME env var, so any
 * value works as long as it's consistent — it does not need to match the
 * real production GitHub App's configured secret. The GitHub App id /
 * installation id / private key env vars are similarly only required to be
 * NON-EMPTY strings for the server to boot (config.ts's `requireEnv` does
 * not validate them against a live GitHub App); they only need to be
 * *real* if KILL_TEST_OWNER/REPO/PR point at an actual PR the operator
 * wants the recovered review to complete against.
 *
 * ## Required environment variables (script SKIPs, exit 0, if any absent)
 *
 *   MINSKY_REVIEWER_APP_ID           — any non-empty string (server boot requirement)
 *   MINSKY_REVIEWER_INSTALLATION_ID  — any non-empty string (server boot requirement)
 *   MINSKY_REVIEWER_PRIVATE_KEY      — any non-empty string (server boot requirement)
 *   MINSKY_REVIEWER_WEBHOOK_SECRET   — any string; shared by script + server (see above)
 *   REVIEWER_PROVIDER                — one of openai|google|anthropic
 *   <matching provider key>          — OPENAI_API_KEY / GOOGLE_AI_API_KEY / ANTHROPIC_API_KEY
 *   MINSKY_PERSISTENCE_POSTGRES_URL  — reachable Postgres (or MINSKY_POSTGRES_URL) — the ONE
 *                                      genuinely "live" dependency this script needs
 *
 * ## Optional environment variables
 *
 *   KILL_TEST_OWNER / KILL_TEST_REPO / KILL_TEST_PR / KILL_TEST_HEAD_SHA
 *     — point at a real, reachable PR to additionally exercise full review
 *       completion post-recovery. Defaults to a synthetic non-existent PR
 *       (recovery mechanism is still fully exercised — see above).
 *   KILL_TEST_PORT                   — port for both spawned processes (default 34599)
 *   KILL_TEST_DISPATCH_DEADLINE_MS    — pass/fail threshold (default 30000, per AT#3)
 *
 * ## Exit codes
 *
 *   0 — pass, or skipped due to missing required env vars
 *   1 — fail (dispatch not observed within the deadline, or a setup error)
 *
 * Per §7a: this is the verification artifact for the mt#2799 structural
 * change (new persistence-backed recovery path). Written by the
 * implementer subagent WITHOUT live credentials in scope; the main agent
 * / operator runs it post-PR with a real environment (see PR body's
 * "## Live verification" section for the SKIP-mode dry run this session
 * COULD perform, and what remains UNVERIFIED pending a live run).
 */

import { sign } from "@octokit/webhooks-methods";
import postgres from "postgres";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Environment resolution & skip gate
// ---------------------------------------------------------------------------

function skip(reason: string): never {
  console.log(`SKIP: ${reason}`);
  process.exit(0);
}

function fail(reason: string): never {
  console.error(`FAIL: ${reason}`);
  process.exit(1);
}

const REQUIRED_PRESENT_ENV_VARS = [
  "MINSKY_REVIEWER_APP_ID",
  "MINSKY_REVIEWER_INSTALLATION_ID",
  "MINSKY_REVIEWER_PRIVATE_KEY",
  "MINSKY_REVIEWER_WEBHOOK_SECRET",
  "REVIEWER_PROVIDER",
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

// Target PR: real if the operator supplies one, else a synthetic
// placeholder (see header doc — the recovery-dispatch assertion does not
// require a real PR).
const OWNER = process.env["KILL_TEST_OWNER"] ?? "edobry";
const REPO = process.env["KILL_TEST_REPO"] ?? "minsky";
const PR_NUMBER = Number(process.env["KILL_TEST_PR"] ?? "999999");
const HEAD_SHA = (
  process.env["KILL_TEST_HEAD_SHA"] ?? `killtest${Date.now().toString(16)}0000000000000000000000`
).slice(0, 40);

const PORT = Number(process.env["KILL_TEST_PORT"] ?? "34599");
const DISPATCH_DEADLINE_MS = Number(process.env["KILL_TEST_DISPATCH_DEADLINE_MS"] ?? "30000");

const SERVER_ENTRY = join(import.meta.dir, "..", "src", "server.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StructuredResult {
  pass: boolean;
  killedAt: string;
  secondBootAt: string;
  dispatchObservedAt: string | null;
  dispatchLatencyMs: number | null;
  deadlineMs: number;
  originalDeliveryId: string;
  recoveredDeliveryId: string;
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
    // Isolate this test from the OTHER background schedulers — only the
    // mechanism under test (boot recovery) should run.
    SWEEPER_ENABLED: "false",
    MERGE_STATE_SWEEPER_ENABLED: "false",
    PR_WATCH_ENABLED: "false",
    ASKS_RECONCILE_ENABLED: "false",
    ADOPTION_SWEEPER_ENABLED: "false",
    REVIEWER_BOOT_RECOVERY_ENABLED: "true",
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

/** Read a spawned process's stdout, watching for `needle`. Never throws. */
function watchStdoutForNeedle(
  stdout: ReadableStream<Uint8Array> | null,
  needle: string,
  onFound: () => void
): { chunks: string[] } {
  const chunks: string[] = [];
  if (!stdout) return { chunks };

  void (async () => {
    try {
      const reader = stdout.getReader();
      const decoder = new TextDecoder();
      let found = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        chunks.push(text);
        if (!found && text.includes(needle)) {
          found = true;
          onFound();
        }
      }
    } catch {
      // Best-effort background reader — a read error must not crash the script.
    }
  })();

  return { chunks };
}

/**
 * Send SIGTERM and wait up to `graceMs` for the process to exit on its own;
 * SIGKILL if it hasn't. Defense in depth so a server-side hang (e.g. the
 * mt#2799 kill-test finding: a background setInterval keeping the process
 * alive after gracefulShutdown logically completes) cannot make THIS script
 * hang indefinitely on `await proc.exited`.
 */
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
    console.warn(`kill-test: process did not exit within ${graceMs}ms of SIGTERM — SIGKILLing.`);
    proc.kill("SIGKILL");
    await proc.exited;
  }
}

async function cleanupSeededRow(deliveryId: string): Promise<void> {
  const sql = postgres(POSTGRES_URL as string);
  try {
    await sql`DELETE FROM reviewer_webhook_events WHERE delivery_id = ${deliveryId}`;
  } catch {
    // Best-effort — does not affect the already-computed pass/fail verdict.
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const deliveryId = `kill-test-${Date.now()}`;
  const recoveredDeliveryId = `recovered-${deliveryId}`;

  const payload = JSON.stringify({
    action: "synchronize",
    pull_request: {
      number: PR_NUMBER,
      user: { login: "kill-test-author" },
      draft: false,
      head: { sha: HEAD_SHA },
    },
    repository: { owner: { login: OWNER }, name: REPO },
  });

  console.log(
    `kill-test: owner=${OWNER} repo=${REPO} pr=${PR_NUMBER} deliveryId=${deliveryId} port=${PORT}`
  );

  console.log("kill-test: spawning process 1 (victim)...");
  const proc1 = Bun.spawn({
    cmd: ["bun", "run", SERVER_ENTRY],
    env: baseEnv(PORT),
    stdout: "pipe",
    stderr: "pipe",
  });

  let killedAt: Date;

  try {
    const up1 = await waitForHealth(PORT, 20_000);
    if (!up1) fail("process 1 did not become healthy within 20s");

    console.log("kill-test: process 1 healthy — sending webhook...");
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

    killedAt = new Date();
    console.log(`kill-test: webhook POST -> HTTP ${res.status} at ${killedAt.toISOString()}`);
    if (res.status !== 200) fail(`webhook POST did not return 200 (got ${res.status})`);

    // Kill IMMEDIATELY, no grace — the worst case Layer 1's drain window
    // exists to avoid. Layer 2 (this recovery mechanism) must not depend
    // on the drain having had any chance to run.
    proc1.kill("SIGKILL");
    await proc1.exited;
    console.log("kill-test: process 1 killed (SIGKILL).");
  } finally {
    if (proc1.exitCode === null) {
      proc1.kill("SIGKILL");
      await proc1.exited;
    }
  }

  console.log("kill-test: spawning process 2 (successor)...");
  const secondBootAt = new Date();
  const proc2 = Bun.spawn({
    cmd: ["bun", "run", SERVER_ENTRY],
    env: baseEnv(PORT),
    stdout: "pipe",
    stderr: "pipe",
  });

  let dispatchObservedAt: Date | null = null;
  const { chunks } = watchStdoutForNeedle(proc2.stdout, recoveredDeliveryId, () => {
    dispatchObservedAt = new Date();
  });

  try {
    const deadline = Date.now() + DISPATCH_DEADLINE_MS;
    while (!dispatchObservedAt && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    await terminateWithGrace(proc2, 10_000);
  }

  const dispatchLatencyMs = dispatchObservedAt
    ? (dispatchObservedAt as Date).getTime() - secondBootAt.getTime()
    : null;
  const pass = dispatchLatencyMs !== null && dispatchLatencyMs <= DISPATCH_DEADLINE_MS;

  const result: StructuredResult = {
    pass,
    killedAt: killedAt.toISOString(),
    secondBootAt: secondBootAt.toISOString(),
    dispatchObservedAt: dispatchObservedAt ? (dispatchObservedAt as Date).toISOString() : null,
    dispatchLatencyMs,
    deadlineMs: DISPATCH_DEADLINE_MS,
    originalDeliveryId: deliveryId,
    recoveredDeliveryId,
    reason: pass
      ? `recovery dispatched ${dispatchLatencyMs}ms after process 2's boot (deadline ${DISPATCH_DEADLINE_MS}ms)`
      : `no boot_recovery.dispatch log line for ${recoveredDeliveryId} observed within ` +
        `${DISPATCH_DEADLINE_MS}ms of process 2's boot`,
  };

  console.log(JSON.stringify(result, null, 2));

  if (!pass) {
    console.error(`FAIL: ${result.reason}`);
    console.error("--- process 2 stdout tail ---");
    console.error(chunks.join("").split("\n").slice(-40).join("\n"));
  } else {
    console.log(`PASS: ${result.reason}`);
  }

  await cleanupSeededRow(deliveryId);

  process.exitCode = pass ? 0 : 1;
}

await main();
