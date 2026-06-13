#!/usr/bin/env bun
// UserPromptSubmit hook: detect code-mechanism assertions made WITHOUT a
// same-turn read of the named symbol. Per mt#2486 (tier-2 of mt#2485).
//
// The narrow, high-precision slice of the "assertion frozen as fact without
// verification" family (root memory 3772c77d): the agent asserts what a NAMED
// code symbol DOES — "executeCommand clamps maxBuffer to 10MB", "the 1MB default
// maxBuffer", "X returns null when Y" — without having read that symbol this
// turn. The R9 maxBuffer incident (PR #1694, 2026-06-13) is the canonical case:
// claimed executeCommand's buffer default without reading exec.ts (it was 10MB,
// not 1MB; payload was 850KB, so the buffer was never the cause).
//
// Narrowness IS the precision lever. Unlike the broad causal-premise detector
// (mt#2366), which must judge ANY causal claim and so cannot reach subtle cases
// without unacceptable false positives, this fires ONLY on code-symbol-behavior
// claims, where high precision is achievable.
//
// CALIBRATION-FIRST: in v1, INJECTION_ENABLED = false — logs matches to a
// calibration JSONL and injects NOTHING. Flip to injection only after the FP
// rate is reviewed (mt#2483 calibration-review sweep).
//
// Detector contract:
//   FIRES when the prior assistant turn asserts a named code symbol's BEHAVIOR
//   (a behavioral predicate — clamps/defaults to/overrides/returns/... — within
//   proximity of a symbol-shaped token) AND the symbol does NOT appear in any
//   same-turn tool_result content OR read-class tool input. A same-turn read of
//   the symbol's file backs the claim because the file source (containing the
//   symbol) lands in the tool_result.
//   DOES NOT FIRE when:
//   - the symbol appears in a same-turn tool_result / read-class tool input,
//   - no symbol-shaped token sits near a behavioral predicate,
//   - the predicate+symbol is inside a fenced code block or blockquote (pasted
//     output / a quote, not a fresh assertion).
//
// Known v1 limitation (measured by calibration, addressed in a v2 if warranted):
//   backing is symbol-token presence in the turn's tool corpus. A read whose
//   result does not literally contain the symbol token (e.g. the symbol is
//   computed/aliased) will not register as backing → possible FP. The
//   calibration log's hadSameTurnRead field records the determination so the
//   FP rate is reviewable.
//
// @see mt#2486 — this task; mt#2485 — strategic reframe (tier-2)
// @see .claude/hooks/causal-premise-detector.ts — sibling pattern (mt#2216)
// @see .claude/hooks/transcript.ts — shared turn-boundary helper

import { readInput, readHostCap, deriveBudgets } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import {
  parseTranscript,
  extractLastAssistantTurn,
  extractAssistantText,
  type TranscriptLine,
} from "./transcript";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Calibration gate — v1 is log-only, no injection
// ---------------------------------------------------------------------------

/**
 * When false (v1/calibration mode), the hook logs matches to JSONL and injects
 * NO additionalContext. Flip to true only after reviewing the FP rate from the
 * calibration log via the mt#2483 calibration-review sweep.
 */
export const INJECTION_ENABLED = false;

// ---------------------------------------------------------------------------
// Public API: exported constants
// ---------------------------------------------------------------------------

/** Override env var: set to "1"/"true"/"yes" to suppress detection and emit audit. */
export const OVERRIDE_ENV_VAR = "MINSKY_ACK_CODE_MECHANISM_ASSERTION";

const CALIBRATION_LOG = ".minsky/code-mechanism-assertion-calibration.jsonl";

// ---------------------------------------------------------------------------
// Behavioral-predicate patterns — the claim asserts what a symbol DOES
// ---------------------------------------------------------------------------

/**
 * Verbs/phrases asserting a code symbol's runtime behavior. Each is matched in
 * the assistant prose; a symbol-shaped token must sit within
 * SYMBOL_PROXIMITY_CHARS of the match for the pair to count as a claim.
 *
 * The last two patterns (`the <N><unit> default…` and `<noun> is/of/=`) are the
 * highest FP risk: "the default is fine" near an identifier is not a behavioral
 * assertion (PR #1697 R2). They are kept because they catch the R9 canonical
 * phrasing ("the 1MB default maxBuffer"); the SYMBOL_PROXIMITY_CHARS guard plus
 * the calibration-first rollout (INJECTION_ENABLED=false, FP measured via
 * mt#2483) are what keep this acceptable until graduation.
 */
export const PREDICATE_PATTERNS: RegExp[] = [
  /\b(clamps?|caps?|limits?)\b/i,
  /\bdefaults?\s+to\b/i,
  /\b(is|are|was|were)\s+set\s+to\b/i,
  /\b(overrides?|overwrites?|shadows?)\b/i,
  /\b(returns?|yields?|resolves?\s+to)\b/i,
  /\b(throws?|raises?|rejects?|aborts?)\b/i,
  /\b(enforces?|validates?|guards?|requires?)\b/i,
  /\b(ignores?|drops?|swallows?|discards?|skips?)\b/i,
  /\b(truncates?|trims?|strips?)\b/i,
  /\b(falls?\s+back|short[- ]circuits?|no-?ops?)\b/i,
  /\b(retries?|backs?\s+off)\b/i,
  /\bat\s+its\s+limit\b/i,
  /\b(maxes?\s+out|caps?\s+out)\b/i,
  /\bthe\s+\d[\d.,]*\s*(b|kb|mb|gb|ms|s|m|h)\b\s+(default|limit|cap|timeout|buffer|max)/i,
  /\b(default|limit|cap|timeout|buffer|threshold)\s+(is|of|=)\b/i,
];

// ---------------------------------------------------------------------------
// Symbol-token extraction
// ---------------------------------------------------------------------------

const SYMBOL_PROXIMITY_CHARS = 100;

/**
 * Symbol-shaped token forms (high-precision subset — backticked spans plus
 * CamelCase and snake_case identifiers). Dotted prose ("e.g.") is excluded;
 * a dotted symbol only counts when backticked.
 */
const BACKTICK_SYMBOL_RE = /`([A-Za-z_$][\w.$/-]*)`/g;
const CAMEL_CASE_RE = /\b[a-z][a-z0-9]*[A-Z]\w*\b|\b[A-Z][a-z0-9]+[A-Z]\w*\b/g;
const SNAKE_CASE_RE = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/gi;

/**
 * Common camelCase/snake_case tokens that are prose, not code symbols. Keeps
 * the precision high; the calibration log surfaces any that slip through.
 */
const SYMBOL_STOPLIST: ReadonlySet<string> = new Set([
  "javascript",
  "typescript",
  "github",
  "gitlab",
  "postgresql",
  "stdin",
  "stdout",
  "stderr",
]);

function isPlausibleSymbol(tok: string): boolean {
  const t = tok.trim();
  if (t.length < 3) return false;
  if (SYMBOL_STOPLIST.has(t.toLowerCase())) return false;
  if (!/[A-Za-z]/.test(t)) return false;
  return true;
}

/**
 * Collect distinct symbol-shaped tokens within `window` of `anchorIndex`.
 *
 * Backticks are stripped to yield the full token. The dotted-path last-segment
 * fallback was removed (PR #1697 R1): for a file path like `exec.ts` it produced
 * the extension `ts`/`json` as a "symbol", which both inflated claims and
 * spuriously marked claims backed when the extension happened to appear in the
 * corpus. Meaningful sub-identifiers inside a dotted token (e.g. `maxBuffer` in
 * `cfg.maxBuffer`) are still captured independently by CAMEL_CASE_RE/SNAKE_CASE_RE
 * scanning the slice, so no real symbol is lost.
 */
function symbolsNear(text: string, anchorIndex: number, window: number): string[] {
  const start = Math.max(0, anchorIndex - window);
  const end = Math.min(text.length, anchorIndex + window);
  const slice = text.slice(start, end);
  const found = new Set<string>();

  for (const m of slice.matchAll(BACKTICK_SYMBOL_RE)) {
    const raw = m[1] ?? "";
    if (isPlausibleSymbol(raw)) found.add(raw);
  }
  for (const m of slice.matchAll(CAMEL_CASE_RE)) {
    if (isPlausibleSymbol(m[0])) found.add(m[0]);
  }
  for (const m of slice.matchAll(SNAKE_CASE_RE)) {
    if (isPlausibleSymbol(m[0])) found.add(m[0]);
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Markdown elision (fenced blocks + blockquotes; KEEP inline code)
// ---------------------------------------------------------------------------

/**
 * Elide fenced code blocks and blockquotes (pasted output / quotes — not fresh
 * assertions) with same-length whitespace, preserving positions. Unlike the
 * causal-premise detector, inline code spans are KEPT, because a backticked
 * symbol inline (`executeCommand`) is exactly the claim we want to detect.
 */
export function elideBlocksAndQuotes(text: string): string {
  let result = text;
  // Fenced code blocks (``` or ~~~ fences, 3+ markers)
  result = result.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\1[ \t]*$/gm, (m) =>
    " ".repeat(m.length)
  );
  // Blockquote lines (up to 3 leading spaces + one or more > markers)
  result = result.replace(/^[ \t]{0,3}>+.*$/gm, (m) => " ".repeat(m.length));
  return result;
}

// ---------------------------------------------------------------------------
// Same-turn verification corpus (tool inputs + tool_result content)
// ---------------------------------------------------------------------------

/**
 * Read-class tool names whose input paths/patterns count as inspection. Scoped
 * to exactly the spec's normative list (PR #1697 R1): Read / Grep / Glob /
 * session_read_file / repo_read_file / session_grep_search / repo_search. `Bash`,
 * `list_directory`, and a generic `search` suffix were removed — they would mark
 * a claim "backed" off an unrelated shell command or directory listing (silent
 * false negative). Bash-based inspection (grep/cat) still backs a claim via its
 * tool_result CONTENT, which is collected for all read-class results below.
 */
const READ_CLASS_TOOL_RE = /(?:^|_)(?:Read|Grep|Glob)$|(?:read_file|grep_search|repo_search)$/i;

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
  }
}

/**
 * Build the same-turn verification corpus: the concatenation of
 *   - read-class tool_use INPUT strings (file paths, grep patterns, queries), and
 *   - ALL tool_result CONTENT in the turn (so a read of a symbol's file backs a
 *     claim about that symbol — the file source lands in the result).
 *
 * A symbol that appears in this corpus was inspected this turn.
 */
export function buildVerificationCorpus(turnLines: TranscriptLine[]): string {
  const parts: string[] = [];

  for (const line of turnLines) {
    const role = line.message?.role ?? line.type;
    const content = line.message?.content;

    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        // Read-class tool INPUT — authentic tool_use lives on ASSISTANT lines.
        if (role === "assistant" && block["type"] === "tool_use") {
          const name = (block["name"] as string) ?? "";
          if (READ_CLASS_TOOL_RE.test(name)) {
            collectStrings(block["input"], parts);
          }
        }
        // tool_result CONTENT — authentic tool outputs live on USER-role lines
        // (Claude Code records tool_result as user role). Role-gating prevents an
        // assistant-echoed tool_result block from counting as backing (PR #1697 R1).
        if (role === "user" && block["type"] === "tool_result") {
          collectStrings(block["content"], parts);
        }
      }
    }

    // Top-level tool_use line shape (defensive; assistant-side inspection).
    if (line.type === "tool_use") {
      const name = line.name ?? line.tool_name ?? "";
      if (READ_CLASS_TOOL_RE.test(name)) {
        collectStrings(line.input, parts);
      }
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Detection result type
// ---------------------------------------------------------------------------

export interface CodeMechanismDetectionResult {
  matched: boolean;
  /** Distinct unbacked (symbol, predicate) claims, truncated for logging. */
  claims: Array<{ symbol: string; predicate: string }>;
  hadSameTurnRead: boolean;
}

// ---------------------------------------------------------------------------
// Core detector (pure, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Detect code-mechanism assertions whose named symbol was NOT inspected this
 * turn.
 *
 * @param assistantText - concatenated assistant text from the prior turn
 * @param verificationCorpus - same-turn read-class inputs + tool_result content
 */
export function detectCodeMechanismAssertion(
  assistantText: string,
  verificationCorpus: string
): CodeMechanismDetectionResult {
  const empty: CodeMechanismDetectionResult = {
    matched: false,
    claims: [],
    hadSameTurnRead: false,
  };
  if (!assistantText) return empty;

  const prose = elideBlocksAndQuotes(assistantText);
  const corpusLower = verificationCorpus.toLowerCase();
  const symbolBacked = (sym: string): boolean => corpusLower.includes(sym.toLowerCase());

  const claims: Array<{ symbol: string; predicate: string }> = [];
  const seen = new Set<string>();
  let anyBacked = false;

  for (const pattern of PREDICATE_PATTERNS) {
    const globalFlags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const globalPattern = new RegExp(pattern.source, globalFlags);
    for (const m of prose.matchAll(globalPattern)) {
      const idx = m.index ?? 0;
      const symbols = symbolsNear(prose, idx, SYMBOL_PROXIMITY_CHARS);
      for (const sym of symbols) {
        if (symbolBacked(sym)) {
          anyBacked = true;
          continue;
        }
        const key = `${sym}::${m[0].toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        claims.push({ symbol: sym, predicate: m[0].slice(0, 40) });
      }
    }
  }

  return {
    matched: claims.length > 0,
    claims,
    hadSameTurnRead: anyBacked,
  };
}

// ---------------------------------------------------------------------------
// Calibration logging
// ---------------------------------------------------------------------------

function appendCalibrationRecord(cwd: string, record: Record<string, unknown>): void {
  try {
    const logPath = resolve(cwd, CALIBRATION_LOG);
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[code-mechanism-assertion-detector] calibration log write failed: ${msg}\n`
    );
  }
}

// ---------------------------------------------------------------------------
// Injection text (gated by INJECTION_ENABLED)
// ---------------------------------------------------------------------------

function buildInjectionReminder(claims: Array<{ symbol: string; predicate: string }>): string {
  const lines = claims
    .slice(0, 6)
    .map((c) => `  - "${c.symbol}" ${c.predicate}`)
    .join("\n");
  return [
    "[code-mechanism-assertion-detector] Unread code-mechanism claim detected (mt#2486).",
    "",
    "The prior turn asserted what a named code symbol DOES without reading that",
    "symbol this turn (it did not appear in any same-turn tool_result or read-class",
    "tool input):",
    lines,
    "",
    "Required: READ the symbol's source before asserting its behavior. The cheapest",
    "falsifier is one Read/Grep of the file — see /check-premise.",
    "",
    "Family: 3772c77d / b0b294ab. Override: MINSKY_ACK_CODE_MECHANISM_ASSERTION=1.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const capInfo = readHostCap("code-mechanism-assertion-detector.ts", undefined, {
    events: ["UserPromptSubmit"],
  });
  if (capInfo.warning) {
    process.stderr.write(`[code-mechanism-assertion-detector] ${capInfo.warning}\n`);
  }
  const budgets = deriveBudgets(capInfo.hostCapSec);
  const overallDeadline = Date.now() + budgets.overallBudgetMs;

  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";

  let input: ClaudeHookInput;
  try {
    input = await readInput<ClaudeHookInput>();
  } catch {
    process.exit(0);
  }

  if (isOverride) {
    const ts = new Date().toISOString();
    process.stdout.write(
      `[code-mechanism-assertion-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${ts}\n`
    );
    process.exit(0);
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) process.exit(0);

  if (Date.now() >= overallDeadline) {
    process.stderr.write(`[code-mechanism-assertion-detector] budget exhausted — skipping\n`);
    process.exit(0);
  }

  const lines = parseTranscript(transcriptPath);
  if (lines.length === 0) process.exit(0);

  let turnLines: TranscriptLine[];
  try {
    turnLines = extractLastAssistantTurn(lines);
  } catch {
    process.exit(0);
  }
  if (turnLines.length === 0) process.exit(0);

  let result: CodeMechanismDetectionResult;
  try {
    const assistantText = extractAssistantText(turnLines);
    const corpus = buildVerificationCorpus(turnLines);
    result = detectCodeMechanismAssertion(assistantText, corpus);
  } catch (err) {
    console.error(
      `[code-mechanism-assertion-detector] detection error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(0);
  }

  if (!result.matched) process.exit(0);

  if (Date.now() < overallDeadline) {
    appendCalibrationRecord(input.cwd, {
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      claims: result.claims,
      hadSameTurnRead: result.hadSameTurnRead,
    });
  }

  if (!INJECTION_ENABLED) process.exit(0);

  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: buildInjectionReminder(result.claims),
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

if (import.meta.main) {
  main();
}
