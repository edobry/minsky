#!/usr/bin/env bun
// UserPromptSubmit hook: detect when the agent uses verbal commitments or inline
// structure as a bypass of canonical Minsky substrate tooling, and inject a
// system-reminder warning per mt#2020.
//
// Four trigger surfaces:
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
//   4. Passive-outcome-as-mechanism — agent describes a future outcome using
//      passive framing ("happen naturally", "as a side effect", "organically",
//      "over time") near a future-state verb ("will happen", "will be", etc.)
//      WITHOUT naming an actor. The absence of an actor means there is no
//      mechanism — just wishful framing. Originating: mt#2063 / mt#2056.
//
// This is an INFORMATIONAL hook — it injects additionalContext guidance and
// never blocks the user prompt. Fail-open posture throughout.
//
// Originating memory: f6607043-be47-43e6-baec-47dbe40221c4
// Corpus rule: decision-defaults.mdc §Build vs buy
// @see mt#2020 — this task
// @see mt#2652 — ADR-028 Phase 2a: this file's exported `run()` is the
//      dispatcher-compatible entry point invoked in-process by
//      `./dispatch-userpromptsubmit.ts`; the standalone `main()` /
//      `if (import.meta.main)` CLI entrypoint below is unchanged.
// @see .claude/hooks/memory-search.ts — sibling UserPromptSubmit hook (context injection)
// @see .claude/hooks/skill-staleness-detector.ts — sibling UserPromptSubmit hook (staleness)
// @see .claude/hooks/drive-pr-to-convergence.ts — sibling PostToolUse hook (additionalContext pattern)

import { readInput } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import {
  parseTranscript,
  extractLastAssistantTurn,
  extractAssistantText,
  extractToolUseNames,
} from "./transcript";
import type { TranscriptLine } from "./transcript";
import type { DispatchContext, GuardOutcome } from "./registry";

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

/**
 * Passive-outcome phrases that, when combined with a future-state verb (≤300 chars
 * proximity in the same paragraph), indicate the agent is describing a future
 * state without naming an actor, trigger, or execution path.
 *
 * Originating incident: mt#2056 closeout (2026-05-23) — agent answered
 * "it'll happen naturally as a side effect of the next implementer session"
 * with no named actor or mechanism.
 */
export const PASSIVE_OUTCOME_PHRASES: string[] = [
  "happen naturally",
  "natural side effect",
  "as a side effect",
  "organically",
  "over time",
  "eventually",
];

/**
 * Future-state verb phrases that, when co-occurring with a passive-outcome phrase
 * (≤300 chars proximity in the same paragraph), form the detector trigger.
 *
 * Includes both full forms ("will happen") and contraction forms ("'ll happen")
 * to catch common passive constructions like "it'll happen naturally".
 */
export const FUTURE_STATE_VERBS: string[] = [
  "will happen",
  "will be",
  "'ll happen",
  "'ll be",
  "should happen",
  "would happen",
  "is expected to",
];

/**
 * Actor-indicator patterns. When any of these appear in the SAME SENTENCE as the
 * matched passive-outcome + future-state combo, the detector does NOT fire.
 * Named actors imply a real mechanism; actorless passive framing is the failure mode.
 *
 * Deliberately narrow: we only exclude sentences that name a SPECIFIC actor.
 * Generic demonstratives ("this will", "that will") are NOT actors — they're the
 * passive framing we want to catch. Only concrete named subjects block the detector.
 */
export const ACTOR_INDICATORS: RegExp[] = [
  /\bI\s+will\b/i,
  /\bI'll\b/i,
  // "the <noun> will" patterns — specific named mechanism actors
  /\bthe\s+hook\s+will\b/i,
  /\bthe\s+agent\s+will\b/i,
  /\bthe\s+script\s+will\b/i,
  /\bthe\s+task\s+will\b/i,
  /\bthe\s+sweeper\s+will\b/i,
  /\bthe\s+detector\s+will\b/i,
  /\bthe\s+workflow\s+will\b/i,
  /\bthe\s+scheduler\s+will\b/i,
  /\bthe\s+cron\s+will\b/i,
  /\bthe\s+job\s+will\b/i,
  /\bthe\s+pipeline\s+will\b/i,
  // "mt#N will" — task-as-actor
  /\bmt#\d+\s+will\b/i,
  // "<Proper noun> will" — named services/products (e.g., "Railway will", "GitHub will")
  // Use a narrow set of known service names rather than any capitalized word
  /\bRailway\s+will\b/,
  /\bGitHub\s+will\b/,
  /\bGitHub\s+Actions\s+will\b/,
  /\bCloudflare\s+will\b/,
];

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
// Skill-invocation helper (substrate-specific)
// ---------------------------------------------------------------------------

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

/**
 * Detect passive-outcome-as-mechanism: agent describes a future state using passive
 * framing ("happen naturally", "as a side effect", "over time") near a future-state
 * verb ("will happen", "will be", "is expected to") WITHOUT a named actor in the
 * same sentence.
 *
 * The absence of a named actor means there is no mechanism — just wishful description
 * of an outcome. The canonical response is: name the actor, the trigger, and the
 * execution path — or state explicitly that no mechanism exists.
 *
 * Originating incident: mt#2056 closeout (2026-05-23).
 */
export function detectPassiveOutcomeAsMechanism(assistantText: string): DetectionResult {
  if (!assistantText) return { matched: false };

  // Apply markdown-aware filtering to exclude code blocks and blockquotes
  const filteredText = elideMarkdownContexts(assistantText);

  // Split text into paragraphs (blank-line separated) for proximity scoping
  const paragraphs = filteredText.split(/\n\s*\n/);

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) continue;
    const lowerPara = paragraph.toLowerCase();

    // Find each passive-outcome phrase in this paragraph
    for (const passivePhrase of PASSIVE_OUTCOME_PHRASES) {
      const phraseIdx = lowerPara.indexOf(passivePhrase.toLowerCase());
      if (phraseIdx === -1) continue;

      // Check proximity: find a future-state verb within ±300 chars of the passive phrase
      let futureVerbFound = false;
      let matchedVerbPhrase = "";
      for (const futureVerb of FUTURE_STATE_VERBS) {
        const verbIdx = lowerPara.indexOf(futureVerb.toLowerCase());
        if (verbIdx === -1) continue;
        if (Math.abs(verbIdx - phraseIdx) <= 300) {
          futureVerbFound = true;
          matchedVerbPhrase = futureVerb;
          break;
        }
      }

      if (!futureVerbFound) continue;

      // Find the sentence(s) containing the passive phrase
      // Split paragraph into sentences (rough sentence boundary split)
      const sentences = paragraph.split(/(?<=[.!?])\s+|(?<=\n)/);
      let passiveSentence = paragraph; // fallback: whole paragraph as "sentence"
      for (const sentence of sentences) {
        if (sentence.toLowerCase().includes(passivePhrase.toLowerCase())) {
          passiveSentence = sentence;
          break;
        }
      }

      // Check for actor indicators in the same sentence
      const hasActor = ACTOR_INDICATORS.some((actorRe) => actorRe.test(passiveSentence));
      if (hasActor) continue;

      // Match confirmed: passive framing + future-state verb + no named actor
      const snippetStart = Math.max(0, phraseIdx - 20);
      const snippetEnd = Math.min(paragraph.length, phraseIdx + passivePhrase.length + 60);
      const snippet = paragraph.slice(snippetStart, snippetEnd).trim();

      return {
        matched: true,
        matchedPhrase: `"${passivePhrase}" near "${matchedVerbPhrase}" — ${snippet.slice(0, 150)}`,
        canonicalSubstrate:
          'Named actor + trigger + execution path (or explicit: "there is no mechanism")',
        reason: "passive-outcome-as-mechanism",
      };
    }
  }

  return { matched: false };
}

/**
 * Elide markdown contexts that carry textual references rather than coordination
 * instructions (inline code spans, fenced code blocks, blockquotes).
 *
 * The elision replaces matched content with same-length whitespace to preserve
 * character positions for accurate snippet extraction.
 *
 * Reusable by multiple detectors that need markdown-aware filtering.
 */
export function elideMarkdownContexts(text: string): string {
  let result = text;

  // Elide fenced code blocks (``` or ~~~ fences, 3+ markers)
  result = result.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\1[ \t]*$/gm, (m) =>
    " ".repeat(m.length)
  );

  // Elide inline code spans (variable backtick run length)
  result = result.replace(/(`+)([^`]|(?!`)[^`]*?)\1(?!`)/g, (m) => " ".repeat(m.length));

  // Elide blockquote lines (up to 3 leading spaces + one or more > markers)
  result = result.replace(/^[ \t]{0,3}>+.*$/gm, (m) => " ".repeat(m.length));

  return result;
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
    "- For passive-outcome-as-mechanism: state the actor, the trigger, and the",
    '  execution path explicitly. If none exist, say so: "there is no mechanism."',
    '  Passive framing ("it\'ll happen naturally", "over time") is not a mechanism.',
    "  Originating incident: mt#2056 closeout, 2026-05-23.",
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
// Dispatcher-compatible pure function (ADR-028 D1/D2 — mt#2652 Phase 2a)
// ---------------------------------------------------------------------------

/**
 * Guard-dispatcher entry point. Mirrors `main()`'s orchestration but returns
 * a `GuardOutcome` instead of writing to stdout/calling `process.exit` — the
 * dispatcher owns stdout and aggregates every matched guard's output (D1).
 * Reuses `ctx.transcriptLines` (resolved once by the dispatcher's D6 shared
 * context, mt#2637-safe for background-dispatched subagents) instead of
 * re-parsing `input.transcript_path` itself. This guard has no calibration
 * log — additionalContext only, matching `main()`.
 */
export function run(input: ClaudeHookInput, ctx: DispatchContext): GuardOutcome | null {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";

  if (isOverride) {
    return {
      auditLines: [
        `[substrate-bypass-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  if (!input.transcript_path) return null;
  const lines = ctx.transcriptLines;
  if (lines.length === 0) return null;

  let turnLines: TranscriptLine[];
  try {
    turnLines = extractLastAssistantTurn(lines);
  } catch (err) {
    process.stderr.write(
      `[substrate-bypass-detector] Failed to extract assistant turn: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
  if (turnLines.length === 0) return null;

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
    process.stderr.write(
      `[substrate-bypass-detector] Verbal commitment detection error: ${err instanceof Error ? err.message : String(err)}\n`
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
    process.stderr.write(
      `[substrate-bypass-detector] Skill bypass detection error: ${err instanceof Error ? err.message : String(err)}\n`
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
    process.stderr.write(
      `[substrate-bypass-detector] DB substrate bypass detection error: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }

  try {
    const assistantText = extractAssistantText(turnLines);
    const passiveResult = detectPassiveOutcomeAsMechanism(assistantText);
    if (passiveResult.matched && passiveResult.matchedPhrase && passiveResult.canonicalSubstrate) {
      matchedSurfaces.push({
        surface: "passive-outcome-as-mechanism",
        matchedPhrase: passiveResult.matchedPhrase,
        canonicalSubstrate: passiveResult.canonicalSubstrate,
      });
    }
  } catch (err) {
    process.stderr.write(
      `[substrate-bypass-detector] Passive outcome detection error: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }

  if (matchedSurfaces.length === 0) return null;

  return { additionalContext: buildReminder(matchedSurfaces) };
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

  // Run all four detectors
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

  try {
    const assistantText = extractAssistantText(turnLines);
    const passiveResult = detectPassiveOutcomeAsMechanism(assistantText);
    if (passiveResult.matched && passiveResult.matchedPhrase && passiveResult.canonicalSubstrate) {
      matchedSurfaces.push({
        surface: "passive-outcome-as-mechanism",
        matchedPhrase: passiveResult.matchedPhrase,
        canonicalSubstrate: passiveResult.canonicalSubstrate,
      });
    }
  } catch (err) {
    console.error(
      `[substrate-bypass-detector] Passive outcome detection error: ${err instanceof Error ? err.message : String(err)}`
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
