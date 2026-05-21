#!/usr/bin/env bun
// UserPromptSubmit hook: detect when the agent uses verbal commitments or inline
// structure as a bypass of canonical Minsky substrate tooling, and inject a
// system-reminder warning per mt#2020.
//
// Three trigger surfaces:
//   1. Verbal-commitment detection — agent says "I'll update X" / "I should
//      file X" without executing the corresponding canonical tool in the same
//      turn. Canonical substrates: memory_create/memory_update, tasks_create,
//      file-edit tools.
//   2. Skill-bypass detection — agent writes an inline retrospective shape
//      (section headers Acknowledgment + Root cause + Fixes etc.) without
//      invoking the `/retrospective` skill via the `Skill` tool.
//   3. DB-substrate bypass — agent references reading JSONL directly or
//      "extend[ing] the DB later" near the word "transcript", suggesting it's
//      using the file-based transcript log instead of the `agent_transcripts`
//      DB tables.
//
// This is an INFORMATIONAL hook — it injects additionalContext guidance and
// never blocks the user prompt. Fail-open posture throughout.
//
// Originating memory: f6607043-be47-43e6-baec-47dbe40221c4
// Corpus rule: decision-defaults.mdc §Build vs buy
// @see mt#2020 — this task
// @see .claude/hooks/memory-search.ts — sibling UserPromptSubmit hook (context injection)
// @see .claude/hooks/skill-staleness-detector.ts — sibling UserPromptSubmit hook (staleness)
// @see .claude/hooks/drive-pr-to-convergence.ts — sibling PostToolUse hook (additionalContext pattern)

import { readInput } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Public API: exported constants and detection result type
// ---------------------------------------------------------------------------

/** Override env var: set to "1"/"true"/"yes" to suppress detection and emit audit. */
export const OVERRIDE_ENV_VAR = "MINSKY_ACK_SUBSTRATE_BYPASS";

/**
 * First-person future-action phrase patterns that indicate a verbal commitment
 * WITHOUT same-turn execution of the canonical substrate tool.
 *
 * Patterns are case-insensitive. Exported for independent testing.
 */
export const VERBAL_COMMITMENT_PATTERNS: RegExp[] = [
  /\bI'?d\s+update\b/i,
  /\bI\s+will\s+update\b/i,
  /\bI\s+should\s+update\b/i,
  /\bI'?ll\s+save\b/i,
  /\bI'?ll\s+write\b/i,
  /\bI'?d\s+save\b/i,
  /\bgoing\s+forward\s+I('ll|\s+will)\b/i,
  /\bnext\s+session\s+I('ll|\s+will)\b/i,
  /\bI\s+should\s+file\b/i,
  /\bI'?d\s+file\b/i,
];

/**
 * Tool names whose presence in same-turn tool_use lines indicates execution
 * (i.e., the verbal commitment WAS backed by actual tool invocation).
 */
export const EXECUTION_TOOL_NAMES: Set<string> = new Set([
  "mcp__minsky__memory_create",
  "mcp__minsky__memory_update",
  "mcp__minsky__tasks_create",
  "Edit",
  "Write",
  "mcp__minsky__session_edit_file",
  "mcp__minsky__session_write_file",
  "mcp__minsky__session_search_replace",
]);

/**
 * Section-heading markers whose presence in 2+ count in the same turn (at any
 * markdown-heading level) indicates an inline retrospective shape.
 */
export const RETRO_SECTION_MARKERS: string[] = [
  "Acknowledgment",
  "Categorization",
  "Root cause",
  "Root Cause",
  "Fixes",
  "Retrospective:",
];

/**
 * Phrases that, when occurring near the word "transcript" (≤300 chars proximity),
 * indicate the agent is referencing file-based transcript access rather than the
 * `agent_transcripts` DB tables.
 */
export const DB_BYPASS_PHRASES: string[] = [
  "v1 reads JSONL",
  "read JSONL directly",
  "extend the DB later",
  "DB doesn't have",
  "DB is incompatible",
];

// ---------------------------------------------------------------------------
// Transcript JSONL types (minimal subset we use)
// ---------------------------------------------------------------------------

interface TranscriptLine {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  // tool_use lines carry name/input at top level OR inside message.content
  name?: string;
  tool_name?: string;
  input?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Detection result type
// ---------------------------------------------------------------------------

export interface DetectionResult {
  matched: boolean;
  matchedPhrase?: string;
  canonicalSubstrate?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Transcript parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse JSONL transcript file. Returns array of objects, skipping malformed lines.
 * Never throws; returns [] on any read/parse error.
 */
export function parseTranscript(transcriptPath: string): TranscriptLine[] {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }

  const lines = raw.split("\n");
  const result: TranscriptLine[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as TranscriptLine;
      result.push(parsed);
    } catch {
      // skip malformed line, continue
    }
  }
  return result;
}

/**
 * Extract the most-recent assistant turn from a parsed transcript.
 *
 * The "most-recent assistant turn" is all lines after the second-to-last user
 * message, up to (but not including) the current user prompt that fired the hook.
 *
 * A "user message" is a line where `message.role === "user"` or `type === "user"`.
 * Returns [] when there are fewer than 2 user messages (first turn of session,
 * or no prior assistant turn).
 */
export function extractLastAssistantTurn(lines: TranscriptLine[]): TranscriptLine[] {
  // Find all user-message indices
  const userIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.type === "user" || line.message?.role === "user") {
      userIndices.push(i);
    }
  }

  // Need at least 2 user messages to have a prior assistant turn
  if (userIndices.length < 2) {
    return [];
  }

  // The second-to-last user message is at userIndices[userIndices.length - 2]
  const startIdx = (userIndices[userIndices.length - 2] as number) + 1;
  // The last user message is the current user prompt (not included)
  const endIdx = userIndices[userIndices.length - 1] as number;

  return lines.slice(startIdx, endIdx);
}

/**
 * Extract all text content from assistant lines in a turn.
 * Handles both simple string content and content arrays.
 */
function extractAssistantText(turnLines: TranscriptLine[]): string {
  const parts: string[] = [];
  for (const line of turnLines) {
    if (line.type === "assistant" || line.message?.role === "assistant") {
      const content = line.message?.content;
      if (typeof content === "string") {
        parts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object") {
            const b = block as Record<string, unknown>;
            if (b["type"] === "text" && typeof b["text"] === "string") {
              parts.push(b["text"] as string);
            }
          }
        }
      }
    }
  }
  return parts.join("\n");
}

/**
 * Extract all tool_use tool names from a turn. Handles multiple JSONL formats:
 * - Lines where `type === "tool_use"` and `name` is the tool name
 * - Lines where message.content is an array of blocks with type "tool_use"
 */
function extractToolUseNames(turnLines: TranscriptLine[]): string[] {
  const names: string[] = [];
  for (const line of turnLines) {
    // Format 1: top-level tool_use line
    if (line.type === "tool_use") {
      const n = line.name ?? line.tool_name;
      if (n) names.push(n);
    }
    // Format 2: tool_use embedded in message.content array
    if (line.message?.content && Array.isArray(line.message.content)) {
      for (const block of line.message.content as Array<Record<string, unknown>>) {
        if (block["type"] === "tool_use" && typeof block["name"] === "string") {
          names.push(block["name"] as string);
        }
      }
    }
    // Format 3: assistant-type line with content array
    if (line.type === "assistant" && line.message?.content && Array.isArray(line.message.content)) {
      for (const block of line.message.content as Array<Record<string, unknown>>) {
        if (block["type"] === "tool_use" && typeof block["name"] === "string") {
          names.push(block["name"] as string);
        }
      }
    }
  }
  return names;
}

/**
 * Extract Skill tool invocation names from a turn.
 * Looks for tool_use entries where the tool is "Skill" and
 * input.skill contains "retrospective".
 */
function extractSkillToolInvocations(turnLines: TranscriptLine[]): string[] {
  const skillNames: string[] = [];

  const checkBlock = (block: Record<string, unknown>): void => {
    if (block["type"] !== "tool_use") return;
    const name = block["name"] as string | undefined;
    if (name !== "Skill") return;
    const input = block["input"] as Record<string, unknown> | undefined;
    if (!input) return;
    const skill = input["skill"];
    if (typeof skill === "string") {
      skillNames.push(skill);
    }
    // Also handle args stringified
    const args = input["args"];
    if (typeof args === "string" && args.includes("retrospective")) {
      skillNames.push("retrospective");
    }
  };

  for (const line of turnLines) {
    // Top-level tool_use line
    if (line.type === "tool_use" && (line.name === "Skill" || line.tool_name === "Skill")) {
      const input = line.input;
      if (input) {
        const skill = input["skill"];
        if (typeof skill === "string") skillNames.push(skill);
        const args = input["args"];
        if (typeof args === "string" && args.includes("retrospective")) {
          skillNames.push("retrospective");
        }
      }
    }
    // Embedded in message.content
    if (line.message?.content && Array.isArray(line.message.content)) {
      for (const block of line.message.content as Array<Record<string, unknown>>) {
        checkBlock(block);
      }
    }
    // Assistant-type line
    if (line.type === "assistant" && line.message?.content && Array.isArray(line.message.content)) {
      for (const block of line.message.content as Array<Record<string, unknown>>) {
        checkBlock(block);
      }
    }
  }
  return skillNames;
}

// ---------------------------------------------------------------------------
// Detection functions (pure, exported for independent testing)
// ---------------------------------------------------------------------------

/**
 * Detect verbal commitments not backed by same-turn tool execution.
 */
export function detectVerbalCommitment(turnLines: TranscriptLine[]): DetectionResult {
  const text = extractAssistantText(turnLines);
  if (!text) return { matched: false };

  const toolNames = extractToolUseNames(turnLines);
  const hasExecution = toolNames.some((n) => EXECUTION_TOOL_NAMES.has(n));
  if (hasExecution) return { matched: false };

  for (const pattern of VERBAL_COMMITMENT_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      // Determine canonical substrate from phrase shape
      let canonicalSubstrate: string;
      const phrase = match[0].toLowerCase();
      if (phrase.includes("file")) {
        canonicalSubstrate = "mcp__minsky__tasks_create";
      } else if (phrase.includes("save") || phrase.includes("update")) {
        canonicalSubstrate = "mcp__minsky__memory_create or mcp__minsky__memory_update";
      } else if (phrase.includes("write")) {
        canonicalSubstrate = "file-edit tool (Edit / Write / session_edit_file)";
      } else {
        canonicalSubstrate = "mcp__minsky__memory_create / mcp__minsky__tasks_create";
      }

      return {
        matched: true,
        matchedPhrase: match[0].slice(0, 200),
        canonicalSubstrate,
        reason: "verbal-commitment-without-execution",
      };
    }
  }

  return { matched: false };
}

/**
 * Detect inline retrospective shape (2+ section headings) without Skill tool invocation.
 */
export function detectSkillBypass(turnLines: TranscriptLine[]): DetectionResult {
  const text = extractAssistantText(turnLines);
  if (!text) return { matched: false };

  // Count matching section markers (any markdown heading level).
  // Deduplicate by normalized (lowercase) marker so "Root cause" and
  // "Root Cause" don't double-count as two separate hits.
  const matchedNormalized = new Set<string>();
  let firstMatch = "";
  for (const marker of RETRO_SECTION_MARKERS) {
    // Match as markdown heading: # ... marker ... (case-insensitive)
    const re = new RegExp(`^#{1,6}\\s+.*${escapeRegex(marker)}`, "im");
    if (re.test(text)) {
      const key = marker.toLowerCase();
      matchedNormalized.add(key);
      if (!firstMatch) firstMatch = marker;
    }
  }
  const matchCount = matchedNormalized.size;

  if (matchCount < 2) return { matched: false };

  // Check for Skill tool invocation with "retrospective"
  const skillInvocations = extractSkillToolInvocations(turnLines);
  const hasRetroSkill = skillInvocations.some((s) => s.toLowerCase().includes("retrospective"));
  if (hasRetroSkill) return { matched: false };

  return {
    matched: true,
    matchedPhrase: `Inline retro sections detected (${matchCount} markers, first: "${firstMatch}")`,
    canonicalSubstrate: '/retrospective skill (invoke via Skill tool with skill: "retrospective")',
    reason: "skill-bypass-inline-retro",
  };
}

/**
 * Detect DB-substrate bypass: phrases suggesting direct JSONL/file access to
 * transcripts instead of using the agent_transcripts DB tables.
 */
export function detectDbSubstrateBypass(turnLines: TranscriptLine[]): DetectionResult {
  const text = extractAssistantText(turnLines);
  if (!text) return { matched: false };

  const lowerText = text.toLowerCase();

  // Only trigger when "transcript" (word boundary) appears in text
  if (!/\btranscript\b/i.test(text)) return { matched: false };

  for (const phrase of DB_BYPASS_PHRASES) {
    const phraseIdx = lowerText.indexOf(phrase.toLowerCase());
    if (phraseIdx === -1) continue;

    // Check proximity: find "transcript" within ±300 chars of phrase
    const transcriptRe = /\btranscript\b/gi;
    let transcriptMatch: RegExpExecArray | null;
    let found = false;
    while ((transcriptMatch = transcriptRe.exec(text)) !== null) {
      if (Math.abs(transcriptMatch.index - phraseIdx) <= 300) {
        found = true;
        break;
      }
    }

    if (found) {
      const snippet = text.slice(Math.max(0, phraseIdx - 20), phraseIdx + phrase.length + 20);
      return {
        matched: true,
        matchedPhrase: snippet.slice(0, 200),
        canonicalSubstrate: "agent_transcripts / agent_transcript_turns DB tables",
        reason: "db-substrate-bypass",
      };
    }
  }

  return { matched: false };
}

// ---------------------------------------------------------------------------
// Reminder builder
// ---------------------------------------------------------------------------

interface MatchedSurface {
  surface: string;
  matchedPhrase: string;
  canonicalSubstrate: string;
}

function buildReminder(surfaces: MatchedSurface[]): string {
  const surfaceLines = surfaces
    .map(
      (s) =>
        `- **${s.surface}**: matched phrase: "${s.matchedPhrase}" → canonical substrate: \`${s.canonicalSubstrate}\``
    )
    .join("\n");

  return [
    "**Substrate-bypass detected (mt#2020 / substrate-bypass-detector.ts)**",
    "",
    "The previous assistant turn made a verbal commitment or used inline structure",
    "that bypasses a canonical Minsky substrate tool. This is the anti-pattern",
    "tracked in memory f6607043-be47-43e6-baec-47dbe40221c4 and corpus rule",
    "`decision-defaults.mdc §Build vs buy`.",
    "",
    "**Matched surfaces:**",
    surfaceLines,
    "",
    "**Required next action (call the bypassed canonical substrate NOW):**",
    "- For verbal memory commitments: call `mcp__minsky__memory_create` or",
    "  `mcp__minsky__memory_update` with the intended content — do NOT just",
    "  describe the memory you said you'd save.",
    "- For verbal task-filing commitments: call `mcp__minsky__tasks_create`",
    "  — do NOT just describe the task you said you'd file.",
    "- For inline retrospective structure: invoke the `/retrospective` skill",
    '  via the `Skill` tool with `skill: "retrospective"` — inline headers',
    "  are not a substitute for the durable structural-fix discipline.",
    "- For DB-substrate bypass: use the `agent_transcripts` / `agent_transcript_turns`",
    "  DB tables via the MCP tool surface — do NOT read JSONL files directly.",
    "",
    "**Override:** Set `MINSKY_ACK_SUBSTRATE_BYPASS=1` in your environment to",
    "suppress this warning. The override emits an audit line to stdout.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Escape helper
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Main hook function. Exported for testing via Bun.spawn.
 *
 * Reads ClaudeHookInput from stdin, inspects the most-recent assistant turn
 * in the transcript, and emits an additionalContext reminder if any bypass
 * surface is detected.
 *
 * Always exits 0 — fail-open posture.
 */
export async function main(): Promise<void> {
  // Check override env var first
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";

  let input: ClaudeHookInput;
  try {
    input = await readInput<ClaudeHookInput>();
  } catch {
    // Malformed stdin — exit silently
    process.exit(0);
  }

  if (isOverride) {
    const ts = new Date().toISOString();
    // Audit on stdout per spec ("audit logging to stdout (matches sibling-hook
    // convention)"). The line is not valid JSON, so Claude Code's hook output
    // parser will not interpret it as a HookOutput envelope; the standard
    // sibling-hook audit convention (parallel-work-guard, check-branch-fresh)
    // uses stdout for the same purpose.
    process.stdout.write(
      `[substrate-bypass-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${ts}\n`
    );
    process.exit(0);
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) {
    // First turn of session — no prior transcript
    process.exit(0);
  }

  let lines: TranscriptLine[];
  try {
    lines = parseTranscript(transcriptPath);
  } catch (err) {
    console.error(
      `[substrate-bypass-detector] Failed to read transcript: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(0);
  }

  if (lines.length === 0) {
    process.exit(0);
  }

  let turnLines: TranscriptLine[];
  try {
    turnLines = extractLastAssistantTurn(lines);
  } catch (err) {
    console.error(
      `[substrate-bypass-detector] Failed to extract assistant turn: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(0);
  }

  if (turnLines.length === 0) {
    // No prior assistant turn (first turn of session)
    process.exit(0);
  }

  // Run all three detectors
  const matchedSurfaces: MatchedSurface[] = [];

  try {
    const verbalResult = detectVerbalCommitment(turnLines);
    if (verbalResult.matched && verbalResult.matchedPhrase && verbalResult.canonicalSubstrate) {
      matchedSurfaces.push({
        surface: "verbal-commitment",
        matchedPhrase: verbalResult.matchedPhrase,
        canonicalSubstrate: verbalResult.canonicalSubstrate,
      });
    }
  } catch (err) {
    console.error(
      `[substrate-bypass-detector] Verbal commitment detection error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    const skillResult = detectSkillBypass(turnLines);
    if (skillResult.matched && skillResult.matchedPhrase && skillResult.canonicalSubstrate) {
      matchedSurfaces.push({
        surface: "skill-bypass",
        matchedPhrase: skillResult.matchedPhrase,
        canonicalSubstrate: skillResult.canonicalSubstrate,
      });
    }
  } catch (err) {
    console.error(
      `[substrate-bypass-detector] Skill bypass detection error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    const dbResult = detectDbSubstrateBypass(turnLines);
    if (dbResult.matched && dbResult.matchedPhrase && dbResult.canonicalSubstrate) {
      matchedSurfaces.push({
        surface: "db-substrate-bypass",
        matchedPhrase: dbResult.matchedPhrase,
        canonicalSubstrate: dbResult.canonicalSubstrate,
      });
    }
  } catch (err) {
    console.error(
      `[substrate-bypass-detector] DB substrate bypass detection error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (matchedSurfaces.length === 0) {
    process.exit(0);
  }

  const reminder = buildReminder(matchedSurfaces);
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
