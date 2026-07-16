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

import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
  /**
   * ISO-8601 wall-clock timestamp Claude Code stamps on every transcript
   * line (user/assistant/tool_result alike). Optional here because not
   * every caller-constructed synthetic TranscriptLine in tests sets it, but
   * real on-disk transcripts always carry it. Added for mt#2824 (silent-
   * stretch detector) — the first consumer that needs wall-clock gap
   * measurement rather than just line-order/content.
   */
  timestamp?: string;
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
// Transcript-candidate resolution (subagent-aware, mt#2637)
// ---------------------------------------------------------------------------

/**
 * Resolve the ordered list of transcript files that may record the ACTIVE
 * agent's tool calls, from the hook-input `transcript_path` and (for subagent
 * calls) `agent_id`.
 *
 * Background-Agent-dispatched subagents receive a `transcript_path` pointing
 * at the PARENT session's top-level `<session-id>.jsonl`, while their own
 * tool_use lines are recorded at
 * `<dir>/<session-id>/subagents/agent-<agentId>.jsonl` (mt#2637 — confirmed
 * by natural experiment across the mt#2607 burndown waves). The upstream
 * hooks reference documents `agent_id` ("present only when the hook fires
 * inside a subagent call") but is silent on per-agent transcript_path
 * semantics, so hooks must resolve the candidates themselves.
 *
 * Candidates, in scan order:
 *   1. the given `transcript_path` — main-thread behavior, and also covers
 *      the orchestrator-pre-read pattern (the PARENT surfaced the content);
 *   2. when the given path is itself a per-agent file, the PARENT session's
 *      top-level transcript (tree semantics in the other direction);
 *   3. when `agentId` is provided, the precise per-agent file;
 *   4. every sibling `agent-*.jsonl` under the session's `subagents/` dir —
 *      a fallback that does not depend on the (undocumented) correspondence
 *      between the hook-input agent_id and the on-disk filename id. The
 *      session is treated as one conversation TREE: content surfaced by the
 *      parent or any dispatched agent counts for the whole tree.
 *
 * Nonexistent candidates are harmless — {@link parseTranscript} returns []
 * on any read error. Never throws.
 */
export function resolveTranscriptCandidates(transcriptPath: string, agentId?: string): string[] {
  const candidates: string[] = [transcriptPath];
  if (!transcriptPath.endsWith(".jsonl")) return candidates;

  const pushUnique = (p: string): void => {
    if (!candidates.includes(p)) candidates.push(p);
  };

  // Derive the session's subagents/ dir from either input shape:
  //   - top-level `<dir>/<session-id>.jsonl` (main thread; also what
  //     background subagents currently receive) -> `<dir>/<session-id>/subagents`
  //   - already a per-agent file `<dir>/<session-id>/subagents/agent-<id>.jsonl`
  //     -> its own directory; also add the parent `<dir>/<session-id>.jsonl`
  let subagentsDir: string;
  const base = basename(transcriptPath);
  if (base.startsWith("agent-") && basename(dirname(transcriptPath)) === "subagents") {
    subagentsDir = dirname(transcriptPath);
    pushUnique(`${dirname(subagentsDir)}.jsonl`); // parent session transcript
  } else {
    subagentsDir = join(transcriptPath.slice(0, -".jsonl".length), "subagents");
  }

  if (agentId) {
    pushUnique(join(subagentsDir, `agent-${agentId}.jsonl`));
  }

  try {
    for (const entry of readdirSync(subagentsDir)) {
      if (!entry.startsWith("agent-") || !entry.endsWith(".jsonl")) continue;
      pushUnique(join(subagentsDir, entry));
    }
  } catch {
    // no subagents dir — a session with no background dispatches
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Real-user-prompt discriminator
// ---------------------------------------------------------------------------

function isUserRole(line: TranscriptLine): boolean {
  return line.type === "user" || line.message?.role === "user";
}

/**
 * Claude Code-synthesized markers recorded with `role: "user"` and a single
 * `{ type: "text" }` content block that are NOT actual human input — they
 * mark a harness-internal event (the user cancelled an in-flight tool call).
 * Excluded from {@link isRealUserPrompt} so they don't spuriously reset a
 * turn boundary at the exact instant of interruption.
 *
 * Discovered (mt#2824) while replaying the two originating silent-stretch
 * incident transcripts: in both, this exact marker landed ~20ms before the
 * operator's actual complaint message. Naively treating it as a real prompt
 * boundary collapsed the measured "turn" down to those 20ms — hiding the
 * real ~24/28-minute silent stretch that precedes it, which is exactly the
 * signal the silent-stretch detector needs to see. Confirmed exhaustive
 * (only two literal variants found) via a corpus scan across ~300 local
 * transcript files.
 */
const SYNTHETIC_INTERRUPT_MARKERS: ReadonlySet<string> = new Set([
  "[Request interrupted by user for tool use]",
  "[Request interrupted by user]",
]);

function isRealTextBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const b = block as Record<string, unknown>;
  if (b["type"] !== "text") return false;
  const text = typeof b["text"] === "string" ? b["text"].trim() : undefined;
  if (text !== undefined && SYNTHETIC_INTERRUPT_MARKERS.has(text)) return false;
  return true;
}

/**
 * True iff `line` is a REAL user prompt (text from the human), as opposed to a
 * `tool_result` line that Claude Code also records with user role, or a
 * {@link SYNTHETIC_INTERRUPT_MARKERS} harness-internal marker.
 *
 * A real prompt carries text content:
 *   - `message.content` is a STRING (always — even empty/whitespace; a
 *     string-content user line is never a `tool_result`, which is always an
 *     array, so it is a genuine human boundary), OR
 *   - `message.content` is an array containing at least one `{ type: "text" }`
 *     block whose text is not a synthetic interrupt marker.
 *
 * A tool_result line is a user-role content array whose blocks are all
 * `tool_result` (no `text` block) — it returns false here. A
 * synthetic-interrupt-marker-only line is likewise excluded.
 */
export function isRealUserPrompt(line: TranscriptLine): boolean {
  if (!isUserRole(line)) return false;
  const content = line.message?.content;
  // String content is always a real prompt: tool_result lines are always
  // content ARRAYS, so a string-content user line is unambiguously human input
  // (an empty/whitespace prompt still resets the turn boundary, matching the
  // prior user-role-split behavior — review NON-BLOCKING, mt#2255). The
  // synthetic interrupt markers are only ever observed in array content-block
  // form (confirmed by corpus scan, mt#2824), so the string branch needs no
  // exclusion check.
  if (typeof content === "string") return true;
  if (Array.isArray(content)) {
    return content.some(isRealTextBlock);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Turn extraction
// ---------------------------------------------------------------------------

/**
 * Return the transcript-line index of every REAL user prompt, in order.
 *
 * Factored out of {@link extractLastAssistantTurn} (mt#2824) so callers that
 * need the boundary LINES themselves — not just the turn slice between them
 * — can locate them without re-implementing the real-prompt scan. The
 * silent-stretch detector is the first such consumer: it needs the previous
 * and current prompts' `timestamp` fields to measure wall-clock silence,
 * which `extractLastAssistantTurn`'s turn-slice return value (exclusive of
 * both boundary lines) does not expose.
 */
export function findRealPromptIndices(lines: TranscriptLine[]): number[] {
  const promptIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (isRealUserPrompt(line)) promptIndices.push(i);
  }
  return promptIndices;
}

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
  const promptIndices = findRealPromptIndices(lines);

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
 * Extract the `input` object of every `tool_use` block whose name equals
 * `toolName`. Unlike {@link extractToolUseNames} (turn-scoped name list), this
 * is meant to run over the FULL `parseTranscript()` output to answer "did tool
 * X ever run this session, and with what args?" — so it deliberately does NOT
 * turn-bound, sidestepping the role=user tool_result turn-boundary hazard
 * (mt#2255 / memory a3e60471: tool_result lines are user-role, so a turn slice
 * built on user-role boundaries silently drops earlier tool calls).
 *
 * Handles both transcript shapes, mirroring {@link extractToolUseNames}:
 *   - a top-level line with `type === "tool_use"`, `name`/`tool_name`, `input`
 *   - an assistant line whose `message.content` array contains
 *     `{ type: "tool_use", name, input }` blocks
 *
 * A tool_use with no object `input` contributes `{}` so callers can still count
 * the call; callers read individual fields defensively.
 */
export function findToolUseInputs(
  lines: TranscriptLine[],
  toolName: string
): Array<Record<string, unknown>> {
  const inputs: Array<Record<string, unknown>> = [];
  const pushInput = (raw: unknown): void => {
    inputs.push(raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {});
  };
  for (const line of lines) {
    if (line.type === "tool_use") {
      const n = line.name ?? line.tool_name;
      if (n === toolName) pushInput(line.input);
    }
    const content = line.message?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block && block["type"] === "tool_use" && block["name"] === toolName) {
          pushInput(block["input"]);
        }
      }
    }
  }
  return inputs;
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
