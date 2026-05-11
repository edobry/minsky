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

import { readInput, writeOutput, execWithPath, readHostCap, deriveBudgets } from "./types";
import type { ToolHookInput } from "./types";

// ---------------------------------------------------------------------------
// Budget derivation (mt#1546 pattern)
// ---------------------------------------------------------------------------
//
// Single gh call per hook invocation (PR body fetch). The session_pr_merge
// path collapses the PR-number lookup and body fetch into one `gh pr list`
// call (returns both fields). The bash bypass path extracts the PR number
// from the URL and makes one `gh pr view` call. Either way: one gh call.
//
// Per-call budget = 70% of overall budget (60% of host cap) ≈ 6.3s on the
// 15s host cap, well within typical gh API latency.

const GH_CALL_BUDGET_RATIO = 0.7;

function deriveGhTimeoutMs(): number {
  const { hostCapSec } = readHostCap("block-out-of-band-merge.ts");
  const { overallBudgetMs } = deriveBudgets(hostCapSec);
  return Math.floor(overallBudgetMs * GH_CALL_BUDGET_RATIO);
}

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
// PR #1020 R1 BLOCKING #2: speculative phrases ("infra mutation",
// "applied separately", "configure separately", "infra change required")
// were dropped to reduce false-positive risk on benign PRs. Each remaining
// phrase is either an exact substring of the mt#1681 PR body OR a
// tightly-scoped Railway/GraphQL identifier with near-zero benign use:
//
//   - out-of-band, post-merge config, Railway config change: literal
//     phrases observed in mt#1681 PR #1013 body
//   - serviceInstanceUpdate: Railway GraphQL mutation name
//   - rootDirectory, dockerfilePath: Railway service-config field names
//
// If a future incident introduces a new coupled-step shape, add the
// concrete phrase observed in that PR's body — don't add speculative
// generic terms.
const TRIGGER_PHRASES: ReadonlyArray<string> = [
  "out-of-band",
  "post-merge config",
  "Railway config change",
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
 * Replace markdown contexts that carry textual references (not coordination
 * instructions) with same-length whitespace. Preserves character positions so
 * `indexOf` results in the returned text remain valid offsets into the original
 * body — excerpts can still be sliced from the original to show real context.
 *
 * Passes (in order):
 *   1. Fenced code blocks (```...```) — multi-line, processed first so they
 *      cannot be later misread as containing inline spans or blockquotes.
 *   2. Inline code spans (`...`) — single-line, backtick-delimited.
 *   3. Blockquote lines (lines starting with `>`).
 *
 * The replacement preserves newlines so line-anchored passes after pass 1
 * still align correctly.
 *
 * Catches the mt#1701 PR #1021 false-positive class: docs PRs that legitimately
 * reference trigger phrases as field names in code spans, rather than as
 * coordination instructions in bare prose.
 */
export function elideMarkdownNonProse(body: string): string {
  const blankSameLength = (match: string): string => match.replace(/[^\n]/g, " ");

  // Pass 1: fenced code blocks (```lang ... ``` on its own line).
  let cleaned = body.replace(/^```[\s\S]*?^```$/gm, blankSameLength);

  // Pass 2: inline code spans. Excludes newlines so multi-line content isn't
  // accidentally swallowed when authors forget to close a backtick.
  cleaned = cleaned.replace(/`[^`\n]+`/g, blankSameLength);

  // Pass 3: blockquote lines.
  cleaned = cleaned.replace(/^>[^\n]*$/gm, blankSameLength);

  return cleaned;
}

/**
 * Scan a PR body for trigger phrases (case-insensitive). Returns one match
 * per distinct phrase that appears at least once. Each match includes a
 * short excerpt of the surrounding text so the operator can see the context.
 *
 * Returns an empty array when no triggers are present.
 *
 * Markdown contexts that carry textual references (code spans, code fences,
 * blockquotes) are filtered out before scanning via {@link elideMarkdownNonProse}
 * so trigger phrases appearing as field-name references don't fire the gate.
 * Excerpts are still sliced from the ORIGINAL body so the operator sees real
 * surrounding context.
 */
export function scanForTriggerPhrases(body: string): PhraseMatch[] {
  if (!body) return [];
  const matches: PhraseMatch[] = [];
  // Same-length whitespace replacement preserves positions: a phrase found at
  // offset N in the elided text occupies the same offset N in the original
  // body. Excerpts slice from `body`, so they show what the operator wrote.
  const scanText = elideMarkdownNonProse(body).toLowerCase();
  for (const phrase of TRIGGER_PHRASES) {
    const idx = scanText.indexOf(phrase.toLowerCase());
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

// ---------------------------------------------------------------------------
// PR fetch — combined and body-only forms
// ---------------------------------------------------------------------------
//
// Two call shapes share a result type:
//   - resolvePrFromTask: session_pr_merge path. Looks up PR by branch via
//     `gh pr list --head task/<id> --json number,body`. Returns BOTH the
//     PR number and body in one call.
//   - fetchPrBody: bash bypass path. PR number already extracted from the
//     `gh api PUT /pulls/N/merge` URL; only the body needs fetching via
//     `gh pr view N --json body`.
//
// PR #1020 R1 BLOCKING #1: collapsing to a single gh call per hook
// invocation eliminates the two-sequential-call timeout overrun risk.

export interface PrFetchSuccess {
  ok: true;
  prNumber: number;
  body: string;
}
export interface PrFetchFailure {
  ok: false;
  error: string;
}
export type PrFetchResult = PrFetchSuccess | PrFetchFailure;

/**
 * Single gh call that returns BOTH the PR number and body for a session
 * branch. Used by the session_pr_merge code path. Returns null when no PR
 * exists for the branch (legitimately — branch hasn't pushed yet, PR was
 * already merged, etc.); returns a structured failure for transport
 * errors.
 */
export function resolvePrFromTask(task: string, timeoutMs: number): PrFetchResult | null {
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
      "number,body",
      "--jq",
      ".[0]",
    ],
    { timeout: timeoutMs }
  );
  if (result.timedOut) {
    return { ok: false, error: `gh pr list timed out: ${result.stderr || "(no stderr)"}` };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: `gh pr list exited ${result.exitCode}: ${result.stderr || "(no stderr)"}`,
    };
  }
  const trimmed = result.stdout.trim();
  if (!trimmed || trimmed === "null") return null; // No matching PR — not an error, not a hit
  let parsed: { number?: unknown; body?: unknown };
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return {
      ok: false,
      error: `failed to parse gh pr list response: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (typeof parsed.number !== "number" || typeof parsed.body !== "string") {
    return { ok: false, error: "gh pr list response missing number or body field" };
  }
  return { ok: true, prNumber: parsed.number, body: parsed.body };
}

/**
 * Fetch a PR's body by number via `gh pr view`. Used by the bash bypass code
 * path where the PR number is already extracted from the `gh api PUT /merge`
 * URL.
 */
export function fetchPrBody(prNumber: number, timeoutMs: number): PrFetchResult {
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
    { timeout: timeoutMs }
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
  return { ok: true, prNumber, body: result.stdout };
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
  const ghTimeoutMs = deriveGhTimeoutMs();

  // Single gh call per invocation (PR #1020 R1 BLOCKING #1 fix). The two
  // tool surfaces fetch differently:
  //   - session_pr_merge: combined `gh pr list --json number,body` — one call
  //   - bash bypass: extract PR number from URL (no gh call) + `gh pr view` — one call
  let fetchResult: PrFetchResult | null = null;

  if (toolName === "mcp__minsky__session_pr_merge") {
    const task = (input.tool_input.task as string | undefined) ?? "";
    fetchResult = resolvePrFromTask(task, ghTimeoutMs);
    // null = no PR exists for branch (legitimate; allow silently)
    if (fetchResult === null) process.exit(0);
  } else if (toolName === "Bash" || toolName === "mcp__minsky__session_exec") {
    const command = (input.tool_input.command as string | undefined) ?? "";
    const prNumber = extractPrNumberFromGhApiCommand(command);
    // If no PR-merge endpoint in the command, this isn't a merge — allow silently.
    if (prNumber === null) process.exit(0);
    fetchResult = fetchPrBody(prNumber, ghTimeoutMs);
  } else {
    // Hook ran on an unrelated tool — allow.
    process.exit(0);
  }

  if (!fetchResult.ok) {
    // Fail-open: emit a warning to stderr (the conventional channel for
    // operator warnings; matches check-branch-fresh.ts) so the operator sees
    // that the gate could not run, then allow the merge.
    console.error(
      `[block-out-of-band-merge] WARNING: could not fetch PR body — gate did not run. ` +
        `Reason: ${fetchResult.error}`
    );
    process.exit(0);
  }

  const { prNumber, body } = fetchResult;

  // Scan for triggers
  const matches = scanForTriggerPhrases(body);
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
