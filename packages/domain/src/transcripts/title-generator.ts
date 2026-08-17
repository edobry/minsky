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
import { toDisplaySnippet } from "./text-snippet";
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
 * A dated model id will eventually be retired by the provider, at which point
 * completions 404 (PR #2408 R1). Two things bound that risk:
 *
 *  - The id is overridable per-instance — `new TitleGenerator(provider, hint)` —
 *    so a caller can swap it without a code change here.
 *  - Failure is non-destructive and self-healing: `TitlePipeline` counts the
 *    error, logs it with the session id, and leaves the row NULL, so a retired
 *    model degrades to "conversations keep their older label tier" and the
 *    logs say why. It does not corrupt data or block ingest.
 *
 * When it does need changing, this constant is the single place. Deliberately
 * NOT auto-resolved from the model registry: that registry is the exact
 * surface that is currently broken (mt#3337 — Anthropic reports 0 models while
 * completions work), so depending on it would make titling fail for a reason
 * unrelated to titling.
 */

/**
 * Hard cap on a rendered title. Matches the width the cockpit's tab and list
 * rows can show without truncating; the prompt also asks for brevity, and this
 * is the backstop for when the model ignores it.
 */
export const TITLE_MAX_LEN = 60;

/** Turns fed to the model. The opening of a conversation carries its subject. */
const MAX_TURNS = 12;

/**
 * How many candidate turns {@link selectTitleTurns} scans to find its
 * {@link MAX_TURNS} substantive ones (mt#4179).
 *
 * Until mt#4179 the window was the first {@link MAX_TURNS} turns OUTRIGHT, and
 * a turn is not a unit of content: an agent working through Read/Grep/Bash
 * calls emits turns whose `userText` and `assistantText` are both NULL, and a
 * pasted screenshot emits a turn whose only text is an `[Image: …]`
 * placeholder. Measured on `bb0650ed-f6b7-444f-8fe7-28c91d784ab7` — a 177-turn
 * session — turns 1 through 6 are ALL text-free, so the model was shown one
 * four-word exchange and correctly answered that it could not name a subject.
 * The conversation was not thin; the window was measured in the wrong unit.
 *
 * Scanning 3x the target bounds the prompt-assembly cost while giving a
 * tool-call-heavy opening room to reach real prose.
 */
export const TURN_SCAN_LIMIT = MAX_TURNS * 3;

/**
 * Attachment placeholders the harness substitutes for pasted binary content.
 * The text is present and non-empty, so an emptiness check passes it through,
 * but it names a file path rather than a subject — the whole visible content of
 * the opening turns of `c5199a09-2f93-49b5-8223-5a2f69f52156` (an 805-line
 * session that went untitled for this reason).
 */
const ATTACHMENT_PLACEHOLDER_RE = /\[(?:Image|Attachment|Screenshot)\b[^\]]*\]/gi;

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

/**
 * The only fields titling reads off a turn. Declared as a projection rather
 * than taking a full {@link ExtractedTurn} so the pipeline can pass
 * `agent_transcript_turns` rows straight through (mt#4179) without
 * manufacturing the timing/tool-call fields this path never looks at.
 */
export type TitleTurn = Pick<ExtractedTurn, "userText" | "assistantText">;

/** Length bound for the substantive-content probe — enough to tell empty from not. */
const SUBSTANTIVE_PROBE_LEN = 120;

/**
 * The text a reader would actually SEE in this turn: harness markup and
 * attachment placeholders removed. Empty means the turn carries no subject
 * matter, whether or not its columns are non-NULL.
 */
function visibleText(text: string | null | undefined): string {
  if (!text) return "";
  return toDisplaySnippet(text.replace(ATTACHMENT_PLACEHOLDER_RE, " "), SUBSTANTIVE_PROBE_LEN);
}

/**
 * Pick the turns the model is shown: the first {@link MAX_TURNS} turns that
 * carry visible content, scanning at most {@link TURN_SCAN_LIMIT} candidates.
 *
 * Exported for direct testing, and because {@link TURN_SCAN_LIMIT} is also the
 * bound the pipeline's turn query uses — the two must not drift, so the
 * pipeline imports it rather than restating a number.
 */
export function selectTitleTurns<T extends TitleTurn>(turns: T[]): T[] {
  const selected: T[] = [];
  for (const turn of turns.slice(0, TURN_SCAN_LIMIT)) {
    if (!visibleText(turn.userText) && !visibleText(turn.assistantText)) continue;
    selected.push(turn);
    if (selected.length >= MAX_TURNS) break;
  }
  return selected;
}

function buildUserPrompt(turns: TitleTurn[]): string {
  const lines: string[] = ["Title this session:\n"];

  for (const turn of turns) {
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
  constructor(
    private readonly cognitionProvider: CognitionProvider,
    /** Override the pinned cheap model — see {@link TITLE_MODEL_HINT}. */
    private readonly modelHint: ModelHint = TITLE_MODEL_HINT
  ) {}

  /**
   * Generate a short title from the transcript's opening turns.
   *
   * Returns null when there is nothing to title (no turn carries visible
   * content — see {@link selectTitleTurns}) or the model reports no
   * identifiable subject. THROWS on provider failure — the caller (the title
   * pipeline) decides whether to skip the row and record the error; a silent
   * null here would be indistinguishable from "nothing to do", which is the
   * dominant latent-bug shape in this codebase (mem#682).
   */
  async generateTitle(agentSessionId: string, turns: TitleTurn[]): Promise<string | null> {
    const selected = selectTitleTurns(turns);
    if (selected.length === 0) return null;

    const result = await this.cognitionProvider.perform({
      id: `session-title:${agentSessionId}`,
      kind: "synthesize-narrative",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(selected),
      schema: titleSchema,
      model: this.modelHint,
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
