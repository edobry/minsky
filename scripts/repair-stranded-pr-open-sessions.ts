#!/usr/bin/env bun
/**
 * One-shot repair pass: fix sessions stuck in PR_OPEN with closed-merged PRs.
 *
 * mt#1614: At-merge handler for Minsky-side state transitions.
 *
 * This script finds all sessions in PR_OPEN status whose linked GitHub PR is
 * actually closed-merged, and runs applyPostMergeStateSync on each.
 *
 * The canonical test case is session 1641fbeb-331e-4160-9fe8-9464e1a5f5c8
 * (task mt#1598, PR #962, merged 2026-05-06 via gh api PUT /merge).
 *
 * ## Usage
 *
 *   # Preview (default — safe, no changes made):
 *   bun scripts/repair-stranded-pr-open-sessions.ts
 *
 *   # Apply (requires --execute flag):
 *   bun scripts/repair-stranded-pr-open-sessions.ts --execute
 *
 *   # Repair a specific session only:
 *   bun scripts/repair-stranded-pr-open-sessions.ts --session 1641fbeb-331e-4160-9fe8-9464e1a5f5c8
 *
 *   # Apply for a specific session:
 *   bun scripts/repair-stranded-pr-open-sessions.ts --session 1641fbeb-... --execute
 *
 * ## Required env vars
 *
 *   DATABASE_URL — Minsky DB connection string (or uses default Minsky config)
 *   GITHUB_TOKEN — GitHub API token for checking PR state
 *
 * ## Outputs
 *
 * Exit code 0 — scan completed (even if some repairs failed individually).
 * Exit code 1 — fatal error (cannot connect to DB or GitHub).
 *
 * Results are written to stdout as JSON lines and to
 * scripts/results/repair-stranded-pr-open-sessions-results.json.
 *
 * ## Per CLAUDE.md §Operational Safety: Dry-Run First
 * Default is --dry-run (preview). --execute applies changes.
 */

import { join } from "path";
import { mkdir } from "fs/promises";

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = !args.includes("--execute");
const specificSession = (() => {
  const idx = args.indexOf("--session");
  return idx !== -1 ? args[idx + 1] : null;
})();

if (dryRun) {
  console.log(
    JSON.stringify({
      event: "repair_pass.dry_run",
      message: "DRY RUN — no changes will be made. Pass --execute to apply repairs.",
    })
  );
} else {
  console.log(
    JSON.stringify({
      event: "repair_pass.execute_mode",
      message: "EXECUTE MODE — repairs will be applied.",
    })
  );
}

// ---------------------------------------------------------------------------
// Check required env vars
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = process.env["GITHUB_TOKEN"];
if (!GITHUB_TOKEN) {
  console.log(
    JSON.stringify({
      event: "repair_pass.skip",
      reason: "GITHUB_TOKEN not set",
      message: "SKIP: GITHUB_TOKEN env var not set. Set it to run this script.",
    })
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Bootstrap Minsky services
// ---------------------------------------------------------------------------

// Dynamic import to allow the script to exit cleanly if env is missing.
async function bootstrapMinsky() {
  try {
    const { createSessionDbAdapter } = await import("@minsky/domain/session/session-db-adapter");
    const { createTaskService } = await import("@minsky/domain/tasks/taskService");
    return { createSessionDbAdapter, createTaskService };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        event: "repair_pass.bootstrap_error",
        error: msg,
      })
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// GitHub PR state check
// ---------------------------------------------------------------------------

interface GitHubPrState {
  state: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  number: number;
}

async function getGitHubPrState(
  owner: string,
  repo: string,
  prNumber: number
): Promise<GitHubPrState | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "minsky-repair-stranded-sessions/1.0",
        },
      }
    );

    if (!response.ok) {
      if (response.status === 404) return null;
      const body = await response.text().catch(() => "(unreadable)");
      console.warn(
        JSON.stringify({
          event: "repair_pass.github_api_error",
          status: response.status,
          prNumber,
          // eslint-disable-next-line custom/no-unsafe-string-truncation -- GitHub API error body is JSON/HTTP text, known-ASCII safe to truncate
          body: body.slice(0, 200),
        })
      );
      return null;
    }

    const data = (await response.json()) as {
      state: string;
      merged: boolean;
      merged_at: string | null;
      merge_commit_sha: string | null;
      number: number;
    };

    return {
      state: data.state === "open" ? "open" : "closed",
      merged: data.merged === true,
      mergedAt: data.merged_at,
      mergeCommitSha: data.merge_commit_sha,
      number: data.number,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      JSON.stringify({
        event: "repair_pass.github_fetch_error",
        prNumber,
        error: msg,
      })
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Extract GitHub owner/repo from repo URL
// ---------------------------------------------------------------------------

function parseGitHubUrl(repoUrl: string): { owner: string; repo: string } | null {
  // Matches: https://github.com/owner/repo or https://github.com/owner/repo.git
  const match = /github\.com[/:]([^/]+)\/([^/.]+)(\.git)?$/.exec(repoUrl);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface SessionRepairResult {
  sessionId: string;
  taskId?: string;
  prNumber?: number;
  prUrl?: string;
  githubState?: string;
  merged?: boolean;
  mergedAt?: string | null;
  mergeSha?: string | null;
  action:
    | "skipped_no_pr"
    | "skipped_open"
    | "skipped_not_merged"
    | "repaired"
    | "dry_run_would_repair"
    | "error";
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { createSessionDbAdapter, createTaskService } = await bootstrapMinsky();

  // Initialize session DB
  let sessionDB: Awaited<ReturnType<typeof createSessionDbAdapter>>;
  try {
    sessionDB = await createSessionDbAdapter();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        event: "repair_pass.session_db_error",
        error: msg,
      })
    );
    process.exit(1);
  }

  // Initialize task service
  let taskService: Awaited<ReturnType<typeof createTaskService>>;
  try {
    taskService = await createTaskService();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        event: "repair_pass.task_service_error",
        error: msg,
      })
    );
    process.exit(1);
  }

  // Load applyPostMergeStateSync
  const { applyPostMergeStateSync } = await import(
    "@minsky/domain/session/session-merge-operations"
  );

  // List PR_OPEN sessions (or the specific session if requested)
  let sessions;
  if (specificSession) {
    const s = await sessionDB.getSession(specificSession);
    sessions = s ? [s] : [];
    if (sessions.length === 0) {
      console.error(
        JSON.stringify({
          event: "repair_pass.session_not_found",
          sessionId: specificSession,
        })
      );
      process.exit(1);
    }
  } else {
    sessions = await sessionDB.listSessions({ status: "PR_OPEN" } as Parameters<
      typeof sessionDB.listSessions
    >[0]);
    // Filter to only PR_OPEN sessions (listSessions may not filter by status in all adapters)
    sessions = sessions.filter((s) => s.status === "PR_OPEN");
  }

  console.log(
    JSON.stringify({
      event: "repair_pass.sessions_found",
      count: sessions.length,
      specificSession: specificSession ?? null,
    })
  );

  const results: SessionRepairResult[] = [];

  for (const session of sessions) {
    const sessionId = session.sessionId;
    const taskId = session.taskId;
    const prNumber = session.pullRequest?.number;
    const prUrl = session.pullRequest?.url;

    if (!prNumber) {
      const result: SessionRepairResult = {
        sessionId,
        taskId,
        action: "skipped_no_pr",
      };
      results.push(result);
      console.log(JSON.stringify({ event: "repair_pass.session_result", ...result }));
      continue;
    }

    // Parse GitHub owner/repo from repoUrl
    const repoInfo = parseGitHubUrl(session.repoUrl ?? "");
    if (!repoInfo) {
      const result: SessionRepairResult = {
        sessionId,
        taskId,
        prNumber,
        prUrl,
        action: "error",
        errorMessage: `Cannot parse GitHub owner/repo from repoUrl: ${session.repoUrl}`,
      };
      results.push(result);
      console.warn(JSON.stringify({ event: "repair_pass.session_result", ...result }));
      continue;
    }

    // Check GitHub PR state
    const ghState = await getGitHubPrState(repoInfo.owner, repoInfo.repo, prNumber);
    if (!ghState) {
      const result: SessionRepairResult = {
        sessionId,
        taskId,
        prNumber,
        prUrl,
        action: "error",
        errorMessage: `GitHub API returned null for PR #${prNumber}`,
      };
      results.push(result);
      console.warn(JSON.stringify({ event: "repair_pass.session_result", ...result }));
      continue;
    }

    if (ghState.state === "open") {
      const result: SessionRepairResult = {
        sessionId,
        taskId,
        prNumber,
        prUrl,
        githubState: ghState.state,
        merged: false,
        action: "skipped_open",
      };
      results.push(result);
      console.log(JSON.stringify({ event: "repair_pass.session_result", ...result }));
      continue;
    }

    if (!ghState.merged) {
      const result: SessionRepairResult = {
        sessionId,
        taskId,
        prNumber,
        prUrl,
        githubState: ghState.state,
        merged: false,
        action: "skipped_not_merged",
      };
      results.push(result);
      console.log(JSON.stringify({ event: "repair_pass.session_result", ...result }));
      continue;
    }

    // PR is closed+merged: this session needs repair
    if (dryRun) {
      const result: SessionRepairResult = {
        sessionId,
        taskId,
        prNumber,
        prUrl,
        githubState: ghState.state,
        merged: true,
        mergedAt: ghState.mergedAt,
        mergeSha: ghState.mergeCommitSha,
        action: "dry_run_would_repair",
      };
      results.push(result);
      console.log(JSON.stringify({ event: "repair_pass.session_result", ...result }));
      continue;
    }

    // --execute: apply the repair
    try {
      await applyPostMergeStateSync(
        {
          sessionId,
          mergeSha: ghState.mergeCommitSha ?? undefined,
          mergedAt: ghState.mergedAt ?? undefined,
          cleanupSession: true,
          trigger: "repair_pass",
        },
        { sessionDB, taskService }
      );

      const result: SessionRepairResult = {
        sessionId,
        taskId,
        prNumber,
        prUrl,
        githubState: ghState.state,
        merged: true,
        mergedAt: ghState.mergedAt,
        mergeSha: ghState.mergeCommitSha,
        action: "repaired",
      };
      results.push(result);
      console.log(JSON.stringify({ event: "repair_pass.session_result", ...result }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const result: SessionRepairResult = {
        sessionId,
        taskId,
        prNumber,
        prUrl,
        githubState: ghState.state,
        merged: true,
        action: "error",
        errorMessage: msg,
      };
      results.push(result);
      console.error(JSON.stringify({ event: "repair_pass.session_result", ...result }));
    }
  }

  // Summary
  const summary = {
    total: results.length,
    repaired: results.filter((r) => r.action === "repaired").length,
    wouldRepair: results.filter((r) => r.action === "dry_run_would_repair").length,
    skippedNoPr: results.filter((r) => r.action === "skipped_no_pr").length,
    skippedOpen: results.filter((r) => r.action === "skipped_open").length,
    skippedNotMerged: results.filter((r) => r.action === "skipped_not_merged").length,
    errors: results.filter((r) => r.action === "error").length,
    dryRun,
  };

  console.log(
    JSON.stringify({
      event: "repair_pass.summary",
      ...summary,
    })
  );

  // Write results file
  const resultsDir = join(import.meta.dir, "results");
  const resultsPath = join(resultsDir, "repair-stranded-pr-open-sessions-results.json");
  try {
    await mkdir(resultsDir, { recursive: true });
    await Bun.write(
      resultsPath,
      JSON.stringify(
        {
          ranAt: new Date().toISOString(),
          summary,
          results,
        },
        null,
        2
      )
    );
    console.log(
      JSON.stringify({
        event: "repair_pass.results_written",
        path: resultsPath,
      })
    );
  } catch (writeErr) {
    const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
    console.warn(
      JSON.stringify({
        event: "repair_pass.results_write_error",
        error: msg,
      })
    );
  }

  if (dryRun && summary.wouldRepair > 0) {
    console.log(
      JSON.stringify({
        event: "repair_pass.dry_run_instructions",
        message: `${summary.wouldRepair} session(s) would be repaired. Run with --execute to apply.`,
      })
    );
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(
    JSON.stringify({
      event: "repair_pass.fatal_error",
      error: msg,
    })
  );
  process.exit(1);
});
