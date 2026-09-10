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
import { recordFireLogEntry } from "./fire-log";

/** This guard's fire-log identifier (mt#5081). */
export const GUARD_NAME = "deploy-verification-after-merge";
import { deriveRepoFromGit, makeProdPrDeps } from "./require-execution-evidence-before-merge";
import type { PrFile } from "./require-execution-evidence-before-merge";
import {
  findAffectedServices,
  findDeploySurfaceFiles,
  findLocalAppDeploySurfaceFiles,
  listServicesWithDeployConfig,
} from "./deploy-surface-detector";
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

/**
 * Render the affected-services line for the reminder (mt#5002).
 *
 * The reminder used to say "for the affected service(s)" and leave the agent to
 * pick one. The only reasoning material at hand is which service CONSUMES the
 * changed file, and that answer is routinely wrong: `src/generated/**` is consumed
 * by the cockpit but bundled into — and deploys with — `minsky-mcp`
 * (`DEPLOY_SURFACE_SERVICE_MAP`'s `/^src\//` entry, mt#4013). Two sessions picked
 * `cockpit`, ran `verify-deploy.ts cockpit`, got a true-but-irrelevant "no
 * deployment was created", and concluded the GATE was broken (2026-09-04 and
 * 2026-09-09; the second spent a planning cycle and a READY transition on it).
 *
 * Naming the services removes the hand-pick at the moment it happens. The list
 * comes from `findAffectedServices` — the same predicate the merge gate and the
 * post-merge deploy watch read — so the reminder cannot drift from the machinery
 * it is quoting.
 *
 * An EMPTY list is a finding, not a formatting case: it means every touched file
 * resolves to a service with no `deploy.config.ts`, so there is nothing to wait
 * on. Say so explicitly rather than printing an empty bullet list, because an
 * empty list reads as a rendering bug and sends the agent hunting for a service
 * anyway — which is the failure this line exists to prevent.
 */
export function renderAffectedServicesLine(affectedServices: readonly string[]): string {
  if (affectedServices.length === 0) {
    return (
      "Affected service(s): NONE resolved — every touched deploy-surface file maps to a service " +
      "with no `deploy.config.ts`, so there is no deployment to wait on. Do NOT pick a service " +
      "by reasoning about which one consumes the file; if this seems wrong, the fix is in " +
      "`DEPLOY_SURFACE_SERVICE_MAP` (`packages/domain/src/deployment/deploy-surface.ts`)."
    );
  }
  return `Affected service(s), per \`findAffectedServices\`: ${affectedServices.map((s) => `\`${s}\``).join(", ")}`;
}

/**
 * Build the post-merge reminder for a set of touched deploy-surface files.
 *
 * `affectedServices` is the result of `findAffectedServices` over those files
 * (mt#5002) — see {@link renderAffectedServicesLine} for why it is named rather
 * than left to the reader.
 */
export function buildDeployVerificationReminder(
  deploySurfaceFiles: string[],
  affectedServices: readonly string[]
): string {
  const fileList = deploySurfaceFiles.map((f) => `  - ${f}`).join("\n");

  // PR #3713 R1 BLOCKING — an empty resolution gets its OWN reminder, without
  // the wait-for-latest block. "No deployment to wait on" followed by "run
  // deployment_wait-for-latest for EACH service named above" is contradictory
  // guidance, and the contradiction resolves the wrong way: an agent handed an
  // instruction to run a check and no service to run it against will pick one
  // by consumption reasoning, which is the exact failure this line exists to
  // prevent. So the empty case says what IS actionable — the map — and nothing
  // about deploys.
  if (affectedServices.length === 0) {
    return [
      "DEPLOY-SURFACE MERGE — but NO deployment resolves for these files.",
      "",
      "This PR touched deploy/infra config:",
      fileList,
      "",
      renderAffectedServicesLine(affectedServices),
      "",
      "**There is no `deployment_wait-for-latest` to run here.** A deploy-surface file whose",
      "service has no `deploy.config.ts` is a MAP gap, not a deploy to verify: either the",
      "file should not be deploy surface, or its service needs a `deploy.config.ts`. Read",
      "`DEPLOY_SURFACE_SERVICE_MAP` and `listServicesWithDeployConfig` before deciding",
      "which, and record the answer on the task — do not report a deploy as verified,",
      "and do not report one as missing.",
    ].join("\n");
  }

  return [
    "DEPLOY-SURFACE MERGE — the task is NOT done yet.",
    "",
    "This PR touched deploy/infra config:",
    fileList,
    "",
    renderAffectedServicesLine(affectedServices),
    "",
    "DONE was set at merge, but the DEPLOY happens NOW, after merge, and can fail in",
    "ways no pre-merge check catches (Dockerfile breakage, config-as-code resolution",
    "error, crash on start — mt#2345).",
    "",
    "**Required next action (do NOT report the task complete until this passes):**",
    "- Run `mcp__minsky__deployment_wait-for-latest` for EACH service named above and",
    "  confirm it returns SUCCESS. Pass `service:` explicitly — do NOT substitute a",
    "  service you infer from which code consumes the changed file; the list above",
    "  is what the deploy machinery attributes the files to, and the two differ.",
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
    "**With MCP down, the same capability is on the CLI — it does not vanish (mt#4425):**",
    "```",
    "minsky deployment wait-for-latest --service <svc> --not-before <merge-iso>",
    "minsky deployment status --service <svc>",
    "minsky deployment logs <deploymentId> --type build --service <svc>",
    "```",
    "Or run the whole chain — deployment + build identity + health identity — at once:",
    "```",
    "bun scripts/verify-deploy.ts <svc> --merged-at <merge-iso> --commit <merge-sha>",
    "```",
    "Note `--not-before` / `--merged-at` is what makes the check able to fail: without",
    "it the wait returns whatever deployment is newest, which can predate your merge",
    "entirely and reports SUCCESS for a deploy that never ran (mt#3890).",
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
  /**
   * Services that have a `deploy.config.ts` under `<cwd>/services/` (mt#5002).
   * Injected rather than read inside `decideDeployReminder` so the decision stays
   * unit-testable without a services/ tree on disk; production wires
   * `listServicesWithDeployConfig`.
   */
  listAvailableServices: (cwd: string) => readonly string[];
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
  if (railwayFiles.length > 0) {
    // mt#5002: name the services rather than leaving the agent to pick one. The
    // available-services read is injected (see `PostMergeDeps`); a failure there
    // is caught by `main()`'s outer try and goes silent, matching every other
    // failure mode of this informational hook.
    const { services } = findAffectedServices(railwayFiles, deps.listAvailableServices(input.cwd));
    sections.push(buildDeployVerificationReminder(railwayFiles, services));
  }
  if (trayFiles.length > 0) sections.push(buildTrayReinstallReminder(trayFiles));
  return sections.join("\n\n---\n\n");
}

async function main(): Promise<void> {
  const startMs = Date.now();
  let input: ToolHookInput;
  try {
    input = await readInput<ToolHookInput>();
  } catch {
    // Malformed stdin — never block. Recorded as a crash with no attribution
    // (PR #3715 R1), consistent with every other guard this task touched.
    recordFireLogEntry({
      guardName: GUARD_NAME,
      event: "PostToolUse",
      decision: "allow",
      guardOutcome: "crashed",
      durationMs: Date.now() - startMs,
    });
    process.exit(0);
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
    listAvailableServices: (cwd) => listServicesWithDeployConfig(cwd),
  };

  let reminder: string | null = null;
  let outcome: "decided" | "crashed" = "decided";
  try {
    reminder = decideDeployReminder(input, deps, suppressRailway);
  } catch {
    outcome = "crashed"; // any failure → silent (informational hook), but recorded
  }

  if (reminder !== null) {
    const output: HookOutput = {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: reminder,
      },
    };
    process.stdout.write(JSON.stringify(output));
  }

  // mt#5081: fire-log every evaluation, exactly once — `warn` on injection,
  // `allow` on pass-through, the dispatcher's mapping. The override, when set,
  // is recorded as an env-sourced override so the classification join sees it.
  recordFireLogEntry({
    guardName: GUARD_NAME,
    event: "PostToolUse",
    decision: reminder !== null ? "warn" : "allow",
    guardOutcome: outcome,
    durationMs: Date.now() - startMs,
    toolName: input.tool_name,
    sessionId: input.session_id,
    ...(suppressRailway
      ? { overrideEnvVar: OVERRIDE_ENV_VAR, overrideSource: "env" as const }
      : {}),
  });
  process.exit(0);
}

if (import.meta.main) {
  main();
}
