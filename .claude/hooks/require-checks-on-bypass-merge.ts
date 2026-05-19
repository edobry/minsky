#!/usr/bin/env bun
// PreToolUse hook (mt#1951): block agent-context `gh api PUT /repos/.../pulls/<N>/merge`
// invocations when any branch-protection-required status check is not currently
// concluded success.
//
// ## Why this hook exists
//
// mt#1938 shipped layer 1 of the three-layer main-red defense:
// `.claude/hooks/require-review-before-merge.ts` enforces required-checks-status
// on `mcp__minsky__session_pr_merge` invocations. But the agent's documented
// bypass-merge convention (`gh api PUT /merge` via Bash / session_exec) goes
// through a different invocation path and is NOT covered by layer 1's matcher.
//
// On 2026-05-19 the agent invoked the bypass twice under user authorization with
// red CI, causing main to go red both times (mt#1927 12:29Z, mt#1944 17:55Z).
// `feedback_verify_ci_fired_on_latest_commit_before_bypass_merging` (id 8bd30dc2)
// documented the discipline as agent-facing behavioral; it didn't fire reliably
// because it's memory-resident, not structurally enforced.
//
// This hook closes the structural gap by applying the same `evaluateRequiredChecksStatus`
// logic from layer 1 to the bypass invocation surface (Bash + session_exec). The pure
// helpers are imported from `./require-review-before-merge`, so the single source of
// truth lives in one file.
//
// ## Detection
//
// Matches Bash + session_exec commands that contain a `gh api ... PUT ... /pulls/<N>/merge`
// segment. The detection logic is shared with `block-subagent-bypass-merge.ts` — both
// hooks fire on the same surface but with different gates:
//
//   - `block-subagent-bypass-merge.ts` denies SUBAGENT invocations unconditionally
//     (detected via `agent_id` field).
//   - This hook denies MAIN-AGENT invocations when CI status is not green.
//
// Defense in depth: subagents hit the subagent block first; main-agent invocations
// hit this hook. Both denials are possible from the same matcher.
//
// ## Override
//
// `MINSKY_SKIP_REQUIRED_CHECKS=1` (already registered in `HOOK_ONLY_ENV_VARS` for
// layer 1) bypasses this hook with a stdout audit-log line. Same env var, same
// shape as layer 1 — no new mechanism to remember.
//
// ## Pagination guardrail and other gate semantics
//
// All identical to layer 1, because we call the same `evaluateRequiredChecksStatus`
// function with the same inputs. See `.claude/hooks/require-review-before-merge.ts`
// for the full gate-semantic documentation.
//
// @see mt#1951 — tracking task
// @see mt#1938 — layer 1 (session_pr_merge surface)
// @see block-subagent-bypass-merge.ts — sibling hook (subagent denial)
// @see feedback_verify_ci_fired_on_latest_commit_before_bypass_merging — the
//      memory this hook makes structural

import { readInput, writeOutput, execSync } from "./types";
import type { ToolHookInput } from "./types";
import {
  parseBranchProtectionResponse,
  parseAllCheckRunsResponse,
  evaluateRequiredChecksStatus,
  REQUIRED_CHECKS_OVERRIDE_ENV,
} from "./require-review-before-merge";
import { isSubagentContext, findGhApiPutMergeSegment } from "./block-subagent-bypass-merge";

// ---------------------------------------------------------------------------
// PR number extraction
// ---------------------------------------------------------------------------

/**
 * Extract the PR number from a matched `gh api PUT /pulls/<N>/merge` segment.
 * The segment has already been validated by `findGhApiPutMergeSegment`, so the
 * regex match is expected to succeed; null return is a defensive fallback.
 */
export function extractPrNumber(matchedSegment: string): string | null {
  const match = matchedSegment.match(/\/pulls\/(\d+)\/merge/);
  return match?.[1] ?? null;
}

/**
 * Fetch the PR's HEAD SHA via `gh pr view <N> --json headRefOid`. Returns null
 * if the call fails (in which case the hook fails open with a stderr warning,
 * matching layer 1's pattern for the headSha-unavailable case).
 */
export function fetchPrHeadSha(prNumber: string): string | null {
  const result = execSync(
    [
      "gh",
      "pr",
      "view",
      prNumber,
      "--repo",
      "edobry/minsky",
      "--json",
      "headRefOid",
      "--jq",
      ".headRefOid",
    ],
    { timeout: 10000 }
  );
  if (result.exitCode !== 0) return null;
  const trimmed = result.stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();

  // Only act on Bash and session_exec — the two surfaces that accept a `command` string
  if (input.tool_name !== "Bash" && input.tool_name !== "mcp__minsky__session_exec") {
    process.exit(0);
  }

  // Subagent invocations are denied unconditionally by the sibling
  // `block-subagent-bypass-merge.ts` hook. That denial fires first per hook
  // ordering in the matcher; if it didn't fire for some reason, this hook
  // doesn't need to re-do its work — main-agent context is the only path we
  // gate.
  if (isSubagentContext(input)) {
    process.exit(0);
  }

  const command = (input.tool_input.command as string | undefined) ?? "";

  const matchingSegment = findGhApiPutMergeSegment(command);
  if (matchingSegment === null) {
    // No PR-merge bypass detected — allow
    process.exit(0);
  }

  // Override env var honored — same shape as layer 1
  const skipRequiredChecks = process.env[REQUIRED_CHECKS_OVERRIDE_ENV];
  if (skipRequiredChecks && /^(1|true|yes)$/i.test(skipRequiredChecks)) {
    process.stdout.write(
      `[require-checks-on-bypass-merge] required-checks gate skipped via ${REQUIRED_CHECKS_OVERRIDE_ENV}=${skipRequiredChecks} ` +
        `(matched segment: ${matchingSegment.slice(0, 100)}, ${new Date().toISOString()})\n`
    );
    process.exit(0);
  }

  // Extract PR number and HEAD sha. If either lookup fails, fail open with a
  // stderr warning — matches layer 1's posture on inability to identify the PR.
  const prNumber = extractPrNumber(matchingSegment);
  if (prNumber === null) {
    process.stderr.write(
      "[require-checks-on-bypass-merge] could not extract PR number from matched segment; allowing\n"
    );
    process.exit(0);
  }

  const headSha = fetchPrHeadSha(prNumber);
  if (headSha === null) {
    process.stderr.write(
      `[require-checks-on-bypass-merge] could not fetch HEAD sha for PR #${prNumber}; allowing\n`
    );
    process.exit(0);
  }

  // Fetch branch protection + all check-runs in parallel-ish (sequential is fine,
  // each is ~hundreds of ms; same API budget as layer 1).
  const protectionResp = execSync(["gh", "api", "repos/edobry/minsky/branches/main/protection"], {
    timeout: 10000,
  });
  const protectionParseResult = parseBranchProtectionResponse(protectionResp);

  const allRunsResp = execSync(
    ["gh", "api", `repos/edobry/minsky/commits/${headSha}/check-runs?per_page=100`],
    { timeout: 10000 }
  );
  const allRunsParseResult = parseAllCheckRunsResponse(allRunsResp);

  const result = evaluateRequiredChecksStatus(
    protectionParseResult,
    allRunsParseResult,
    prNumber,
    headSha
  );

  if (result.deny && result.reason) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Bypass-merge denied: ${result.reason} ` +
          `(mt#1951 — agent-context gh api PUT /merge gated identically to session_pr_merge per mt#1938 layer 1; ` +
          `see feedback_verify_ci_fired_on_latest_commit_before_bypass_merging for the discipline this hook structuralizes).`,
      },
    });
    process.exit(0);
  }
}
