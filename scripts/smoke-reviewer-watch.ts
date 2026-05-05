#!/usr/bin/env bun
/**
 * Live smoke for the local reviewer-bot watcher (mt#1310).
 *
 * Builds a production `MissedReviewClient` against the live GitHub API and
 * runs one watcher cycle. Verifies the end-to-end path:
 *
 *   token resolution -> Octokit pulls.list pagination -> per-PR listReviews
 *   -> detection -> dedup -> (skipped) OperatorNotify
 *
 * No notification is fired in smoke mode (NoopOperatorNotify) so the script
 * is safe to run in CI / unattended contexts. To exercise the full alert
 * payload on a desktop, run `bun minsky reviewer.watch.run` instead.
 *
 * Env-var gating: skips with exit 0 if no GitHub credentials are available
 * (per the live-verification gap pattern in `/implement-task` §7a).
 *
 * Output: prints a structured JSON line to stdout, optionally writes the
 * same payload to scripts/smoke-reviewer-watch-results.json when --write
 * is passed. Exit code: 0 on success, non-zero on unexpected failure.
 */

// tsyringe (transitively imported via getConfiguration) requires reflect-metadata.
import "reflect-metadata";
import { writeFileSync } from "fs";
import { resolve } from "path";
import {
  MissedReviewDedupState,
  runReviewerWatchCycle,
  type ReviewerWatchConfig,
} from "../src/domain/reviewer-watch";
import { makeProductionMissedReviewClient } from "../src/adapters/shared/commands/reviewer-watch-github-client";
import { createTokenProvider } from "../src/domain/auth";
import type { OperatorNotify } from "../src/domain/notify/operator-notify";
import { getConfiguration } from "../src/domain/configuration/index";

class NoopOperatorNotify implements OperatorNotify {
  bellCalls = 0;
  notifyCalls: Array<{ title: string; body: string }> = [];
  bell(): void {
    this.bellCalls += 1;
  }
  notify(title: string, body: string): void {
    this.notifyCalls.push({ title, body });
  }
}

interface SmokeResult {
  ok: boolean;
  startedAt: string;
  completedAt: string;
  config: { owner: string; repo: string; threshold: number; botLogin: string };
  cycle: {
    decision: string;
    prsScanned: number;
    missingCount: number;
    missingSamples: Array<{ number: number; reason: string; sha7: string }>;
    bellCalls: number;
    notifyCalls: number;
  };
  error?: string;
}

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  const writeResults = process.argv.includes("--write");

  // Try to resolve config; fall back to env-var-only mode.
  let userToken: string | undefined;
  let githubCfg: Parameters<typeof createTokenProvider>[0] = {};
  try {
    const cfg = getConfiguration();
    githubCfg = cfg.github ?? {};
    userToken = cfg.github?.token;
  } catch {
    // Config not initialized — fall through to env-var path.
  }

  userToken = userToken ?? process.env["GITHUB_TOKEN"] ?? process.env["MINSKY_GITHUB_TOKEN"];

  if (!userToken) {
    console.log(
      JSON.stringify({
        ok: true,
        skipped: true,
        reason: "No GitHub token available (config.github.token / GITHUB_TOKEN unset)",
      })
    );
    return 0; // skip gracefully
  }

  const tokenProvider = createTokenProvider(githubCfg, userToken);
  const client = makeProductionMissedReviewClient(tokenProvider);
  const operatorNotify = new NoopOperatorNotify();
  const dedupState = new MissedReviewDedupState();

  const config: ReviewerWatchConfig = {
    owner: process.env["MINSKY_REVIEWER_WATCH_OWNER"] ?? "edobry",
    repo: process.env["MINSKY_REVIEWER_WATCH_REPO"] ?? "minsky",
    botLogin: process.env["MINSKY_REVIEWER_WATCH_BOT_LOGIN"] ?? "minsky-reviewer[bot]",
    threshold: parseInt(process.env["MINSKY_REVIEWER_WATCH_THRESHOLD"] ?? "1", 10) || 1,
  };

  const result: SmokeResult = {
    ok: false,
    startedAt,
    completedAt: "",
    config,
    cycle: {
      decision: "",
      prsScanned: 0,
      missingCount: 0,
      missingSamples: [],
      bellCalls: 0,
      notifyCalls: 0,
    },
  };

  try {
    const cycle = await runReviewerWatchCycle({
      client,
      operatorNotify,
      dedupState,
      config,
    });

    result.completedAt = new Date().toISOString();
    result.ok = true;
    result.cycle = {
      decision: cycle.decision,
      prsScanned: cycle.prsScanned,
      missingCount: cycle.missing.length,
      // Cap to the first 5 to keep output bounded.
      missingSamples: cycle.missing.slice(0, 5).map((m) => ({
        number: m.number,
        reason: m.reason,
        sha7: m.headSha.slice(0, 7),
      })),
      bellCalls: operatorNotify.bellCalls,
      notifyCalls: operatorNotify.notifyCalls.length,
    };
  } catch (err: unknown) {
    result.completedAt = new Date().toISOString();
    result.ok = false;
    result.error = err instanceof Error ? err.message : String(err);
  }

  console.log(JSON.stringify(result, null, 2));

  if (writeResults) {
    const out = resolve(import.meta.dir, "smoke-reviewer-watch-results.json");
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`# wrote ${out}`);
  }

  return result.ok ? 0 : 1;
}

const code = await main();
process.exit(code);
