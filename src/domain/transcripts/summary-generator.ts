/**
 * SummaryGenerator
 *
 * Generates a session-level summary text for an agent transcript by calling
 * `CognitionProvider.perform()` with a summarization prompt over the full set
 * of extracted turns.
 *
 * Design notes:
 * - Single `perform()` call per transcript — no chain-of-thought, no multi-step.
 * - Returns plain summary text (string), not a structured object.
 * - On empty transcript (no turns), returns null — caller decides whether to skip.
 * - On CognitionProvider failure, propagates the error — caller decides whether
 *   to degrade or abort. The SummaryPipeline wraps this in try/catch.
 *
 * @see mt#1353 — this file
 * @see mt#1313 §Cognition scope — summary generation uses CognitionProvider
 * @see per-turn-embedding-pipeline.ts — embeds individual turns
 */

import { z } from "zod";

import type { CognitionProvider } from "../cognition/types";
import type { ExtractedTurn } from "./turn-extractor";
import { safeTruncate } from "../../utils/safe-truncate";

// ── Schema ─────────────────────────────────────────────────────────────────────

/** Schema for the structured output from the summarization task. */
const summarySchema = z.object({
  summary: z.string().min(1),
});

// ── Prompts ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a concise technical assistant. Your job is to summarize an agent session transcript.
The transcript consists of turns, each with a user prompt and an assistant response.
Write a single coherent paragraph (3-6 sentences) describing what happened in the session:
- What was the overall goal or task?
- What key actions did the agent take?
- What was the outcome or final state?
Be factual and specific. Do not speculate beyond what the transcript shows.`;

/**
 * Build the user prompt content from the extracted turns.
 * Truncates to keep prompt size reasonable for large transcripts.
 */
function buildUserPrompt(turns: ExtractedTurn[]): string {
  const MAX_CHARS_PER_TURN = 1000;
  const MAX_TURNS = 50;

  const effectiveTurns = turns.slice(0, MAX_TURNS);

  const lines: string[] = ["Summarize the following agent session transcript:\n"];

  for (const turn of effectiveTurns) {
    lines.push(`--- Turn ${turn.turnIndex + 1} ---`);
    if (turn.userText) {
      const text = safeTruncate(turn.userText, MAX_CHARS_PER_TURN, "head");
      lines.push(`User: ${text}${turn.userText.length > MAX_CHARS_PER_TURN ? " [truncated]" : ""}`);
    }
    if (turn.assistantText) {
      const text = safeTruncate(turn.assistantText, MAX_CHARS_PER_TURN, "head");
      lines.push(
        `Assistant: ${text}${turn.assistantText.length > MAX_CHARS_PER_TURN ? " [truncated]" : ""}`
      );
    }
    if (turn.toolCalls && turn.toolCalls.length > 0) {
      const toolNames = turn.toolCalls.map((t) => (t.name as string | undefined) ?? "unknown");
      lines.push(`Tools used: ${toolNames.join(", ")}`);
    }
    lines.push("");
  }

  if (turns.length > MAX_TURNS) {
    lines.push(`[... ${turns.length - MAX_TURNS} additional turns omitted for brevity ...]`);
  }

  lines.push(
    "Respond with a JSON object with a single key 'summary' containing a paragraph summarizing the session."
  );

  return lines.join("\n");
}

// ── SummaryGenerator ──────────────────────────────────────────────────────────

export class SummaryGenerator {
  constructor(private readonly cognitionProvider: CognitionProvider) {}

  /**
   * Generate a summary for the given extracted turns.
   *
   * @param agentSessionId - Used only for the CognitionTask ID (for correlating).
   * @param turns - Extracted turns from the transcript. If empty, returns null.
   * @returns Summary text, or null if there are no turns to summarize.
   */
  async generateSummary(agentSessionId: string, turns: ExtractedTurn[]): Promise<string | null> {
    if (turns.length === 0) {
      return null;
    }

    const userPrompt = buildUserPrompt(turns);

    const result = await this.cognitionProvider.perform({
      id: `session-summary:${agentSessionId}`,
      kind: "synthesize-narrative",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      schema: summarySchema,
    });

    if (result.kind === "completed") {
      return result.value.summary;
    }

    if (result.kind === "unavailable") {
      throw new Error(
        `CognitionProvider unavailable for session summary ${agentSessionId}: ${result.reason}`
      );
    }

    // result.kind === "packaged" — delegated mode; not supported for inline summary generation
    throw new Error(
      `CognitionProvider returned 'packaged' result for session summary ${agentSessionId}. ` +
        "Delegated mode is not supported for transcript summarization."
    );
  }
}
