/**
 * Authorship Judge
 *
 * AI-based authorship tier evaluation from session transcripts.
 * Uses a cost-efficient model (Haiku) to analyze the conversation and assign
 * a final authorship tier, replacing the hardcoded CO_AUTHORED default.
 *
 * This is best-effort: any failure degrades gracefully and must never block
 * the merge pipeline.
 *
 * @see mt#969 — AI-based authorship tier judging
 */

import { z } from "zod";
import type { DefaultAICompletionService } from "../ai/completion-service";
import type { TranscriptMessage } from "./transcript-service";
import { resolveMessageText } from "./transcript-content";
import { classifyUserLineOrigin, OPERATOR_ORIGIN } from "../transcripts/user-line-origin";
import type { TierSignals } from "./types";
import { AuthorshipTier } from "./types";
import { log } from "@minsky/shared/logger";
import { safeTruncate } from "@minsky/shared/safe-truncate";

/** Policy version for this judging logic. Bump when prompt or tier criteria change. */
export const AUTHORSHIP_POLICY_VERSION = "1.0.0";

/** Model used for tier judging — Haiku is cost-efficient for classification. */
const JUDGING_MODEL = "claude-haiku-4-5-20251001";

/** Provider for tier judging. */
const JUDGING_PROVIDER = "anthropic";

/**
 * Maximum tokens to generate.
 *
 * **Raised 500 → 2000 by mt#4314, because 500 was never actually enforced.**
 * `DefaultAICompletionService.generateObject` dropped `maxTokens` for the life of this
 * module, so every judgment this judge has ever produced ran against the SDK's provider
 * default. mt#4314 connects the knob, which makes this number bind for the first time.
 *
 * Measured before raising it, with the forwarding fix in place
 * (`bun scripts/verify-authorship-judge-cap.ts --limit 10`): at 500, **1 of 10 judgments
 * failed to parse** and the answer text of those that succeeded ran 850–1681 characters —
 * the largest already ~420+ tokens of prose before JSON field names, quoting and escaping.
 * The schema carries two open-ended prose fields plus a `trajectoryChanges` array, so this
 * is not a tail case; "keep it tight" was safe only while it did nothing.
 *
 * A truncated structured response does not raise a truncation error — it fails schema
 * validation on whichever field the model had not reached, which is exactly the signature
 * mt#4314 was diagnosed from. 2000 is ~4x the largest observed answer, and a cap is a
 * CEILING rather than a spend: raising it costs nothing on a judgment that stays short.
 */
const MAX_TOKENS = 2000;

/** Zod schema for the structured AI response. */
const authorshipJudgmentSchema = z.object({
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  rationale: z.string(),
  substantiveHumanInput: z.string(),
  trajectoryChanges: z.array(z.string()),
});

/** Typed output from the AI judge. */
export type AuthorshipJudgment = z.infer<typeof authorshipJudgmentSchema>;

const SYSTEM_PROMPT = `You are an expert authorship evaluator for AI-assisted software engineering. Given a session transcript between a human and an AI coding agent, determine the authorship tier.

Tier 1 (HUMAN_AUTHORED): The human provided substantial intellectual direction and design. They wrote detailed specs, made architectural decisions, actively steered implementation with corrections and redirections. The AI was primarily an execution tool.

Tier 2 (CO_AUTHORED): Mixed contribution. The human provided direction but the AI did significant design work. Or there was substantial iterative collaboration where both parties shaped the outcome. This is the default when signals are ambiguous.

Tier 3 (AGENT_AUTHORED): The AI did most of the intellectual work with minimal human involvement. The human's messages were primarily acknowledgments, rubber-stamps, or simple task dispatches without detailed direction.

Evaluate based on:
1. SUBSTANTIVE vs NOISE: Were the human's messages substantive (direction changes, design decisions, corrections, detailed feedback) or noise (acknowledgments like "looks good", "continue", "yes")?
2. TRAJECTORY CHANGES: Did the human's input change the direction of the work? Identify specific moments.
3. SPEC QUALITY: If the human provided a spec or task description, was it genuinely their thinking or generic/AI-generated?

Be honest and precise. A human sending many messages doesn't mean high contribution — evaluate content quality, not quantity.`;

/**
 * The speaker label this message is rendered under in the judge's prompt (mt#4289).
 *
 * `Human` is reserved for genuine operator speech. A `user`-role line the
 * harness wrote gets `Harness(<kind>)` — labelled rather than dropped, because
 * this judge is grading how much of the work the human drove, and silently
 * removing turns would distort the conversation's shape as badly as
 * mis-attributing them.
 *
 * The failure this replaces is the sharpest in the consumer inventory: an
 * auto-compaction summary is ~15KB of model prose NARRATING what the operator
 * asked for, and it was handed to the judge under the label `Human:` — the
 * model's account of the human's intent, presented as the human's own words, to
 * a grader whose entire question is how much the human contributed.
 */
function roleLabelFor(msg: TranscriptMessage): string {
  if (msg.type !== "user") return "Agent";
  const origin = classifyUserLineOrigin(msg);
  return origin === OPERATOR_ORIGIN ? "Human" : `Harness(${origin})`;
}

/**
 * Summarize a single message for the prompt (truncate long content).
 *
 * Content resolution goes through the shared resolver (mt#4225). This read `msg.content`
 * directly until then — the flat field that no stored row carries — so every message the
 * judge was handed rendered as `[non-text content]` and it graded authorship from a
 * transcript of markers. Identical defect to mt#4196's analyzer, one consumer over.
 */
function summarizeMessage(msg: TranscriptMessage, index: number): string {
  const role = roleLabelFor(msg);
  const { text } = resolveMessageText(msg);

  // Truncate to keep prompt compact (safeTruncate ensures no split surrogate pairs)
  const truncated = text.length > 300 ? `${safeTruncate(text, 300, "head")}…` : text;
  return `[${index + 1}] ${role}: ${truncated}`;
}

/** Format transcript and static signals into a compact user prompt. */
function buildUserPrompt(messages: TranscriptMessage[], signals: TierSignals): string {
  const signalsSummary = [
    `task_origin=${signals.taskOrigin ?? "unknown"}`,
    `spec_authorship=${signals.specAuthorship ?? "unknown"}`,
    `initiation_mode=${signals.initiationMode ?? "unknown"}`,
  ].join(", ");

  // mt#4289: the count the judge is told, like the labels above, means OPERATOR
  // messages — not every `user`-role line.
  const humanMessages = messages.filter(
    (m) => m.type === "user" && classifyUserLineOrigin(m) === OPERATOR_ORIGIN
  );
  const totalMessages = messages.length;

  const transcriptText = messages
    .slice(0, 40) // Cap at 40 messages to keep prompt size manageable
    .map((msg, i) => summarizeMessage(msg, i))
    .join("\n");

  return `Static signals: ${signalsSummary}
Total messages: ${totalMessages} (human: ${humanMessages.length})

Transcript (first ${Math.min(40, totalMessages)} messages):
${transcriptText}

Based on this transcript and signals, provide a JSON judgment with:
- tier: 1, 2, or 3
- rationale: concise explanation of the tier assignment
- substantiveHumanInput: summary of what substantive input (if any) the human contributed
- trajectoryChanges: array of specific moments where human input changed direction (empty array if none)`;
}

/**
 * AI-based authorship tier judge.
 *
 * Evaluates a stored session transcript and assigns a final authorship tier
 * using a language model. Best-effort: callers must wrap in try/catch.
 */
export class AuthorshipJudge {
  constructor(private readonly completionService: DefaultAICompletionService) {}

  /**
   * Evaluate a transcript and return an authorship judgment.
   *
   * @throws If the API call fails or returns an invalid response
   */
  async evaluateTranscript(
    messages: TranscriptMessage[],
    staticSignals: TierSignals
  ): Promise<AuthorshipJudgment> {
    if (messages.length === 0) {
      log.debug("AuthorshipJudge: empty transcript, defaulting to CO_AUTHORED");
      return {
        tier: AuthorshipTier.CO_AUTHORED as 1 | 2 | 3,
        rationale: "No transcript messages available; defaulting to CO_AUTHORED.",
        substantiveHumanInput: "Unknown — no transcript available.",
        trajectoryChanges: [],
      };
    }

    const userPrompt = buildUserPrompt(messages, staticSignals);

    log.debug("AuthorshipJudge: evaluating transcript", {
      messageCount: messages.length,
      humanMessages: messages.filter(
        (m) => m.type === "user" && classifyUserLineOrigin(m) === OPERATOR_ORIGIN
      ).length,
    });

    const result = await this.completionService.generateObject({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      schema: authorshipJudgmentSchema,
      model: JUDGING_MODEL,
      provider: JUDGING_PROVIDER,
      temperature: 0.1,
      maxTokens: MAX_TOKENS,
    });

    // `completionService.generateObject` post-parses against the schema we
    // passed, so `result` is already an `AuthorshipJudgment`. No second parse.
    const judgment = result as AuthorshipJudgment;

    log.debug("AuthorshipJudge: judgment complete", {
      tier: judgment.tier,
      trajectoryChanges: judgment.trajectoryChanges.length,
    });

    return judgment;
  }
}
