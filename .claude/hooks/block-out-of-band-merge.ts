#!/usr/bin/env bun
// PreToolUse hook: block PR merges when the PR body documents a coupled
// out-of-band coordination step that may not have been completed.
//
// ## Origin
//
// mt#1681 / PR #1013 (2026-05-09) merged code that required a Railway service-config
// flip (rootDirectory + dockerfilePath) to complete the deploy. The PR body explicitly
// documented this as "out-of-band, post-merge." After merge, the auto-mode classifier
// denied the GraphQL mutation. The codebase + Railway entered a half-shipped state:
// current deploy was alive but the next push to main triggered a failed build because
// Railway used the old build context with the new Dockerfile.
//
// The cognitive failure: treating "documented in the PR body" as equivalent to
// "addressed." Documentation in the PR body is read by reviewers AFTER merge — it's
// not a pre-merge gate. This hook IS that gate.
//
// ## Sibling structural fix
//
// mt#1626 added a /plan-task gate (criterion h) for "contract-propagation enumeration"
// — the planning-time complement. This hook is the merge-time complement; both fire
// independently. mt#1626 catches at task-planning, this catches at the actual merge.
//
// ## Scope
//
// Matches on `mcp__minsky__session_pr_merge` AND on `Bash`/`mcp__minsky__session_exec`
// when invoking `gh api PUT .../pulls/N/merge` (the bypass path).
//
// Reads the PR body via `gh pr view <number> --json body`. Greps for trigger phrases
// that historically have indicated coupled out-of-band steps. On match, blocks with
// a structured message naming the matched phrases and the override mechanism.
//
// ## Override
//
// Set `MINSKY_ACK_OOB_MERGE=1` to acknowledge that the out-of-band step has been
// completed (or is intentionally deferred). The override emits an audit-log line
// to stdout naming the PR, matched phrases, and timestamp.
//
// ## Fail-open posture
//
// If the PR body cannot be fetched (network error, gh auth issue, PR not found), the
// hook emits a warning and ALLOWS the merge. This is the same pattern as
// `check-branch-fresh.ts` — the hook should never block a merge for reasons unrelated
// to its own concern.
//
// @see mt#1695 — tracking task
// @see feedback memory ecc83f8d-585f-4fe2-bf43-d1409dd7e2e5 — bridge memory this hook retires
// @see mt#1626 — sibling planning-time gate (DONE)
// @see mt#1681 — originating incident (DONE; PR #1013)
// @see require-review-before-merge.ts — sibling hook on session_pr_merge (PR-context fetch pattern)
// @see block-subagent-bypass-merge.ts — sibling hook on Bash gh-api PUT merge (command parsing pattern)

import { readInput, writeOutput, execWithPath } from "./types";
import type { ToolHookInput } from "./types";

// ---------------------------------------------------------------------------
// Trigger phrases — case-insensitive, derived from mt#1681 PR #1013 body
// (and the mt#1624 SESSIONDB env-var class).
// ---------------------------------------------------------------------------
//
// These phrases historically signal "coupled non-code step that must happen
// outside this PR's diff." When any appears in a PR body, the merge is gated.
//
// Adding new phrases: prefer narrow, observed phrases (from real incidents)
// over speculative ones. Each phrase should describe a concrete coordination
// shape, not a generic concern. Over-broad phrases produce false positives
// that erode operator trust in the gate.
const TRIGGER_PHRASES: ReadonlyArray<string> = [
  "out-of-band",
  "post-merge config",
  "Railway config change",
  "applied separately",
  "configure separately",
  "infra change required",
  "infra mutation",
  "serviceInstanceUpdate",
  "rootDirectory",
  "dockerfilePath",
];

// ---------------------------------------------------------------------------
// Phrase scanning
// ---------------------------------------------------------------------------

export interface PhraseMatch {
  phrase: string;
  /** ~120-char excerpt of the surrounding text for operator context */
  excerpt: string;
}

/**
 * Scan a PR body for trigger phrases (case-insensitive). Returns one match
 * per distinct phrase that appears at least once. Each match includes a
 * short excerpt of the surrounding text so the operator can see the context.
 *
 * Returns an empty array when no triggers are present.
 */
export function scanForTriggerPhrases(body: string): PhraseMatch[] {
  if (!body) return [];
  const matches: PhraseMatch[] = [];
  const lower = body.toLowerCase();
  for (const phrase of TRIGGER_PHRASES) {
    const idx = lower.indexOf(phrase.toLowerCase());
    if (idx === -1) continue;
    // Excerpt: ~50 chars before + the match + ~50 chars after, on a single line
    const start = Math.max(0, idx - 50);
    const end = Math.min(body.length, idx + phrase.length + 50);
    const excerpt = body.slice(start, end).replace(/\s+/g, " ").trim();
    matches.push({ phrase, excerpt });
  }
  return matches;
}

// ---------------------------------------------------------------------------
// PR-number extraction
// ---------------------------------------------------------------------------

/**
 * Extract a PR number from a `gh api PUT .../pulls/<N>/merge` command string.
 *
 * Matches the same `/pulls/<N>/merge` pattern as block-subagent-bypass-merge.ts.
 * Returns null if no PR number is found (the merge command isn't the bypass-merge
 * shape, or it uses an env-var URL where the PR number isn't visible at parse time).
 */
export function extractPrNumberFromGhApiCommand(command: string): number | null {
  const m = /\/pulls\/(\d+)\/merge\b/.exec(command);
  if (!m) return null;
  const n = parseInt(m[1] as string, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve a PR number from a session_pr_merge tool input. Uses the `task` field
 * to look up the PR via `gh pr list --head task/<id>`.
 *
 * Returns null if no task is provided or no matching PR exists.
 */
export function resolvePrNumberFromTask(task: string): number | null {
  if (!task) return null;
  const branch = `task/${task.replace("#", "-")}`;
  const result = execWithPath(
    [
      "gh",
      "pr",
      "list",
      "--repo",
      "edobry/minsky",
      "--head",
      branch,
      "--json",
      "number",
      "--jq",
      ".[0].number",
    ],
    { timeout: 10_000 }
  );
  if (result.exitCode !== 0) return null;
  const trimmed = result.stdout.trim();
  if (!trimmed) return null;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// PR-body fetch
// ---------------------------------------------------------------------------

export interface PrBodyFetchSuccess {
  ok: true;
  body: string;
}
export interface PrBodyFetchFailure {
  ok: false;
  error: string;
}
export type PrBodyFetchResult = PrBodyFetchSuccess | PrBodyFetchFailure;

/**
 * Fetch a PR's body via `gh pr view`. Returns the body text or a structured
 * failure (network/auth/parse error). Failures are NOT denials — see fail-open
 * posture in the file header.
 */
export function fetchPrBody(prNumber: number): PrBodyFetchResult {
  const result = execWithPath(
    [
      "gh",
      "pr",
      "view",
      String(prNumber),
      "--repo",
      "edobry/minsky",
      "--json",
      "body",
      "--jq",
      ".body",
    ],
    { timeout: 10_000 }
  );
  if (result.timedOut) {
    return { ok: false, error: `gh pr view timed out: ${result.stderr || "(no stderr)"}` };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: `gh pr view exited ${result.exitCode}: ${result.stderr || "(no stderr)"}`,
    };
  }
  // gh emits the raw body string; --jq .body returns it without JSON quoting
  return { ok: true, body: result.stdout };
}

// ---------------------------------------------------------------------------
// Override + audit
// ---------------------------------------------------------------------------

const OVERRIDE_ENV_VAR = "MINSKY_ACK_OOB_MERGE";

/**
 * True when the operator has explicitly acknowledged the out-of-band step.
 */
export function isOverrideSet(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[OVERRIDE_ENV_VAR] === "1";
}

/**
 * Emit an audit-log line for an override. Writes to stdout (visible in the
 * session transcript) so the override is recoverable from the session log.
 */
export function emitOverrideAuditLog(prNumber: number | null, matches: PhraseMatch[]): void {
  const ts = new Date().toISOString();
  const phrases = matches.map((m) => m.phrase).join(", ");
  const prRef = prNumber === null ? "(unknown PR)" : `PR #${prNumber}`;

  console.log(
    `[block-out-of-band-merge] OVERRIDE ${OVERRIDE_ENV_VAR}=1 — ${prRef} — phrases: [${phrases}] — ts: ${ts}`
  );
}

// ---------------------------------------------------------------------------
// Denial message construction
// ---------------------------------------------------------------------------

export function buildDenialReason(prNumber: number | null, matches: PhraseMatch[]): string {
  const prRef = prNumber === null ? "this PR" : `PR #${prNumber}`;
  const phraseList = matches.map((m) => `  - "${m.phrase}" — ...${m.excerpt}...`).join("\n");
  return (
    `${prRef}'s body documents a coupled out-of-band step. ` +
    `Confirm the step is completed (or pre-authorized) BEFORE merging.\n\n` +
    `Matched trigger phrases:\n${phraseList}\n\n` +
    `If the out-of-band step has been completed (or is intentionally deferred with ` +
    `acknowledgment), set ${OVERRIDE_ENV_VAR}=1 in your environment and retry. ` +
    `The override is audit-logged.\n\n` +
    `Originating incident: mt#1681 PR #1013 — Railway service-config flip never ` +
    `executed post-merge, leaving the next deploy in a failure state. ` +
    `Tracking task: mt#1695. ` +
    `Sibling planning-time gate: mt#1626.`
  );
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();
  const toolName = input.tool_name;

  // Resolve the PR number from the tool invocation context
  let prNumber: number | null = null;

  if (toolName === "mcp__minsky__session_pr_merge") {
    const task = (input.tool_input.task as string | undefined) ?? "";
    prNumber = resolvePrNumberFromTask(task);
  } else if (toolName === "Bash" || toolName === "mcp__minsky__session_exec") {
    const command = (input.tool_input.command as string | undefined) ?? "";
    prNumber = extractPrNumberFromGhApiCommand(command);
    // If no PR-merge endpoint in the command, this isn't a merge — allow silently.
    if (prNumber === null) process.exit(0);
  } else {
    // Hook ran on an unrelated tool — allow.
    process.exit(0);
  }

  // No PR number resolved (e.g., session_pr_merge with no task, or bypass with
  // an env-var URL that masks the PR number). Allow silently — fail-open.
  if (prNumber === null) process.exit(0);

  // Fetch the PR body
  const fetchResult = fetchPrBody(prNumber);
  if (!fetchResult.ok) {
    // Fail-open: emit a warning to stdout so the operator sees that the gate
    // could not run, then allow the merge.

    console.error(
      `[block-out-of-band-merge] WARNING: could not fetch PR #${prNumber} body — gate ` +
        `did not run. Reason: ${fetchResult.error}`
    );
    process.exit(0);
  }

  // Scan for triggers
  const matches = scanForTriggerPhrases(fetchResult.body);
  if (matches.length === 0) {
    // No coupled-step language in PR body — allow.
    process.exit(0);
  }

  // Triggers found. Check for operator override.
  if (isOverrideSet()) {
    emitOverrideAuditLog(prNumber, matches);
    process.exit(0);
  }

  // Block the merge with a structured message.
  writeOutput({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: buildDenialReason(prNumber, matches),
    },
  });
  process.exit(0);
}
