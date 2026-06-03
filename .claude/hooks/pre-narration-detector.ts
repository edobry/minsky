#!/usr/bin/env bun
// UserPromptSubmit hook: detect pre-narrated / fabricated tool outcomes in the
// just-completed assistant turn, and inject a system-reminder warning per mt#2197.
//
// The failure (memory 30f5d164, R2/R3): an agent described a concrete tool
// outcome -- a created PR number, a reviewer approval, a merge, a clean build --
// BEFORE the result was in hand, in chat or in durable artifacts. Memory- and
// rule-tier capture did not prevent same-session recurrence, so this is the
// hook-tier detector (per work-completion.mdc Process corrections require
// structural fixes).
//
// Mechanism (modelled on substrate-bypass-detector.ts verbal-commitment
// detection): a claim asserting a concrete outcome appears in the assistant's
// prose, but NO matching tool_use for that outcome exists in the same turn. The
// discriminator between intent ("I'll create the PR") and false completion
// ("created PR #123") is tense + a concrete identifier (PR number, review
// state) -- the claim patterns below match only completion-shaped assertions,
// so future-tense intent does not trip them.
//
// INFORMATIONAL ONLY: always exits 0, never blocks the prompt (fail-open). Each
// fire is written to a calibration JSONL log so the false-positive rate can be
// measured before any blocking behavior is enabled.
//
// Originating memory: 30f5d164-0512-45d1-b473-2aa5323221aa
// @see mt#2197 -- this task
// @see mt#2199 -- always-injected root rule (one pipeline step per turn)
// @see mt#2195 -- sibling guessed-session-path guard hook
// @see .claude/hooks/substrate-bypass-detector.ts -- architectural template
// @see .claude/hooks/retrospective-trigger-scanner.ts -- calibration-log pattern
//
// Turn boundaries (mt#2255): "the just-completed turn" is the span between the
// last two REAL user prompts, via the shared ./transcript helper. Claude Code
// records tool_result lines as user-role messages; the helper discriminates a
// real prompt (text content) from a tool_result line (content array of only
// tool_result blocks), so a turn spanning several tool round-trips is NOT split
// — the minting tool in an earlier segment is in scope for a claim in a later
// one (this fixed the 2026-06-01 end-of-work-summary false positive).

import { readInput } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import {
  parseTranscript,
  extractLastAssistantTurn,
  extractAssistantText,
  extractToolUseNames,
} from "./transcript";
import type { TranscriptLine } from "./transcript";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Public API: exported constants
// ---------------------------------------------------------------------------

/** Override env var: set to "1"/"true"/"yes" to suppress detection and emit audit. */
export const OVERRIDE_ENV_VAR = "MINSKY_ACK_PRE_NARRATION";

/** Calibration log path (relative to cwd), sibling to retrospective-trigger-calibration.jsonl. */
const CALIBRATION_LOG = ".minsky/pre-narration-calibration.jsonl";

// ---------------------------------------------------------------------------
// Outcome-claim categories
//
// Each category pairs completion-shaped claim patterns with the set of tool
// names whose presence in the same turn proves the claim was backed by an
// actual tool invocation. A category fires only when a claim pattern matches
// AND none of its requiredTools appear in the turn's tool_use names.
// ---------------------------------------------------------------------------

export interface OutcomeCategory {
  key: string;
  /** Completion-shaped claim patterns (case-insensitive where flagged). */
  patterns: RegExp[];
  /** Tool names that, if present in the same turn, prove the claim. */
  requiredTools: string[];
  /** Human-readable description of the tool the claim needed. */
  expectedTool: string;
}

export const OUTCOME_CATEGORIES: OutcomeCategory[] = [
  {
    key: "pr-created",
    patterns: [
      /\b(created|opened|raised|submitted)\s+(the\s+|a\s+)?PR\b/i,
      /\bPR\s+#?\d+\s+(has\s+been\s+|is\s+|was\s+)?(created|opened|up|ready|live)\b/i,
      /\bPR\s+(has\s+been\s+|was\s+)?(created|opened)\b/i,
      /\bopened\s+pull\s+request\b/i,
    ],
    requiredTools: [
      "mcp__minsky__session_pr_create",
      "session_pr_create",
      "mcp__github__create_pull_request",
      "create_pull_request",
    ],
    expectedTool: "session_pr_create / create_pull_request",
  },
  {
    key: "review-approved",
    patterns: [
      /\bbot\s+approved\b/i,
      /\breviewer\s+approved\b/i,
      /\breview\s+(came\s+back|returned|landed)\b/i,
      /\bAPPROVED\b/, // uppercase review-state token only; lowercase "approved" is too generic
      /\bCHANGES_REQUESTED\b/,
      /\breview\s+is\s+(in|back|complete)\b/i,
    ],
    requiredTools: [
      "mcp__minsky__session_pr_wait-for-review",
      "session_pr_wait-for-review",
      "mcp__github__pull_request_read",
      "pull_request_read",
      "get_reviews",
    ],
    expectedTool: "session_pr_wait-for-review / pull_request_read",
  },
  {
    key: "merged",
    patterns: [
      /\bPR\s+#?\d+\s+(has\s+been\s+|is\s+|was\s+)?(now\s+)?merged\b/i,
      /\b(successfully\s+)?merged\s+(the\s+|this\s+)?PR\b/i,
      /\bmerge\s+(succeeded|completed?|is\s+done)\b/i,
      /\bnow\s+merged\b/i,
    ],
    requiredTools: [
      "mcp__minsky__session_pr_merge",
      "session_pr_merge",
      "mcp__github__merge_pull_request",
      "merge_pull_request",
    ],
    expectedTool: "session_pr_merge / merge_pull_request",
  },
  {
    key: "build-test",
    patterns: [
      /\bbuilt\s+clean\b/i,
      /\bbuild\s+(succeeded|passed|is\s+green|is\s+clean)\b/i,
      /\btests?\s+pass(ed)?\b/i,
      /\ball\s+tests\s+(pass|green)\b/i,
      /\b(returned|got|responded|responds)\s+(with\s+)?(HTTP\s+)?200\b/i,
      /\b200\s+OK\b/,
    ],
    requiredTools: [
      "Bash",
      "mcp__minsky__session_exec",
      "mcp__minsky__validate_typecheck",
      "mcp__minsky__validate_lint",
      "session_exec",
    ],
    expectedTool: "Bash / session_exec / validate_*",
  },
];

// ---------------------------------------------------------------------------
// Detection result type
// ---------------------------------------------------------------------------

export interface ClaimMatch {
  category: string;
  matchedPhrase: string;
  expectedTool: string;
}

/**
 * Elide markdown contexts that carry quoted text rather than the agent's own
 * assertions (inline code spans, fenced code blocks, blockquotes). Replaces
 * matched content with same-length whitespace to preserve character positions.
 * This avoids firing on quoted tool output the agent pasted (e.g. "200 OK"
 * inside a code fence).
 */
export function elideMarkdownContexts(text: string): string {
  let result = text;
  result = result.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\1[ \t]*$/gm, (m) =>
    " ".repeat(m.length)
  );
  result = result.replace(/(`+)([^`]|(?!`)[^`]*?)\1(?!`)/g, (m) => " ".repeat(m.length));
  result = result.replace(/^[ \t]{0,3}>+.*$/gm, (m) => " ".repeat(m.length));
  return result;
}

// ---------------------------------------------------------------------------
// Detection (pure, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Detect pre-narrated tool outcomes in an assistant turn.
 *
 * For each outcome category, if a completion-shaped claim pattern matches the
 * assistant prose AND none of the category's requiredTools appear in the turn's
 * tool_use names, the category fires. Quoted/code-span text is elided first to
 * reduce false positives on pasted tool output.
 *
 * Returns one ClaimMatch per fired category (deduplicated by category).
 */
export function detectPreNarration(turnLines: TranscriptLine[]): ClaimMatch[] {
  const rawText = extractAssistantText(turnLines);
  if (!rawText) return [];

  const text = elideMarkdownContexts(rawText);
  const toolNames = new Set(extractToolUseNames(turnLines));

  const matches: ClaimMatch[] = [];
  for (const category of OUTCOME_CATEGORIES) {
    const hasRequiredTool = category.requiredTools.some((t) => toolNames.has(t));
    if (hasRequiredTool) continue; // claim was backed by a real tool call

    for (const pattern of category.patterns) {
      const m = pattern.exec(text);
      if (m) {
        matches.push({
          category: category.key,
          matchedPhrase: m[0].slice(0, 200),
          expectedTool: category.expectedTool,
        });
        break; // one match per category is enough
      }
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Calibration logging (mirrors retrospective-trigger-scanner.ts)
// ---------------------------------------------------------------------------

function appendCalibrationRecord(cwd: string, record: Record<string, unknown>): void {
  try {
    const logPath = resolve(cwd, CALIBRATION_LOG);
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[pre-narration-detector] Failed to write calibration log: ${msg}\n`);
  }
}

// ---------------------------------------------------------------------------
// Reminder builder
// ---------------------------------------------------------------------------

function buildReminder(matches: ClaimMatch[]): string {
  const lines = matches
    .map(
      (m) =>
        `- **${m.category}**: claim "${m.matchedPhrase}" with no matching tool result this turn (expected: \`${m.expectedTool}\`)`
    )
    .join("\n");

  return [
    "**Possible pre-narrated / fabricated tool outcome (mt#2197 / pre-narration-detector.ts)**",
    "",
    "The previous assistant turn asserted a concrete tool outcome, but no matching",
    "tool call for that outcome appears in the same turn. This is the anti-pattern",
    "in memory 30f5d164: narrating a result (PR created, review approved, merged,",
    "build clean, HTTP 200) before the result is in hand.",
    "",
    "**Matched claims:**",
    lines,
    "",
    "**Required next action:** before restating any of these outcomes, run the",
    "minting tool and READ its real result this turn. Never state an outcome",
    "(created / approved / merged / built clean / tests pass / HTTP status) in chat",
    "OR in durable artifacts before the tool result is in hand. If the outcome did",
    "occur in an earlier turn, cite the tool result you are relying on.",
    "",
    "This is an informational signal (calibration phase) — it does not block the",
    "turn. If the claim was legitimate (the tool ran in an earlier turn, or the",
    "phrase was a quote/example), set `MINSKY_ACK_PRE_NARRATION=1` to suppress.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

/**
 * Main hook function. Reads ClaudeHookInput from stdin, inspects the just-completed
 * assistant turn, and emits an additionalContext reminder when a pre-narrated
 * outcome is detected. Always exits 0 (fail-open, informational only).
 */
export async function main(): Promise<void> {
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
      `[pre-narration-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${ts}\n`
    );
    process.exit(0);
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) {
    process.exit(0);
  }

  let lines: TranscriptLine[];
  try {
    lines = parseTranscript(transcriptPath);
  } catch (err) {
    console.error(
      `[pre-narration-detector] Failed to read transcript: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(0);
  }

  if (lines.length === 0) {
    process.exit(0);
  }

  let matches: ClaimMatch[];
  try {
    const turnLines = extractLastAssistantTurn(lines);
    if (turnLines.length === 0) {
      process.exit(0);
    }
    matches = detectPreNarration(turnLines);
  } catch (err) {
    console.error(
      `[pre-narration-detector] Detection error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(0);
  }

  if (matches.length === 0) {
    process.exit(0);
  }

  appendCalibrationRecord(input.cwd, {
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    matches: matches.map((m) => ({
      category: m.category,
      phrase: m.matchedPhrase,
      expectedTool: m.expectedTool,
      hadMatchingTool: false,
    })),
  });

  const reminder = buildReminder(matches);
  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: reminder,
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

if (import.meta.main) {
  main();
}
