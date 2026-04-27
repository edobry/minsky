#!/usr/bin/env bun
/**
 * Reviewer-service health monitor.
 *
 * Pulls the minsky-reviewer GitHub App's webhook delivery history and
 * cross-checks against PR review state in edobry/minsky. Reports:
 *   Phase 1: pull_request deliveries fast-200 (code=200 dur<2s) vs timeouts (code=0 dur>=9s)
 *   Phase 2: open non-draft PRs missing a minsky-reviewer[bot] review at HEAD SHA
 *   Verdict: PASS / NOT MET / INCONCLUSIVE based on both phases
 *
 * Originally built to verify mt#1191 SC #4 (post-fix monitoring) on 2026-04-27;
 * lifted into scripts/ for ongoing reviewer-incident triage. The deliveries API
 * shows whether ack-immediate (mt#1258) is keeping every webhook under the 10s
 * GitHub timeout. The review-coverage check shows whether anything is slipping
 * past both the primary handler and the sweeper safety net (mt#1260).
 *
 * USAGE
 *   GH_TOKEN=$(gh auth token) bun scripts/monitor-reviewer-health.ts <arg>
 *
 *   <arg>: either lookback hours as integer (e.g. `4`) OR an absolute ISO8601
 *          timestamp (e.g. `2026-04-27T19:11:49Z`). Use the timestamp form to
 *          window an audit cleanly past a known deploy boundary.
 *
 * CREDENTIALS
 *   - Local PEM at ~/.config/minsky/minsky-reviewer.pem (signs the App JWT for
 *     /app/hook/deliveries). Required for Phase 1.
 *   - GH_TOKEN env var (user PAT or installation token). Required for Phase 2 —
 *     the user-API leg uses ~36 calls per run and unauthenticated requests will
 *     hit the rate limit. Without GH_TOKEN, Phase 1 still works; Phase 2 will
 *     fail on rate limit partway through.
 *
 * EXAMPLES
 *   # Last 4 hours
 *   GH_TOKEN=$(gh auth token) bun scripts/monitor-reviewer-health.ts 4
 *
 *   # Since a specific deploy
 *   GH_TOKEN=$(gh auth token) bun scripts/monitor-reviewer-health.ts 2026-04-27T19:11:49Z
 */

import fs from "fs";
import os from "os";
import path from "path";
import { createPrivateKey, createSign } from "crypto";

const APP_ID = 3470137;
const APP_PEM = path.join(os.homedir(), ".config/minsky/minsky-reviewer.pem");
const APP_BOT_LOGIN = "minsky-reviewer[bot]";
const REPO_OWNER = "edobry";
const REPO_NAME = "minsky";

// First arg can be either lookback-hours (number) or absolute ISO8601 timestamp.
const arg = process.argv[2] ?? "4";
const sinceIso = /^\d{4}-/.test(arg)
  ? arg
  : new Date(Date.now() - Number.parseInt(arg, 10) * 60 * 60 * 1000).toISOString();
const lookbackHours = /^\d{4}-/.test(arg)
  ? (Date.now() - new Date(arg).getTime()) / (60 * 60 * 1000)
  : Number.parseInt(arg, 10);

function signAppJwt(): string {
  const pem = fs.readFileSync(APP_PEM, "utf8");
  const key = createPrivateKey(pem);
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iat: now - 30,
    exp: now + 540,
    iss: APP_ID,
  })}`;
  const sig = createSign("RSA-SHA256").update(data).sign(key).toString("base64url");
  return `${data}.${sig}`;
}

async function ghAppApi(path: string): Promise<{ data: unknown; linkHeader: string | null }> {
  const jwt = signAppJwt();
  const resp = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
  });
  if (!resp.ok) throw new Error(`${path} → ${resp.status} ${await resp.text()}`);
  return { data: await resp.json(), linkHeader: resp.headers.get("link") };
}

async function ghUserApi(path: string): Promise<unknown> {
  const token = process.env["GH_TOKEN"] ?? "";
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(`https://api.github.com${path}`, { headers });
  if (!resp.ok) throw new Error(`${path} → ${resp.status} ${await resp.text()}`);
  return resp.json();
}

interface Delivery {
  id: number;
  delivered_at: string;
  event: string;
  action: string | null;
  status: string;
  status_code: number;
  duration: number;
  redelivery: boolean;
}

async function fetchDeliveriesSince(sinceIso: string): Promise<Delivery[]> {
  const all: Delivery[] = [];
  let path: string | null = "/app/hook/deliveries?per_page=100";
  while (path) {
    const { data, linkHeader }: { data: unknown; linkHeader: string | null } = await ghAppApi(path);
    const page = data as Delivery[];
    let stopped = false;
    for (const d of page) {
      if (d.delivered_at < sinceIso) {
        stopped = true;
        break;
      }
      all.push(d);
    }
    if (stopped) break;
    const next = linkHeader?.match(/<([^>]+)>;\s*rel="next"/);
    path = next ? next[1].replace("https://api.github.com", "") : null;
  }
  return all;
}

interface PullRequest {
  number: number;
  draft: boolean;
  state: string;
  user: { login: string };
  head: { sha: string };
  body: string | null;
  title: string;
}

async function listOpenPRs(): Promise<PullRequest[]> {
  const all: PullRequest[] = [];
  let page = 1;
  while (true) {
    const data = (await ghUserApi(
      `/repos/${REPO_OWNER}/${REPO_NAME}/pulls?state=open&per_page=100&page=${page}`
    )) as PullRequest[];
    if (data.length === 0) break;
    all.push(...data);
    page += 1;
  }
  return all;
}

interface Review {
  user: { login: string } | null;
  state: string;
  commit_id: string;
}

async function listReviews(prNumber: number): Promise<Review[]> {
  const all: Review[] = [];
  let page = 1;
  while (true) {
    const data = (await ghUserApi(
      `/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${prNumber}/reviews?per_page=100&page=${page}`
    )) as Review[];
    if (data.length === 0) break;
    all.push(...data);
    page += 1;
  }
  return all;
}

async function main() {
  console.log(
    `reviewer-service health monitor — lookback ${lookbackHours.toFixed(1)}h (since ${sinceIso})`
  );
  console.log("=".repeat(80));

  // Phase 1: webhook delivery health
  console.log("\nPhase 1: webhook delivery health");
  console.log("-".repeat(40));
  const deliveries = await fetchDeliveriesSince(sinceIso);
  const prDeliveries = deliveries.filter((d) => d.event === "pull_request");
  const pushLikeDeliveries = prDeliveries.filter(
    (d) => d.action === "opened" || d.action === "synchronize" || d.action === "reopened"
  );

  const fast200 = pushLikeDeliveries.filter((d) => d.status_code === 200 && d.duration < 2);
  const timeouts = pushLikeDeliveries.filter((d) => d.status_code === 0 && d.duration >= 9);
  const other = pushLikeDeliveries.filter(
    (d) => !(d.status_code === 200 && d.duration < 2) && !(d.status_code === 0 && d.duration >= 9)
  );

  console.log(`  Total deliveries: ${deliveries.length}`);
  console.log(`  pull_request events: ${prDeliveries.length}`);
  console.log(`  push-like (opened/synchronize/reopened): ${pushLikeDeliveries.length}`);
  console.log(`    fast-200 (code=200 dur<2s): ${fast200.length}`);
  console.log(`    timeouts (code=0 dur>=9s):  ${timeouts.length}`);
  console.log(`    other:                       ${other.length}`);

  if (other.length > 0) {
    console.log("\n  'other' breakdown:");
    for (const d of other) {
      console.log(
        `    ${d.delivered_at}  code=${d.status_code} status="${d.status}" dur=${d.duration}s  ${d.event}/${d.action}  redelivery=${d.redelivery}`
      );
    }
  }

  // Phase 2: review presence — open non-draft PRs with no minsky-reviewer review at HEAD
  console.log("\nPhase 2: review presence — open non-draft PRs missing review at HEAD");
  console.log("-".repeat(40));
  const allPRs = await listOpenPRs();
  const candidates = allPRs.filter((pr) => !pr.draft);
  console.log(`  Open non-draft PRs: ${candidates.length}`);

  const missing: Array<{ pr: PullRequest; reason: string }> = [];
  for (const pr of candidates) {
    const reviews = await listReviews(pr.number);
    const botReviewsAtHead = reviews.filter(
      (r) =>
        r.user?.login === APP_BOT_LOGIN && r.commit_id === pr.head.sha && r.state !== "DISMISSED"
    );
    if (botReviewsAtHead.length === 0) {
      missing.push({ pr, reason: "no review at HEAD SHA" });
    }
  }

  console.log(`  PRs missing minsky-reviewer review at HEAD: ${missing.length}`);
  for (const { pr, reason } of missing) {
    console.log(
      `    PR #${pr.number} (${pr.head.sha.slice(0, 8)}) by ${pr.user.login} — ${reason}`
    );
    console.log(`      ${pr.title}`);
  }

  // Verdict
  console.log(`\n${"=".repeat(80)}`);
  console.log("Verdict:");
  if (pushLikeDeliveries.length < 10) {
    console.log(
      `  INCONCLUSIVE — only ${pushLikeDeliveries.length} push deliveries in window (need ≥10).`
    );
    console.log(`  Re-run with a longer lookback or earlier ISO cutoff for a larger sample.`);
  } else if (timeouts.length > 0 || other.length > 0) {
    console.log(
      `  NOT MET — ${timeouts.length} timeout deliveries or ${other.length} non-200 in window.`
    );
  } else {
    console.log(
      `  webhook health: PASS (${fast200.length}/${pushLikeDeliveries.length} push deliveries fast-200)`
    );
    if (missing.length > 0) {
      console.log(
        `  review coverage: ${missing.length} PRs missing review at HEAD — sweeper should pick these up within one cycle (~10 min).`
      );
      console.log(`  Re-run after the next sweep cycle to confirm.`);
    } else {
      console.log(`  review coverage: PASS (0 PRs missing review at HEAD)`);
      console.log(`  → reviewer service is healthy.`);
    }
  }
}

main().catch((err) => {
  console.error("Monitor failed:", err);
  process.exit(1);
});
