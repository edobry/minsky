/**
 * TitleGenerator (mt#3321)
 *
 * Generates a SHORT display title for an agent transcript — the label the
 * cockpit shows in a tab, a run list, and the conversation header.
 *
 * Sibling of {@link SummaryGenerator}, deliberately separate rather than an
 * option on it: a summary is a 3-6 sentence paragraph that exists to be
 * EMBEDDED for semantic search, while a title is a ~60-char human-scannable
 * label. They have different prompts, different length budgets, different
 * output columns, and different consumers.
 *
 * Why this exists at all: before mt#3321 the conversation label was the first
 * 60 characters of the first substantive user turn, which cannot be robust to
 * a noisy opening prompt. The originating case
 * (`77c6ca4f-1241-4e1a-9648-7ce3e28c6c25`) rendered as
 * "rn they're in into a better one, which will have positive…" — a faithful
 * head-cut of a genuinely mangled dictation (mem#759).
 *
 * **Model tier.** Titling is a cheap, high-volume, low-stakes task, so this
 * pins an explicitly cheap model via `ModelHint` rather than inheriting
 * whatever the provider defaults to. Note `ModelHint` is ADVISORY at the
 * interface (`cognition/types.ts`) — `DirectCognitionProvider` does honor it,
 * but a different provider need not, so this is a request, not a guarantee.
 *
 * @see mt#3321 — this module
 * @see summary-generator.ts — the paragraph-summary sibling (mt#1353)
 * @see conversation-label.ts — the consumer of the generated title
 */

import { z } from "zod";

import type { CognitionProvider, ModelHint } from "../cognition/types";
import type { ExtractedTurn } from "./turn-extractor";
import { safeTruncate } from "@minsky/shared/safe-truncate";

// ── Tuning ─────────────────────────────────────────────────────────────────────

/**
 * Cheap model for titling. Anthropic's model-LISTING fetcher is currently
 * broken (`ai_providers_list` reports 0 models — mt#3337), but COMPLETIONS are
 * healthy: this exact id was verified callable on 2026-07-29. The hint is
 * passed straight through by `DirectCognitionProvider` without consulting the
 * model registry, so the listing defect does not affect this path.
 */
export const TITLE_MODEL_HINT: ModelHint = {
  provider: "anthropic",
  model: "claude-haiku-4-5-20251001",
};

/**
 * Hard cap on a rendered title. Matches the width the cockpit's tab and list
 * rows can show without truncating; the prompt also asks for brevity, and this
 * is the backstop for when the model ignores it.
 */
export const TITLE_MAX_LEN = 60;

/** Turns fed to the model. The opening of a conversation carries its subject. */
const MAX_TURNS = 12;

/** Per-turn character budget, so one giant pasted turn cannot dominate the prompt. */
const MAX_CHARS_PER_TURN = 600;

// ── Schema ─────────────────────────────────────────────────────────────────────

const titleSchema = z.object({
  title: z.string().min(1),
});

// ── Prompts ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You write short, specific titles for engineering work sessions.

Given the opening of a transcript between an operator and a coding agent, write a title naming what the session is ABOUT.

Rules:
- At most 60 characters. Shorter is better.
- Name the specific subject — the system, bug, or question at hand.
- No trailing punctuation. No surrounding quotes. No "Session about..." or "Discussion of..." preamble.
- Sentence case, not Title Case.
- Describe the subject, not the participants ("Retry logic in session start", not "User asks about retries").
- The operator's opening message may be garbled, truncated, or start mid-sentence (dictation artifacts are common). Infer the subject from the whole excerpt rather than echoing broken text.
- If the content is genuinely too thin to identify a subject, return the single word: Untitled`;

/**
 * Sentinel the model returns when the excerpt carries no identifiable subject.
 * Treated as "no title" rather than written to the row, so the conversation
 * falls through to the older label tiers instead of displaying "Untitled".
 */
const NO_SUBJECT_SENTINEL = "untitled";

function buildUserPrompt(turns: ExtractedTurn[]): string {
  const lines: string[] = ["Title this session:\n"];

  for (const turn of turns.slice(0, MAX_TURNS)) {
    if (turn.userText) {
      lines.push(`Operator: ${safeTruncate(turn.userText, MAX_CHARS_PER_TURN, "head")}`);
    }
    if (turn.assistantText) {
      lines.push(`Agent: ${safeTruncate(turn.assistantText, MAX_CHARS_PER_TURN, "head")}`);
    }
  }

  lines.push('\nRespond with a JSON object: { "title": "<the title>" }');
  return lines.join("\n");
}

// ── Normalization ──────────────────────────────────────────────────────────────

/**
 * Clean a model-produced title into the display form: collapse whitespace,
 * strip wrapping quotes and trailing punctuation, and enforce the length cap.
 *
 * Returns null when the result is empty or the no-subject sentinel — callers
 * treat null as "leave the row untitled" rather than writing a placeholder.
 * Exported for direct testing.
 */
export function normalizeTitle(raw: string): string | null {
  let title = raw.replace(/\s+/g, " ").trim();
  // Models frequently wrap the answer in quotes despite being told not to.
  title = title
    .replace(/^["'`]+/, "")
    .replace(/["'`]+$/, "")
    .trim();
  title = title.replace(/[.,;:!?]+$/, "").trim();

  if (title.length === 0) return null;
  if (title.toLowerCase() === NO_SUBJECT_SENTINEL) return null;

  // Word-boundary-aware so the cap never splits a UTF-16 surrogate pair.
  return safeTruncate(title, TITLE_MAX_LEN, "head");
}

// ── TitleGenerator ─────────────────────────────────────────────────────────────

export class TitleGenerator {
  constructor(private readonly cognitionProvider: CognitionProvider) {}

  /**
   * Generate a short title from the transcript's opening turns.
   *
   * Returns null when there is nothing to title (no turns) or the model
   * reports no identifiable subject. THROWS on provider failure — the caller
   * (the title pipeline) decides whether to skip the row and record the error;
   * a silent null here would be indistinguishable from "nothing to do", which
   * is the dominant latent-bug shape in this codebase (mem#682).
   */
  async generateTitle(agentSessionId: string, turns: ExtractedTurn[]): Promise<string | null> {
    if (turns.length === 0) return null;

    const result = await this.cognitionProvider.perform({
      id: `session-title:${agentSessionId}`,
      kind: "synthesize-narrative",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(turns),
      schema: titleSchema,
      model: TITLE_MODEL_HINT,
    });

    if (result.kind === "completed") {
      return normalizeTitle(result.value.title);
    }

    if (result.kind === "unavailable") {
      throw new Error(
        `CognitionProvider unavailable for session title ${agentSessionId}: ${result.reason}`
      );
    }

    throw new Error(
      `CognitionProvider returned 'packaged' result for session title ${agentSessionId}. ` +
        "Delegated mode is not supported for transcript titling."
    );
  }
}
