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
// Two trigger categories (mt#2002):
//
// 1. STANDALONE — phrases that fire on any occurrence in bare prose. These
//    describe coordination shapes with no benign use pattern. Originally the
//    entire trigger list; narrowed in mt#2002 to just the phrases that
//    cannot reasonably appear as field-name references or historical-incident
//    descriptors. Narrowed further in mt#2019 to drop "out-of-band" as a
//    standalone trigger (too broad — fires on architectural prose like
//    "out-of-band consumers" describing module callers, originating incident
//    mt#2010 PR #1217). The Railway/config-specific phrases cover the true-
//    positive class without the broad phrase.
//
// 2. PAIR-REQUIRED — phrases that fire only when a PAIR_PARTNER appears in
//    the SAME PARAGRAPH (CommonMark paragraph: separated by a blank line).
//    Pair-required phrases are Railway/config-field identifiers that
//    legitimately appear in PR bodies as:
//      - test-plan documentation ("set rootDirectory to empty in dashboard")
//      - synthesizer-shipping descriptions ("the dockerfilePath synthesizer")
//      - historical-incident cross-references ("mt#1681 PR #1013 (rootDirectory
//        + dockerfilePath flip ...)")
//    None of these is an out-of-band coordination instruction; firing on bare
//    occurrence produced systematic false positives (originating sample:
//    mt#1707 PR #1028 self-fire; mt#1964 PR #1204 self-fire).
//
// PAIR_PARTNER phrases signal that a coordination instruction is being given.
// When a pair-required phrase appears in the same paragraph as a partner,
// the combination is the strong signal; when it appears alone, it's likely a
// reference.
//
// "out-of-band" as a PAIR_PARTNER: the phrase remains meaningful as a
// coordination signal when it appears alongside Railway/config field names
// (e.g., "out-of-band, flip rootDirectory on Railway"). Keeping it as a
// PAIR_PARTNER while removing it from STANDALONE preserves the true-positive
// contribution without firing on standalone architectural prose.
//
// Adding new phrases: prefer narrow, observed phrases (from real incidents)
// over speculative ones. If a future incident introduces a new coupled-step
// shape, add the concrete phrase observed in that PR's body — don't add
// speculative generic terms.

const STANDALONE_TRIGGER_PHRASES: ReadonlyArray<string> = [
  "post-merge config",
  "serviceInstanceUpdate",
];

const PAIR_REQUIRED_PHRASES: ReadonlyArray<string> = [
  "Railway config change",
  "rootDirectory",
  "dockerfilePath",
];

/**
 * Phrases that, when present in the same paragraph as a PAIR_REQUIRED
 * phrase, cause the pair-required phrase to fire. "out-of-band" and
 * "post-merge" are the partners. Including the bare "post-merge" form
 * (without "config") also matches phrasings like "After merge (post-merge),
 * flip rootDirectory". "out-of-band" is kept here as a partner even though
 * it is no longer a standalone trigger — it still signals coordination
 * context when it co-appears with Railway/config field names (mt#2019).
 */
const PAIR_PARTNER_PHRASES: ReadonlyArray<string> = ["out-of-band", "post-merge"];

/**
 * All phrases the scanner reports on — used by tests and by older callers
 * that want a complete listing. Order is preserved (standalone first, then
 * pair-required) for stable output formatting.
 */
export const TRIGGER_PHRASES: ReadonlyArray<string> = [
  ...STANDALONE_TRIGGER_PHRASES,
  ...PAIR_REQUIRED_PHRASES,
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
 * CommonMark coverage (PR #1028 R1 BLOCKING #1 / #2 fix):
 *   1. Fenced code blocks — backtick OR tilde fences (3+ markers); opening
 *      line may be indented up to 3 spaces and carry an info string; closing
 *      fence matches the opening marker exactly (same kind, same count) with
 *      tolerance for trailing whitespace and CR before LF.
 *   2. Inline code spans — variable-length backtick runs per CommonMark
 *      (`foo`, ``foo``, ```foo``` …). Closing run must match the opening run
 *      length and not be followed by another backtick.
 *   3. Blockquote lines — up to 3 leading spaces, one-or-more `>` markers
 *      (covers nesting), CRLF-tolerant.
 *
 * The replacement preserves newlines so line-anchored passes after pass 1
 * still align correctly.
 *
 * Known limitation (NON-BLOCKING per PR #1028 R1): CommonMark "lazy
 * continuation" — a blockquote paragraph wrapped onto subsequent lines
 * without a leading `>` marker. The wrapped lines look like prose and will
 * be scanned. This is rare in PR bodies and the false-positive risk is low;
 * documented here so a future regression can be diagnosed quickly.
 *
 * Catches the mt#1701 PR #1021 false-positive class: docs PRs that legitimately
 * reference trigger phrases as field names in code spans, rather than as
 * coordination instructions in bare prose.
 */
export function elideMarkdownNonProse(body: string): string {
  const blankSameLength = (match: string): string => match.replace(/[^\n]/g, " ");

  // Pass 1: fenced code blocks.
  //   ^ {0,3}        — up to 3 leading spaces (CommonMark indent rule)
  //   (`{3,}|~{3,})  — capture group 1: 3+ backticks OR 3+ tildes
  //   [^\r\n]*       — optional info string on the opening line
  //   \r?\n          — opening newline (CRLF or LF)
  //   [\s\S]*?       — content (non-greedy, includes newlines)
  //   ^ {0,3}\1      — closing fence: 0-3 spaces + same marker run
  //   [ \t]*\r?$     — optional trailing whitespace, CR before LF tolerance
  let cleaned = body.replace(
    /^ {0,3}(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?^ {0,3}\1[ \t]*\r?$/gm,
    blankSameLength
  );

  // Pass 2: inline code spans with variable-length backtick delimiters.
  //   (`+)              — capture run of N backticks
  //   ([^\n]+?)         — content (non-greedy, no newlines)
  //   \1                — closing run of same N backticks
  //   (?!`)             — not followed by another backtick (so we don't eat
  //                       into a longer run that should have been the opener)
  cleaned = cleaned.replace(/(`+)([^\n]+?)\1(?!`)/g, blankSameLength);

  // Pass 3: blockquote lines.
  //   ^ {0,3}    — up to 3 leading spaces
  //   >+         — one or more `>` (covers nested quotes like `>>`)
  //   [^\n]*     — line content
  //   \r?$       — CRLF-tolerant line end
  cleaned = cleaned.replace(/^ {0,3}>+[^\n]*\r?$/gm, blankSameLength);

  return cleaned;
}

/**
 * Split a body into CommonMark-style paragraphs separated by blank lines.
 * Returns the lowercase text of each paragraph alongside its starting
 * character offset in the input string so callers can re-anchor matches
 * back to the original body for excerpt extraction.
 *
 * Used by {@link scanForTriggerPhrases} to implement mt#2002's
 * pair-requirement: a pair-required phrase only fires when a partner
 * phrase appears in the same paragraph.
 */
function splitIntoParagraphs(text: string): Array<{ text: string; offset: number }> {
  const paragraphs: Array<{ text: string; offset: number }> = [];
  // CommonMark paragraph boundary: one or more blank lines.
  // Use a regex with global flag to walk the text and capture both
  // the paragraph content AND its starting offset.
  const paragraphBoundaryRe = /\r?\n\s*\r?\n/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = paragraphBoundaryRe.exec(text)) !== null) {
    const content = text.slice(lastEnd, m.index);
    if (content.length > 0) {
      paragraphs.push({ text: content, offset: lastEnd });
    }
    lastEnd = paragraphBoundaryRe.lastIndex;
  }
  // Final paragraph (no trailing blank line).
  if (lastEnd < text.length) {
    const content = text.slice(lastEnd);
    if (content.length > 0) {
      paragraphs.push({ text: content, offset: lastEnd });
    }
  }
  return paragraphs;
}

/**
 * Scan a PR body for trigger phrases (case-insensitive). Returns one match
 * per distinct phrase that appears at least once. Each match includes a
 * short excerpt of the surrounding text so the operator can see the context.
 *
 * Returns an empty array when no triggers are present.
 *
 * Two-stage scan (mt#2002, refined mt#2019):
 *
 *   1. STANDALONE phrases ("post-merge config", "serviceInstanceUpdate") fire
 *      on any bare-prose occurrence anywhere in the body. "out-of-band" was
 *      removed from this category in mt#2019 to prevent false positives on
 *      architectural prose (e.g., "out-of-band consumers" describing module
 *      callers — mt#2010 originating incident). It remains a PAIR_PARTNER so
 *      it still activates pair-required phrases when co-occurring with Railway
 *      field names.
 *
 *   2. PAIR-REQUIRED phrases ("rootDirectory", "dockerfilePath",
 *      "Railway config change") fire only when a PAIR_PARTNER ("out-of-band"
 *      or "post-merge") appears in the SAME PARAGRAPH (CommonMark
 *      paragraph: text separated by a blank line). This suppresses the
 *      false-positive class where Railway field names appear in PR bodies
 *      as test-plan documentation, synthesizer-shipping descriptions, or
 *      historical-incident cross-references without an actual coordination
 *      instruction.
 *
 * Markdown contexts that carry textual references (code spans, code fences,
 * blockquotes) are filtered out before scanning via {@link elideMarkdownNonProse}
 * (mt#1707) so trigger phrases appearing as field-name references don't fire
 * the gate. Excerpts are still sliced from the ORIGINAL body so the operator
 * sees real surrounding context.
 */
export function scanForTriggerPhrases(body: string): PhraseMatch[] {
  if (!body) return [];
  // Same-length whitespace replacement preserves positions: a phrase found at
  // offset N in the elided text occupies the same offset N in the original
  // body. Excerpts slice from `body`, so they show what the operator wrote.
  const scanText = elideMarkdownNonProse(body).toLowerCase();

  // Track matches by phrase (dedup; first occurrence wins for excerpt).
  const seenPhrases = new Map<string, PhraseMatch>();
  const addMatch = (phrase: string, idx: number): void => {
    if (seenPhrases.has(phrase)) return;
    const start = Math.max(0, idx - 50);
    const end = Math.min(body.length, idx + phrase.length + 50);
    const excerpt = body.slice(start, end).replace(/\s+/g, " ").trim();
    seenPhrases.set(phrase, { phrase, excerpt });
  };

  // Stage 1: STANDALONE phrases — fire on any occurrence.
  for (const phrase of STANDALONE_TRIGGER_PHRASES) {
    const idx = scanText.indexOf(phrase.toLowerCase());
    if (idx !== -1) addMatch(phrase, idx);
  }

  // Stage 2: PAIR-REQUIRED phrases — fire only when paired with a
  // PAIR_PARTNER in the same paragraph.
  const paragraphs = splitIntoParagraphs(scanText);
  const lowerPartners = PAIR_PARTNER_PHRASES.map((p) => p.toLowerCase());
  for (const { text: paragraphText, offset } of paragraphs) {
    const hasPartner = lowerPartners.some((partner) => paragraphText.includes(partner));
    if (!hasPartner) continue;
    for (const phrase of PAIR_REQUIRED_PHRASES) {
      const idxInParagraph = paragraphText.indexOf(phrase.toLowerCase());
      if (idxInParagraph !== -1) {
        addMatch(phrase, offset + idxInParagraph);
      }
    }
  }

  // Preserve declaration order: standalone first, then pair-required.
  const ordered: PhraseMatch[] = [];
  for (const phrase of [...STANDALONE_TRIGGER_PHRASES, ...PAIR_REQUIRED_PHRASES]) {
    const m = seenPhrases.get(phrase);
    if (m) ordered.push(m);
  }
  return ordered;
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
