#!/usr/bin/env bun
/**
 * Verification artifact for mt#2435.
 *
 * Posts a real GitHub check run to a real PR via the wired
 * `publishCheckRun` + `submitCheckRun` path to verify the end-to-end
 * integration works with the reviewer App's Octokit (octokitOverride seam).
 *
 * ## Env gating
 *
 * Required (reviewer App creds):
 *   MINSKY_REVIEWER_APP_ID          — GitHub App ID
 *   MINSKY_REVIEWER_PRIVATE_KEY     — PEM private key (can use \n escapes)
 *   MINSKY_REVIEWER_INSTALLATION_ID — Installation ID
 *
 * Required (target PR):
 *   SMOKE_CHECK_RUN_OWNER           — repo owner (e.g. "edobry")
 *   SMOKE_CHECK_RUN_REPO            — repo name  (e.g. "minsky")
 *   SMOKE_CHECK_RUN_SHA             — HEAD commit SHA (40-char hex)
 *   SMOKE_CHECK_RUN_PR              — PR number (integer, for log context only)
 *
 * Optional:
 *   SMOKE_CHECK_RUN_FAILURE         — if set, posts a liveness-failure run
 *                                     with this string as the failureSummary.
 *
 * When any required variable is missing the script SKIPS (exit 0).
 *
 * Usage (normal review path):
 *   MINSKY_REVIEWER_APP_ID=... MINSKY_REVIEWER_PRIVATE_KEY=... \
 *   MINSKY_REVIEWER_INSTALLATION_ID=... \
 *   SMOKE_CHECK_RUN_OWNER=edobry SMOKE_CHECK_RUN_REPO=minsky \
 *   SMOKE_CHECK_RUN_SHA=<sha> SMOKE_CHECK_RUN_PR=<n> \
 *     bun services/reviewer/scripts/smoke-check-run.ts
 *
 * Usage (liveness failure path):
 *   ... SMOKE_CHECK_RUN_FAILURE="empty output: model returned nothing" \
 *     bun services/reviewer/scripts/smoke-check-run.ts
 *
 * Exit codes: 0 = pass or skip, 1 = fail.
 */

import { createOctokit } from "../src/github-client";
import { publishCheckRun } from "../src/check-run-publisher";
import type { ReviewerConfig } from "../src/config";
import type { ReviewToolCall } from "../src/output-tools";

function skip(reason: string): never {
  console.log(JSON.stringify({ result: "SKIP", reason }, null, 2));
  process.exit(0);
}

function fail(reason: string, detail?: unknown): never {
  console.error(JSON.stringify({ result: "FAIL", reason, detail }, null, 2));
  process.exit(1);
}

function requireEnvOrSkip(name: string): string {
  const val = process.env[name];
  if (!val) skip(`${name} is not set`);
  return val;
}

async function main(): Promise<void> {
  // Reviewer App credentials — skip gracefully if absent.
  const appIdStr = process.env["MINSKY_REVIEWER_APP_ID"];
  const privateKey = process.env["MINSKY_REVIEWER_PRIVATE_KEY"];
  const installationIdStr = process.env["MINSKY_REVIEWER_INSTALLATION_ID"];

  if (!appIdStr || !privateKey || !installationIdStr) {
    skip(
      "Reviewer App creds not set " +
        "(MINSKY_REVIEWER_APP_ID / MINSKY_REVIEWER_PRIVATE_KEY / MINSKY_REVIEWER_INSTALLATION_ID)"
    );
  }

  const owner = requireEnvOrSkip("SMOKE_CHECK_RUN_OWNER");
  const repo = requireEnvOrSkip("SMOKE_CHECK_RUN_REPO");
  const headSha = requireEnvOrSkip("SMOKE_CHECK_RUN_SHA");
  const prNumberStr = requireEnvOrSkip("SMOKE_CHECK_RUN_PR");
  const prNumber = parseInt(prNumberStr, 10);
  if (isNaN(prNumber)) fail("SMOKE_CHECK_RUN_PR must be an integer", { raw: prNumberStr });

  const failureSummary = process.env["SMOKE_CHECK_RUN_FAILURE"];

  // Build a minimal ReviewerConfig sufficient for createOctokit.
  // Provider and model fields are not used by the Octokit path.
  const config: ReviewerConfig = {
    appId: parseInt(appIdStr, 10),
    privateKey: privateKey.replace(/\\n/g, "\n"), // support escaped newlines
    installationId: parseInt(installationIdStr, 10),
    webhookSecret: process.env["MINSKY_REVIEWER_WEBHOOK_SECRET"] ?? "unused-for-smoke",
    provider: "openai",
    providerApiKey: "unused-for-smoke",
    providerModel: "unused-for-smoke",
    tier2Enabled: false,
    mcpUrl: undefined,
    mcpToken: undefined,
    port: 3000,
    logLevel: "info",
    modelTimeoutMs: 120_000,
    githubTimeoutMs: 30_000,
  };

  console.log(
    JSON.stringify({
      step: "creating reviewer octokit",
      owner,
      repo,
      sha: headSha,
      prNumber,
      failureSummary: failureSummary ?? null,
    })
  );

  let octokit: Awaited<ReturnType<typeof createOctokit>>;
  try {
    octokit = await createOctokit(config);
  } catch (err) {
    fail("createOctokit failed", err instanceof Error ? err.message : String(err));
  }

  // Synthetic tool calls for the smoke test.
  const toolCalls: ReviewToolCall[] = failureSummary
    ? []
    : [
        {
          name: "submit_finding" as const,
          args: {
            severity: "NON-BLOCKING" as const,
            file: "services/reviewer/scripts/smoke-check-run.ts",
            line: 1,
            summary: "[smoke] non-blocking test finding",
            details:
              "This is a synthetic finding posted by smoke-check-run.ts (mt#2435 verification).",
          },
        },
      ];

  console.log(
    JSON.stringify({
      step: "posting check run",
      toolCallCount: toolCalls.length,
      hasFailureSummary: !!failureSummary,
    })
  );

  const result = await publishCheckRun({
    octokit,
    owner,
    repo,
    headSha,
    prNumber,
    toolCalls,
    convergenceState: { roundNumber: 1, blockingCount: 0 },
    failureSummary,
  });

  if (result === null) {
    fail("publishCheckRun returned null — check reviewer logs for details");
  }

  console.log(
    JSON.stringify({
      result: "PASS",
      checkRunId: result.checkRunId,
      checkRunUrl: result.htmlUrl,
      owner,
      repo,
      sha: headSha,
      prNumber,
      conclusion: failureSummary ? "failure" : "neutral",
    })
  );
}

main().catch((err) => {
  fail("Unhandled error in smoke script", err instanceof Error ? err.message : String(err));
});
