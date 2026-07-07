#!/usr/bin/env bun
// PreToolUse hook (mt#2353): block session_pr_merge when a PR touches a DEPLOY
// SURFACE (infra-as-code / per-service deploy+build config / deploy workflows)
// but the PR body has no `Deploy verification:` section committing to post-merge
// deploy-health verification.
//
// Why: the mt#1459 "Execution evidence:" gate fires ONLY when a PR adds test
// files. A PR that changes DEPLOYED BEHAVIOR but adds no tests (config-as-code,
// Dockerfile, railway.json, deploy workflow) skips it entirely. mt#2345
// (2026-06-08) merged infra/index.ts + services/reviewer/railway.json, applied
// them to prod, and was reported DONE on `pulumi up` exit-0 while the reviewer
// service crash-looped for ~30 min. This gate closes that hole at the merge
// boundary.
//
// Architectural note: DONE is set ATOMICALLY at merge (applyPostMergeStateSync),
// and the deploy happens AFTER merge — so this gate cannot require deploy-SUCCESS
// EVIDENCE pre-merge (the deploy doesn't exist yet). It requires a `Deploy
// verification:` PLAN/commitment in the PR body; the sibling PostToolUse hook
// (deploy-verification-after-merge.ts) then injects the MANDATORY post-merge
// reminder to actually run it. Together they are the deploy-surface analog of the
// mt#1459 gate + drive-pr-to-convergence pair.
//
// Escape hatches:
//   1. PR title contains `[no-deploy-impact]` — the surface match is a false
//      positive (e.g. a comment-only edit to a deploy-config file). Allows with a
//      warning.
//   2. PR body contains a `Deploy verification:` section — the commitment.
//   3. MINSKY_SKIP_DEPLOY_VERIFY=1 — operator override, audit-logged.
//
// @see mt#2353 — this hook
// @see mt#1459 / require-execution-evidence-before-merge.ts — sibling gate (test-file surface)
// @see deploy-verification-after-merge.ts — sibling PostToolUse post-merge reminder

import { readInput, writeOutput } from "./types";
import type { ToolHookInput } from "./types";
import {
  deriveRepoFromGit,
  resolvePrNumber,
  makeProdPrDeps,
} from "./require-execution-evidence-before-merge";
import type { PrFile } from "./require-execution-evidence-before-merge";
import { findDeploySurfaceFiles } from "./deploy-surface-detector";

// ---------------------------------------------------------------------------
// Override env var (single source of truth — also registered in HOOK_ONLY_ENV_VARS)
// ---------------------------------------------------------------------------

/** Operator override: skip the deploy-verification gate. Audit-logged when set. */
export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_DEPLOY_VERIFY";

/** True when the override env var is set to a truthy value (1/true/yes). */
export function isOverrideSet(): boolean {
  const v = process.env[OVERRIDE_ENV_VAR];
  return v === "1" || v === "true" || v === "yes";
}

// ---------------------------------------------------------------------------
// PR body / title parsing
// ---------------------------------------------------------------------------

/**
 * Markdown marker for the deploy-verification commitment section (mt#2648 —
 * same accepted-forms class as the sibling `hasExecutionEvidence` marker in
 * `require-execution-evidence-before-merge.ts`). Accepts, case-insensitive:
 *   A. A Markdown heading (any level 1-6) + "deploy verification" with an
 *      OPTIONAL trailing colon — e.g. "## Deploy verification",
 *      "### Deploy verification:".
 *   B. A plain label line — "deploy verification:" with a REQUIRED colon (no
 *      heading marker) — keeping the colon required here preserves the
 *      original true-negative behavior for bare prose mentions.
 * `m`+`i` flags. Group 1 (heading hashes, form A only) is unused downstream;
 * group 2 captures trailing inline content for the inline-content check.
 */
// Up to 3 leading spaces before a heading marker, per CommonMark (spaces
// only — not \s, which would let the match skip across blank lines).
const DEPLOY_VERIFICATION_MARKER =
  /^(?: {0,3}(#{1,6})\s+deploy verification\s*:?|deploy verification\s*:)\s*(.*)$/im;

/** Title bypass tag for false-positive deploy-surface matches. */
const NO_DEPLOY_IMPACT_TAG = /\[no-deploy-impact\]/i;

/**
 * Deferral-language patterns (mt#2353 Recurrence 3): a `Deploy verification:`
 * section whose content is a DEFERRAL — "deferred to §10", "will verify later",
 * "not yet deployed", "to be verified" — is NOT evidence. The post-merge
 * verification must be committed to / run, not punted; "deferred to §10 because
 * not-yet-deployed" is exactly the loophole the spec disallows. A section whose
 * content matches this pattern does NOT satisfy the gate. Note: this runs ONLY
 * against the matched section's own text, never the rest of the PR body, so a
 * concrete commitment ("Will run `deployment_wait-for-latest` after merge and
 * confirm SUCCESS") passes — it names the action, not a punt.
 */
const DEFERRAL_PATTERN =
  /\b(?:defer(?:red|ring|s)?|will\s+verify(?:\s+it)?\s+later|verify(?:\s+it)?\s+later|not[\s-]?yet[\s-]?deployed|to\s+be\s+verified|pending\s+deploy(?:ment)?|verify\s+post-?merge)\b/i;

/**
 * True when the PR body contains a `Deploy verification:` block with non-empty
 * content following the marker. Mirrors the mt#1459 `hasExecutionEvidence`
 * discipline: HTML comments stripped first; a `No Deploy verification:` negation
 * does NOT qualify; content must follow the heading (inline or on subsequent
 * lines before the next heading).
 */
export function hasDeployVerification(prBody: string): boolean {
  const stripped = prBody.replace(/<!--[\s\S]*?-->/g, "");
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = line.match(DEPLOY_VERIFICATION_MARKER);
    if (!match) continue;

    // Negation guard: "No Deploy verification:" / "## No Deploy verification:".
    const beforeMarker = line.slice(0, line.toLowerCase().indexOf("deploy")).toLowerCase();
    if (/\bno\b/.test(beforeMarker)) continue;

    // Collect this section's content: inline (heading line) + following lines
    // until the next heading or EOF.
    const parts: string[] = [];
    const inlineContent = (match[2] ?? "").trim();
    if (inlineContent.length > 0) parts.push(inlineContent);
    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j];
      if (nextLine === undefined) break;
      if (/^#{1,6}\s/.test(nextLine)) break; // next heading — stop
      if (nextLine.trim().length > 0) parts.push(nextLine.trim());
    }
    const content = parts.join(" ").trim();
    if (content.length === 0) continue; // empty section — keep looking

    // Deferral-text-is-not-evidence (mt#2353 Recurrence 3): a deferral-only
    // section does NOT satisfy the gate. Keep scanning in case a later, genuine
    // section exists.
    if (DEFERRAL_PATTERN.test(content)) continue;

    return true;
  }
  return false;
}

/** True when the PR title carries the `[no-deploy-impact]` bypass tag. */
export function hasNoDeployImpactTag(prTitle: string): boolean {
  return NO_DEPLOY_IMPACT_TAG.test(prTitle);
}

// ---------------------------------------------------------------------------
// Core check (pure / injectable)
// ---------------------------------------------------------------------------

export interface DeployVerificationCheckResult {
  blocked: boolean;
  reason?: string;
  deploySurfaceFiles: string[];
  bypassDetected: boolean;
  warnings: string[];
}

/**
 * Run the deploy-verification check given PR files + metadata. Pure core of the
 * hook — injectable for unit tests.
 */
export function checkDeployVerification(
  prFiles: PrFile[],
  prTitle: string,
  prBody: string
): DeployVerificationCheckResult {
  const warnings: string[] = [];
  const deploySurfaceFiles = findDeploySurfaceFiles(prFiles);

  // No deploy surface touched → hook is silent.
  if (deploySurfaceFiles.length === 0) {
    return { blocked: false, deploySurfaceFiles: [], bypassDetected: false, warnings };
  }

  // Title bypass for false-positive surface matches.
  if (hasNoDeployImpactTag(prTitle)) {
    warnings.push(
      `[no-deploy-impact] bypass: merge proceeding without a \`Deploy verification:\` ` +
        `section for ${deploySurfaceFiles.length} deploy-surface file(s). Confirm the ` +
        `change truly has no deploy impact.`
    );
    return { blocked: false, deploySurfaceFiles, bypassDetected: true, warnings };
  }

  // Commitment present → allow.
  if (hasDeployVerification(prBody)) {
    return { blocked: false, deploySurfaceFiles, bypassDetected: false, warnings };
  }

  // No commitment, no bypass → block.
  const fileList = deploySurfaceFiles.map((f) => `  - ${f}`).join("\n");
  const reason =
    `Merge blocked: PR touches ${deploySurfaceFiles.length} deploy-surface file(s) but the ` +
    `PR body has no deploy-verification section.\n\n` +
    `Accepted marker forms (case-insensitive): \`Deploy verification:\` (plain label, colon ` +
    `required) OR a Markdown heading of any level with an optional trailing colon ` +
    `(e.g. \`## Deploy verification\`, \`### Deploy verification:\`).\n\n` +
    `Deploy-surface files:\n${fileList}\n\n` +
    `Deploy/infra changes can break the post-merge deploy (Dockerfile breakage, ` +
    `config-as-code resolution error, crash on start) in ways no pre-merge check catches ` +
    `(mt#2345). DONE is set AT merge, so you MUST verify the post-merge deploy yourself.\n\n` +
    `To unblock, choose one of:\n` +
    `  1. Add a \`Deploy verification\` section (any accepted form above) to the PR body committing to run ` +
    `\`mcp__minsky__deployment_wait-for-latest\` → SUCCESS (and confirm the runtime started) ` +
    `AFTER merge. A tool/auth flake is a BLOCKER (reconnect /mcp and retry), NOT a license to ` +
    `defer; "applied" / "pulumi up exit-0" is the ACTION, not the OUTCOME. ` +
    `(use \`mcp__minsky__session_pr_edit\` to update the body.)\n` +
    `  2. If this change truly has no deploy impact (e.g. a comment-only edit), prefix the PR ` +
    `title with \`[no-deploy-impact]\`.\n` +
    `  3. Operator override: set \`${OVERRIDE_ENV_VAR}=1\` (audit-logged).`;

  return { blocked: true, reason, deploySurfaceFiles, bypassDetected: false, warnings };
}

// ---------------------------------------------------------------------------
// Top-level hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();

  // Operator override: skip with an audit line on stdout (non-JSON — Claude Code's
  // hook-output parser logs it as "Ignoring non-JSON line", matching the sibling
  // override-audit convention). Mutually exclusive with the deny path below.
  if (isOverrideSet()) {
    process.stdout.write(
      `[deploy-verification] override active: ${OVERRIDE_ENV_VAR}=${process.env[OVERRIDE_ENV_VAR]} ` +
        `at ${new Date().toISOString()} — deploy-verification gate skipped\n`
    );
    process.exit(0);
  }

  const task = (input.tool_input.task as string | undefined) ?? "";
  if (!task) process.exit(0);

  // Derive owner/repo from the git remote (forks + non-edobry/minsky remotes).
  const repo = deriveRepoFromGit(input.cwd);
  if (!repo) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          "⚠️ [deploy-verification] Could not derive owner/repo from git remote — check skipped.",
      },
    });
    process.exit(0);
  }

  const { prNumber, warning: prResolutionWarning } = resolvePrNumber(repo, task, input.cwd);
  if (!prNumber) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `⚠️ ${prResolutionWarning ?? "[deploy-verification] PR number could not be resolved — check skipped."}`,
      },
    });
    process.exit(0);
  }

  const deps = makeProdPrDeps(input.cwd);
  const { files: prFiles, warning: prFilesWarning } = deps.fetchPrFiles(repo, prNumber);
  const prMeta = deps.fetchPrMeta(repo, prNumber);

  const topLevelWarnings: string[] = [];
  if (prFilesWarning) topLevelWarnings.push(prFilesWarning);

  // Fail-open: can't fetch PR data → allow with a warning.
  if (!prMeta) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: [
          ...topLevelWarnings.map((w) => `⚠️ ${w}`),
          `⚠️ [deploy-verification] Could not fetch PR #${prNumber} metadata. Proceeding without check.`,
        ].join("\n"),
      },
    });
    process.exit(0);
  }

  const result = checkDeployVerification(prFiles, prMeta.title, prMeta.body);
  const allWarnings = [...topLevelWarnings, ...result.warnings];

  if (result.blocked) {
    const warningContext =
      allWarnings.length > 0 ? `${allWarnings.map((w) => `⚠️ ${w}`).join("\n")}\n\n` : "";
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${warningContext}${result.reason}`,
      },
    });
  } else if (allWarnings.length > 0) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: allWarnings.map((w) => `⚠️ ${w}`).join("\n"),
      },
    });
  }
}
