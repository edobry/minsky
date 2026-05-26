#!/usr/bin/env bun
// UserPromptSubmit hook: detect retrospective-trigger phrases in the prior
// assistant turn and user-correction signals in the current user prompt.
// Injects additionalContext reminding the agent to invoke /retrospective.
// Advisory-only — never blocks the prompt. Per mt#2057.
//
// Four trigger families (R1-R4) covering the rationalize-away-from-structural-fix
// pattern that recurred across 2026-05-18 to 2026-05-23:
//   R1: apology / contrition ("I owe you an apology", "I should have caught")
//   R2: operational explanatory prose ("I didn't think it through")
//   R3: future-behavior commitments ("going forward I will X")
//   R4: decline-to-retrospective ("no need for a full retrospective")
//
// Plus user-correction signals in the current prompt ("why did you do that?").
//
// @see .claude/hooks/substrate-bypass-detector.ts — sibling UserPromptSubmit hook
// @see .claude/skills/retrospective/SKILL.md — canonical trigger lists
// @see feedback_self_recognized_failure_is_retrospective_trigger (id 1b36a19e)
// @see feedback_decline_to_retrospective_is_itself_a_trigger (id 13ccf86e)

import { readInput } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Public API: exported constants
// ---------------------------------------------------------------------------

export const OVERRIDE_ENV_VAR = "MINSKY_ACK_RETROSPECTIVE_TRIGGER";

const CALIBRATION_LOG = ".minsky/retrospective-trigger-calibration.jsonl";

// ---------------------------------------------------------------------------
// Trigger family types
// ---------------------------------------------------------------------------

export type TriggerFamily = "R1" | "R2" | "R3" | "R4" | "R5" | "user-correction";

export interface TriggerMatch {
  family: TriggerFamily;
  matchedPhrase: string;
}

// ---------------------------------------------------------------------------
// R1: Apology / contrition patterns
// ---------------------------------------------------------------------------

export const R1_PATTERNS: RegExp[] = [
  /\bI\s+owe\s+you\s+an?\s+apolog/i,
  /\bI\s+apologize\s+for\b/i,
  /\bI\s+was\s+wrong\s+about\b/i,
  /\bmy\s+recommendation\s+was\s+incorrect\b/i,
  /\bI\s+should\s+have\s+caught\b/i,
  /\bI\s+should\s+have\s+known\s+better\b/i,
  /\bI\s+should\s+have\s+thought\s+of\b/i,
  /\bthat\s+was\s+my\s+fault\b/i,
  /\bI\s+made\s+a\s+mistake\b/i,
  /\bI\s+missed\s+the\s+obvious\b/i,
  /\bI\s+anchored\s+on\b[^.]*\band\s+missed\b/i,
  /\bI\s+conflated\b/i,
];

// ---------------------------------------------------------------------------
// R2: Operational / explanatory prose
// ---------------------------------------------------------------------------

export const R2_PATTERNS: RegExp[] = [
  /\bI\s+didn[''’]?t\s+think\s+(it\s+)?through\b/i,
  /\bI\s+went\s+straight\s+to\b[^.]*\bwithout\s+check/i,
  /\bI\s+defaulted\s+to\b[^.]*\bdidn[''’]?t\s+pause\b/i,
  /\bI\s+didn[''’]?t\s+pause\s+to\s+consider\b/i,
];

// ---------------------------------------------------------------------------
// R3: Future-behavior commitments (without durable encoding)
// ---------------------------------------------------------------------------

export const R3_PATTERNS: RegExp[] = [
  /\bgoing\s+forward\s+I[''’]?(ll|\s+will)\b/i,
  /\bfrom\s+now\s+on\s+I[''’]?(ll|\s+will)\b/i,
  /\bnext\s+time\s+I[''’]?(ll|\s+will)\b/i,
  /\bfuture\s+me\s+will\b/i,
  /\bI[''’]?(ll|\s+will)\s+be\s+more\s+careful\s+about\b/i,
];

// ---------------------------------------------------------------------------
// R4: Decline-to-retrospective
// ---------------------------------------------------------------------------

export const R4_PATTERNS: RegExp[] = [
  /\bfixing\s+the\s+symptom\b[^.]*\brather\s+than\b[^.]*\bretrospective\b/i,
  /\bone[- ]off\s+(issue|mistake|failure|staleness|error)\b/i,
  /\bno\s+need\s+for\s+a\s+(full\s+)?retrospective\b/i,
  /\bskip\b[^.]*\bretrospective\b/i,
  /\bdoesn[''’]?t\s+warrant\s+a\s+(full\s+|proper\s+)?retrospective\b/i,
  /\bminor\s+enough\s+to\s+skip\b/i,
];

// ---------------------------------------------------------------------------
// R5: Finding-reframing — agent describes a finding that implies its own
// prior action was wrong, without using first-person failure language.
// E.g., "X is considered an anti-pattern" (when the agent was doing X).
// Originating incident: 2026-05-25/26 barrel re-export (mt#2108).
// ---------------------------------------------------------------------------

export const R5_PATTERNS: RegExp[] = [
  /\b(approach|pattern|method)\s+I\s+was\s+(using|implementing|following)\b[^.]*\banti[- ]?pattern\b/i,
  /\b(approach|pattern|method)\s+I\s+(chose|picked|selected|used)\b[^.]*\b(wrong|incorrect|bad practice)\b/i,
  /\bcommunity\s+consensus\s+is\s+against\b[^.]*\b(approach|pattern|method)\b/i,
  /\b(should\s+be\s+honest|to\s+be\s+honest)\b[^.]*\b(anti[- ]?pattern|wrong|incorrect|mistake)\b/i,
  /\bresearch\s+(shows|confirms|reveals|indicates)\b[^.]*\b(wrong|anti[- ]?pattern|incorrect)\b/i,
  /\bI\s+was\s+(implementing|using|building|creating)\b[^.]*\b(anti[- ]?pattern|wrong approach|incorrect)\b/i,
];

// ---------------------------------------------------------------------------
// User correction signals (detected in the current user prompt)
// ---------------------------------------------------------------------------

export const USER_CORRECTION_PATTERNS: RegExp[] = [
  /\bthat[''’]?s\s+(wrong|incorrect|not\s+right|not\s+what\s+I\s+said)\b/i,
  /\byou\s+keep\s+doing\s+this\b/i,
  /\bI[''’]?ve\s+told\s+you\s+this\s+before\b/i,
  /\bhow\s+many\s+times\b/i,
  /\bwhy\s+did\s+you\s+do\s+that\b/i,
  /\bwhat\s+were\s+you\s+thinking\b/i,
  /\bwhy\s+would\s+you\b/i,
  /\bwhy\s+didn[''’]?t\s+you\b/i,
];

// ---------------------------------------------------------------------------
// All families bundled for scanning
// ---------------------------------------------------------------------------

const FAMILY_PATTERNS: Array<{ family: TriggerFamily; patterns: RegExp[] }> = [
  { family: "R1", patterns: R1_PATTERNS },
  { family: "R2", patterns: R2_PATTERNS },
  { family: "R3", patterns: R3_PATTERNS },
  { family: "R4", patterns: R4_PATTERNS },
  { family: "R5", patterns: R5_PATTERNS },
];

// ---------------------------------------------------------------------------
// Transcript JSONL types (minimal subset — mirrors substrate-bypass-detector)
// ---------------------------------------------------------------------------

interface TranscriptLine {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  name?: string;
  tool_name?: string;
  input?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Transcript parsing helpers
// ---------------------------------------------------------------------------

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
      result.push(JSON.parse(trimmed) as TranscriptLine);
    } catch {
      // skip malformed
    }
  }
  return result;
}

export function extractLastAssistantTurn(lines: TranscriptLine[]): TranscriptLine[] {
  const userIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.type === "user" || line.message?.role === "user") {
      userIndices.push(i);
    }
  }

  if (userIndices.length < 2) return [];

  const startIdx = (userIndices[userIndices.length - 2] as number) + 1;
  const endIdx = userIndices[userIndices.length - 1] as number;
  return lines.slice(startIdx, endIdx);
}

export function extractAssistantText(turnLines: TranscriptLine[]): string {
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

export function extractLastUserMessage(lines: TranscriptLine[]): string {
  const userIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.type === "user" || line.message?.role === "user") {
      userIndices.push(i);
    }
  }

  if (userIndices.length === 0) return "";

  const lastUserLine = lines[userIndices[userIndices.length - 1] as number];
  if (!lastUserLine) return "";

  const content = lastUserLine.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b["type"] === "text" && typeof b["text"] === "string") {
          parts.push(b["text"] as string);
        }
      }
    }
    return parts.join("\n");
  }
  return "";
}

export function hasRetrospectiveSkillInvocation(turnLines: TranscriptLine[]): boolean {
  const checkBlock = (block: Record<string, unknown>): boolean => {
    if (block["type"] !== "tool_use") return false;
    const name = block["name"] as string | undefined;
    if (name !== "Skill") return false;
    const input = block["input"] as Record<string, unknown> | undefined;
    if (!input) return false;
    return input["skill"] === "retrospective";
  };

  for (const line of turnLines) {
    if (line.type === "tool_use" && (line.name === "Skill" || line.tool_name === "Skill")) {
      if (line.input?.["skill"] === "retrospective") return true;
    }
    if (line.message?.content && Array.isArray(line.message.content)) {
      for (const block of line.message.content as Array<Record<string, unknown>>) {
        if (checkBlock(block)) return true;
      }
    }
    if (line.type === "assistant" && line.message?.content && Array.isArray(line.message.content)) {
      for (const block of line.message.content as Array<Record<string, unknown>>) {
        if (checkBlock(block)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Detection functions (exported for testing)
// ---------------------------------------------------------------------------

export function detectTriggerPhrases(text: string): TriggerMatch[] {
  const matches: TriggerMatch[] = [];
  for (const { family, patterns } of FAMILY_PATTERNS) {
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (match) {
        matches.push({ family, matchedPhrase: match[0] });
        break;
      }
    }
  }
  return matches;
}

export function detectUserCorrection(userText: string): TriggerMatch[] {
  const matches: TriggerMatch[] = [];
  for (const pattern of USER_CORRECTION_PATTERNS) {
    const match = pattern.exec(userText);
    if (match) {
      matches.push({ family: "user-correction", matchedPhrase: match[0] });
      break;
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Calibration logging
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
    process.stderr.write(
      `[retrospective-trigger-scanner] Failed to write calibration log: ${msg}\n`
    );
  }
}

// ---------------------------------------------------------------------------
// Reminder builder
// ---------------------------------------------------------------------------

function buildReminder(matches: TriggerMatch[]): string {
  const lines: string[] = [
    `[retrospective-trigger-scanner] Retrospective trigger detected in prior assistant output or current user prompt.`,
    "",
  ];

  const assistantMatches = matches.filter((m) => m.family !== "user-correction");
  const userMatches = matches.filter((m) => m.family === "user-correction");

  if (assistantMatches.length > 0) {
    lines.push(
      "Your prior response contained retrospective-trigger phrases. " +
        "Your next response MUST invoke `/retrospective` before any other action."
    );
    lines.push("");
    for (const m of assistantMatches) {
      lines.push(`  - Family ${m.family}: "${m.matchedPhrase}"`);
    }
    lines.push("");
  }

  if (userMatches.length > 0) {
    lines.push(
      "User correction signal detected in the current prompt. " +
        "Invoke `/retrospective` immediately."
    );
    lines.push("");
    for (const m of userMatches) {
      lines.push(`  - Signal: "${m.matchedPhrase}"`);
    }
    lines.push("");
  }

  lines.push(
    "The retrospective skill's Step 0.5 triage determines whether a full retrospective " +
      "is warranted -- do NOT make that determination in user-facing output. " +
      "Override: set MINSKY_ACK_RETROSPECTIVE_TRIGGER=1 if this is genuinely not a retrospective case."
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

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
      `[retrospective-trigger-scanner] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${ts}\n`
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
  } catch {
    process.exit(0);
  }

  if (lines.length === 0) {
    process.exit(0);
  }

  const allMatches: TriggerMatch[] = [];

  // Check if /retrospective was already invoked in the prior turn — suppress ALL detection
  let retrospectiveAlreadyInvoked = false;
  try {
    const turnLines = extractLastAssistantTurn(lines);
    if (turnLines.length > 0 && hasRetrospectiveSkillInvocation(turnLines)) {
      retrospectiveAlreadyInvoked = true;
    }
  } catch {
    // fail-open
  }

  if (retrospectiveAlreadyInvoked) {
    process.exit(0);
  }

  // Surface 1: scan prior assistant turn for trigger phrases
  try {
    const turnLines = extractLastAssistantTurn(lines);
    if (turnLines.length > 0) {
      const assistantText = extractAssistantText(turnLines);
      if (assistantText) {
        const triggerMatches = detectTriggerPhrases(assistantText);
        allMatches.push(...triggerMatches);
      }
    }
  } catch (err) {
    console.error(
      `[retrospective-trigger-scanner] Assistant-turn detection error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Surface 2: scan current user prompt for correction signals
  try {
    const userText = extractLastUserMessage(lines);
    if (userText) {
      const correctionMatches = detectUserCorrection(userText);
      allMatches.push(...correctionMatches);
    }
  } catch (err) {
    console.error(
      `[retrospective-trigger-scanner] User-correction detection error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (allMatches.length === 0) {
    process.exit(0);
  }

  // Log calibration record
  const firstMatch = allMatches[0];
  let transcriptExcerpt = "";
  if (firstMatch) {
    try {
      const turnLines = extractLastAssistantTurn(lines);
      const fullText =
        firstMatch.family === "user-correction"
          ? extractLastUserMessage(lines)
          : extractAssistantText(turnLines);
      const idx = fullText.indexOf(firstMatch.matchedPhrase);
      if (idx >= 0) {
        const start = Math.max(0, idx - 80);
        const end = Math.min(fullText.length, idx + firstMatch.matchedPhrase.length + 80);
        transcriptExcerpt = fullText.slice(start, end);
      }
    } catch {
      // fail-open
    }
  }

  appendCalibrationRecord(input.cwd, {
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    matches: allMatches.map((m) => ({ family: m.family, phrase: m.matchedPhrase })),
    transcript_excerpt: transcriptExcerpt,
  });

  const reminder = buildReminder(allMatches);
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
