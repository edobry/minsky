#!/usr/bin/env bun
// PostToolUse hook (mt#2353): when a `session_pr_merge` succeeds AND the merged
// PR touched a DEPLOY SURFACE, inject a MANDATORY post-merge reminder that the
// task is NOT done until the post-merge deploy is verified healthy.
//
// This is the deploy-surface analog of drive-pr-to-convergence.ts (which fires on
// session_pr_create). The sibling PreToolUse gate
// (require-deploy-verification-before-merge.ts) forces a `Deploy verification:`
// COMMITMENT in the PR body before merge; this hook fires AFTER the merge — when
// the deploy is actually happening — and makes the verification non-optional.
//
// Why a PostToolUse INJECTION rather than a hard block: DONE is set ATOMICALLY at
// merge (applyPostMergeStateSync), and the deploy only exists AFTER merge, so the
// deploy-SUCCESS outcome cannot be gated at the merge boundary. The injection puts
// the requirement in the agent's context on the very turn the deploy starts —
// unconditionally on every deploy-surface merge (same architectural pattern as
// drive-pr-to-convergence / memory-search injection). The hard-block escalation
// (defer DONE in applyPostMergeStateSync) is named in the mt#2353 spec as the next
// rung if this tier proves insufficient.
//
// Originating incident: mt#2345 (2026-06-08) — infra/index.ts + railway.json
// merged + applied, reported DONE on `pulumi up` exit-0 while the reviewer service
// crash-looped ~30 min. The agent skipped the §10 post-merge verification, and
// when the verify tool flaked (Railway `Unauthorized`) it DOWNGRADED to an
// "observational over future merges" claim instead of treating the flake as a
// blocker. This reminder names both failure modes explicitly.
//
// Always exits 0 — informational, never blocks the merge's success surfacing.
//
// @see mt#2353 — this hook
// @see require-deploy-verification-before-merge.ts — sibling PreToolUse gate
// @see drive-pr-to-convergence.ts — architectural template (PostToolUse injection)
// @see /implement-task §10 — the discipline-tier step this hook reinforces

import { readInput } from "./types";
import type { ToolHookInput, HookOutput } from "./types";
import { deriveRepoFromGit, makeProdPrDeps } from "./require-execution-evidence-before-merge";
import type { PrFile } from "./require-execution-evidence-before-merge";
import { findDeploySurfaceFiles, findLocalAppDeploySurfaceFiles } from "./deploy-surface-detector";
import { isOverrideSet, OVERRIDE_ENV_VAR } from "./require-deploy-verification-before-merge";

/** The MCP tool this hook reacts to. */
const TARGET_TOOL_NAME = "mcp__minsky__session_pr_merge";

/**
 * Parse a GitHub PR URL (`https://github.com/<owner>/<repo>/pull/<n>`) into
 * `{ repo, prNumber }`. Returns null when the URL doesn't match.
 */
export function parsePrUrl(url: string): { repo: string; prNumber: number } | null {
  const m = url.trim().match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
  if (!m) return null;
  const repo = m[1];
  const prNumber = parseInt(m[2] ?? "", 10);
  if (!repo || isNaN(prNumber) || prNumber <= 0) return null;
  return { repo, prNumber };
}

/** Safe nested lookup: returns the value at `path` in `obj`, or undefined. */
function dig(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Extract `{ repo, prNumber }` from a `session_pr_merge` tool_result. Prefers the
 * `pr_url` under `result.mergeInfo.metadata` (carries owner/repo/number in one
 * field); falls back to `pr_number` from the same metadata combined with the
 * git-remote-derived repo. Returns null when neither resolves.
 */
export function extractMergedPrRef(
  toolResult: Record<string, unknown>,
  cwd: string,
  deriveRepo: (cwd: string) => string | null = deriveRepoFromGit
): { repo: string; prNumber: number } | null {
  const metaPath = ["result", "mergeInfo", "metadata"] as const;

  // Primary: pr_url carries everything.
  const prUrl = dig(toolResult, [...metaPath, "pr_url"]);
  if (typeof prUrl === "string") {
    const parsed = parsePrUrl(prUrl);
    if (parsed) return parsed;
  }

  // Fallback: pr_number + git-remote repo.
  const prNumberRaw = dig(toolResult, [...metaPath, "pr_number"]);
  const prNumber =
    typeof prNumberRaw === "number"
      ? prNumberRaw
      : typeof prNumberRaw === "string"
        ? parseInt(prNumberRaw, 10)
        : NaN;
  if (isNaN(prNumber) || prNumber <= 0) return null;

  const repo = deriveRepo(cwd);
  if (!repo) return null;
  return { repo, prNumber };
}

/** Build the post-merge reminder for a set of touched deploy-surface files. */
export function buildDeployVerificationReminder(deploySurfaceFiles: string[]): string {
  const fileList = deploySurfaceFiles.map((f) => `  - ${f}`).join("\n");
  return [
    "DEPLOY-SURFACE MERGE — the task is NOT done yet.",
    "",
    "This PR touched deploy/infra config:",
    fileList,
    "",
    "DONE was set at merge, but the DEPLOY happens NOW, after merge, and can fail in",
    "ways no pre-merge check catches (Dockerfile breakage, config-as-code resolution",
    "error, crash on start — mt#2345).",
    "",
    "**Required next action (do NOT report the task complete until this passes):**",
    "- Run `mcp__minsky__deployment_wait-for-latest` for the affected service(s) and",
    "  confirm it returns SUCCESS.",
    "- Confirm the runtime actually STARTED — the deploy's /health, or",
    '  `mcp__minsky__deployment_logs(..., type: "deploy")` showing the service booted.',
    '  deploy-SUCCESS is necessary but NOT sufficient; "applied" / "pulumi up exit-0"',
    "  is the ACTION, not the OUTCOME (verify-outcomes-not-actions).",
    "",
    "**If the deploy-verification tool is unavailable (auth / MCP flake): that is a",
    "BLOCKER, not a license to defer.** Reconnect (`/mcp`) and retry. Do NOT downgrade",
    'to an "observational" / "will-watch-future-merges" completion claim — that exact',
    "downgrade is the mt#2345 incident.",
    "",
    '**On FAILED / CRASHED:** call `mcp__minsky__deployment_logs(..., type: "build")`',
    "on the failed deployment, diagnose, and fix-forward in a new PR (or surface with",
    "logs). The task is not done until a healthy deploy is verified.",
  ].join("\n");
}

/**
 * Build the post-merge reminder for a cockpit-tray (LOCAL-APP) binary change
 * (mt#2976). The tray runs from the operator's `/Applications` and its Rust
 * binary is NOT auto-rebuilt, so a merged change is invisible until the app is
 * reinstalled — and the AGENT does the reinstall, not the operator (telling the
 * operator to reinstall manually is the §Turnkey-not-portal anti-pattern the
 * mt#2942 retrospective flagged). This is the structural version of "the agent
 * reinstalls the tray for you": it fires mechanically on every tray-binary merge
 * instead of relying on agent memory across conversations.
 */
export function buildTrayReinstallReminder(trayFiles: string[]): string {
  const fileList = trayFiles.map((f) => `  - ${f}`).join("\n");
  return [
    "COCKPIT-TRAY BINARY MERGE — the fix is NOT live for the operator yet.",
    "",
    "This PR touched the cockpit-tray native binary source:",
    fileList,
    "",
    "The tray is a LOCAL deploy target (it runs from the operator's /Applications).",
    "Unlike `src/cockpit/**` (auto-rebuilt + auto-restarted by the tray,",
    "mt#2297/mt#2299), the tray's own Rust binary is NOT auto-rebuilt — a merged",
    "change is invisible until the app is reinstalled (mt#2942).",
    "",
    "**Required next action — the AGENT does this, NOT the operator (mt#2942):**",
    "- Run `cockpit-tray/scripts/install-local.sh` (app-only build → replace the",
    "  /Applications bundle → re-register scheme), then relaunch it:",
    '  `open "/Applications/Minsky Cockpit.app"` (the script quits the app but does',
    "  NOT relaunch it).",
    "- Reinstalling is env-mutating — it restarts the operator's running cockpit —",
    "  so get explicit consent + confirm a clean end-state before running it",
    "  (memory `427cdf15`). Do NOT tell the operator to reinstall manually.",
    "",
    "Interim until auto-update ships (mt#2962, gated on Apple Developer signing",
    "mt#2201). If the operator declined signing, this reminder IS the mechanism.",
  ].join("\n");
}

export interface PostMergeDeps {
  deriveRepo: (cwd: string) => string | null;
  fetchPrFiles: (repo: string, prNumber: number) => { files: PrFile[]; warning?: string };
}

/**
 * Decide whether to inject the reminder. Returns the reminder string, or null
 * when the hook should be silent (non-matching tool, failed merge, unresolvable
 * PR ref, fetch failure, or no deploy surface touched). Injectable deps make the
 * decision unit-testable without `gh`.
 */
export function decideDeployReminder(
  input: ToolHookInput,
  deps: PostMergeDeps,
  suppressRailway = false
): string | null {
  if (input.tool_name !== TARGET_TOOL_NAME) return null;
  if (!input.tool_result || typeof input.tool_result !== "object") return null;
  if (input.tool_result["success"] !== true) return null;

  const ref = extractMergedPrRef(input.tool_result, input.cwd, deps.deriveRepo);
  if (!ref) return null;

  const { files } = deps.fetchPrFiles(ref.repo, ref.prNumber);
  // MINSKY_SKIP_DEPLOY_VERIFY is a Railway deploy-verification bypass — it must NOT
  // silence the tray reinstall reminder (mt#2976 review): the tray surface is
  // deliberately outside the pre-merge gate, so the post-merge reminder is the ONLY
  // structural prompt for a tray-binary merge. The override drops the Railway section
  // only; the tray section always fires.
  const railwayFiles = suppressRailway ? [] : findDeploySurfaceFiles(files);
  const trayFiles = findLocalAppDeploySurfaceFiles(files);
  if (railwayFiles.length === 0 && trayFiles.length === 0) return null;

  const sections: string[] = [];
  if (railwayFiles.length > 0) sections.push(buildDeployVerificationReminder(railwayFiles));
  if (trayFiles.length > 0) sections.push(buildTrayReinstallReminder(trayFiles));
  return sections.join("\n\n---\n\n");
}

async function main(): Promise<void> {
  let input: ToolHookInput;
  try {
    input = await readInput<ToolHookInput>();
  } catch {
    process.exit(0); // malformed stdin — never block
  }

  // Honor the gate's operator override (MINSKY_SKIP_DEPLOY_VERIFY): a bypass of the
  // pre-merge Railway deploy-verification gate suppresses the Railway post-merge
  // reminder so the operator doesn't get a contradictory signal. It does NOT suppress
  // the tray reinstall reminder — the tray is outside the pre-merge gate, so its
  // reminder is the only structural prompt for a tray merge (mt#2976 review). Audit to
  // STDERR (not stdout) so it never collides with a tray-reminder JSON output.
  const suppressRailway = isOverrideSet();
  if (suppressRailway) {
    process.stderr.write(
      `[deploy-verification-reminder] Railway reminder suppressed: ${OVERRIDE_ENV_VAR}=${process.env[OVERRIDE_ENV_VAR]} ` +
        `(tray reinstall reminder still emitted) at ${new Date().toISOString()}\n`
    );
  }

  const deps: PostMergeDeps = {
    deriveRepo: deriveRepoFromGit,
    fetchPrFiles: (repo, prNumber) => makeProdPrDeps(input.cwd).fetchPrFiles(repo, prNumber),
  };

  let reminder: string | null = null;
  try {
    reminder = decideDeployReminder(input, deps, suppressRailway);
  } catch {
    process.exit(0); // any failure → silent (informational hook)
  }
  if (reminder === null) process.exit(0);

  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: reminder,
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

if (import.meta.main) {
  main();
}
