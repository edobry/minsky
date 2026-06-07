// Shared turn-extraction helpers for UserPromptSubmit detector hooks.
//
// Claude Code records `tool_result` blocks as USER-ROLE transcript lines. A
// naive "last assistant turn" that keys on every user-role line therefore
// SPLITS any turn that spans multiple tool round-trips at each tool_result,
// leaving only the trailing assistant segment after the final tool_result.
// That both false-positives (a completion claim in a later segment whose
// minting tool ran in an earlier segment looks tool-less — mt#2197) and
// under-detects (a trigger phrase in a non-final assistant segment is never
// scanned — substrate-bypass / retrospective scanners).
//
// The fix: bound the "just-completed turn" on REAL USER PROMPTS, not on every
// user-role line. A real prompt carries text content (a string, or a content
// array containing a `text` block); a tool_result line is a user-role content
// array of only `tool_result` blocks. Keying on real prompts makes the span
// from the prior real prompt through ALL interleaved assistant + tool_result
// lines — a full logical turn.
//
// This module is the single definition of the turn-boundary logic. The three
// detector hooks (substrate-bypass-detector, retrospective-trigger-scanner,
// pre-narration-detector) and their tests import from here.
//
// @see mt#2255 — this task
// @see .claude/hooks/types.ts — sibling cross-hook util home (readInput, readHostCap, deriveBudgets)

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Transcript JSONL types (minimal subset the detectors use)
// ---------------------------------------------------------------------------

export interface TranscriptLine {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  // tool_use lines may carry name/input at top level OR inside message.content
  name?: string;
  tool_name?: string;
  input?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a JSONL transcript file. Returns one object per non-blank line,
 * skipping malformed lines. Never throws — returns [] on any read error.
 */
export function parseTranscript(transcriptPath: string): TranscriptLine[] {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }

  const result: TranscriptLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      result.push(JSON.parse(trimmed) as TranscriptLine);
    } catch {
      // skip malformed line, continue
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Real-user-prompt discriminator
// ---------------------------------------------------------------------------

function isUserRole(line: TranscriptLine): boolean {
  return line.type === "user" || line.message?.role === "user";
}

/**
 * True iff `line` is a REAL user prompt (text from the human), as opposed to a
 * `tool_result` line that Claude Code also records with user role.
 *
 * A real prompt carries text content:
 *   - `message.content` is a STRING (always — even empty/whitespace; a
 *     string-content user line is never a `tool_result`, which is always an
 *     array, so it is a genuine human boundary), OR
 *   - `message.content` is an array containing at least one `{ type: "text" }`
 *     block.
 *
 * A tool_result line is a user-role content array whose blocks are all
 * `tool_result` (no `text` block) — it returns false here.
 */
export function isRealUserPrompt(line: TranscriptLine): boolean {
  if (!isUserRole(line)) return false;
  const content = line.message?.content;
  // String content is always a real prompt: tool_result lines are always
  // content ARRAYS, so a string-content user line is unambiguously human input
  // (an empty/whitespace prompt still resets the turn boundary, matching the
  // prior user-role-split behavior — review NON-BLOCKING, mt#2255).
  if (typeof content === "string") return true;
  if (Array.isArray(content)) {
    return content.some(
      (block) =>
        !!block &&
        typeof block === "object" &&
        (block as Record<string, unknown>)["type"] === "text"
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Turn extraction
// ---------------------------------------------------------------------------

/**
 * Extract the just-completed logical turn: every line between the
 * second-to-last and the last REAL user prompt (the last real prompt is the
 * current prompt that fired the hook and is excluded).
 *
 * Because the bounds are real prompts (not every user-role line), interleaved
 * `tool_result` user-role lines fall INSIDE the returned span rather than
 * splitting it. The result therefore covers all assistant segments AND all
 * tool_result lines of the turn — a full multi-round turn.
 *
 * Returns [] when there are fewer than 2 real user prompts (first turn of a
 * session, or no prior assistant turn).
 */
export function extractLastAssistantTurn(lines: TranscriptLine[]): TranscriptLine[] {
  const promptIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (isRealUserPrompt(line)) promptIndices.push(i);
  }

  if (promptIndices.length < 2) return [];

  const startIdx = (promptIndices[promptIndices.length - 2] as number) + 1;
  const endIdx = promptIndices[promptIndices.length - 1] as number;
  return lines.slice(startIdx, endIdx);
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

function textFromContent(content: unknown): string[] {
  const parts: string[] = [];
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
  return parts;
}

/**
 * Concatenate all assistant text from a turn's lines (string content and
 * `text` blocks in content arrays). Non-assistant lines are ignored.
 */
export function extractAssistantText(turnLines: TranscriptLine[]): string {
  const parts: string[] = [];
  for (const line of turnLines) {
    if (line.type === "assistant" || line.message?.role === "assistant") {
      parts.push(...textFromContent(line.message?.content));
    }
  }
  return parts.join("\n");
}

/**
 * Extract every `tool_use` tool name from a turn. Handles both shapes:
 *   - a top-level line with `type === "tool_use"` and `name`/`tool_name`
 *   - a line whose `message.content` array contains `{ type: "tool_use",
 *     name }` blocks (the assistant-line shape)
 *
 * Single pass — a name may appear more than once if duplicated in the
 * transcript; callers that need uniqueness wrap the result in a Set.
 */
export function extractToolUseNames(turnLines: TranscriptLine[]): string[] {
  const names: string[] = [];
  for (const line of turnLines) {
    if (line.type === "tool_use") {
      const n = line.name ?? line.tool_name;
      if (n) names.push(n);
    }
    if (line.message?.content && Array.isArray(line.message.content)) {
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
 * Extract the text of the most-recent REAL user prompt (the current prompt
 * that fired the hook). Skips trailing `tool_result` user-role lines so it
 * never returns tool-result content as if it were the user's message.
 *
 * Returns "" when there is no real user prompt in the transcript.
 */
export function extractLastUserMessage(lines: TranscriptLine[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    if (isRealUserPrompt(line)) {
      return textFromContent(line.message?.content).join("\n");
    }
  }
  return "";
}
