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
 * **Two window shapes (mt#4961).** A first-time titling shows the model the
 * conversation's OPENING ({@link selectTitleTurns}) — the subject is presumed
 * to live there. A REFRESH ({@link selectRefreshTitleTurns}) additionally shows
 * a recent-weighted TAIL, because the whole reason a refresh fires is that the
 * conversation moved on from where it started; showing only the opening again
 * would reproduce the stale title.
 *
 * **Handoff-resumed conversations (mt#4961, SC3).** A conversation whose first
 * human turn is an ADR-046 succession claim (`handoff mt#N`, `action handoff
 * …`, or a `minsky://task/` link) is, structurally, titled after the CLAIM
 * rather than the work — "Handoff on mt#4956 task claim" says nothing a reader
 * can act on. When an injected {@link WorkPackageLookup} resolves that claim's
 * task to a `work-package`-kind task, its title and member list are prefixed
 * onto the prompt and the model is told to title the WORK, not the handoff.
 * This module stays pure (no DB import) — the lookup is supplied by the
 * caller ({@link TitlePipeline}, which resolves it against the task store).
 *
 * @see mt#3321 — this module
 * @see mt#4961 — refresh window + handoff-aware prompt
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

/**
 * A {@link TitleTurn} carrying its DB ordinal (mt#4961) — the identity
 * {@link selectRefreshTitleTurns} de-duplicates the head/tail windows on. Plain
 * {@link TitleTurn} has no such identity because a first-time titling only ever
 * has ONE window to select from; a refresh has two that can overlap on a short
 * conversation.
 */
export type IndexedTitleTurn = TitleTurn & { turnIndex: number };

/**
 * Resolve a handoff-claimed task id (mt#4961, SC3) — supplied by the caller
 * ({@link TitlePipeline}), never imported here, so this module keeps no DB
 * dependency. Returns null for anything that is not a `work-package`-kind
 * task: an ordinary task named in a `handoff mt#N` claim is not this pattern,
 * and the generator must fall through to its normal prompt rather than title
 * the session after an unrelated task that happens to share the claim's id.
 */
export type WorkPackageLookup = (
  taskId: string
) => Promise<{ title: string; members: Array<{ id: string; title: string | null }> } | null>;

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

/** Whether a turn carries anything a reader (or the model) would see as content. */
function hasVisibleContent(turn: TitleTurn): boolean {
  return Boolean(visibleText(turn.userText) || visibleText(turn.assistantText));
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
    if (!hasVisibleContent(turn)) continue;
    selected.push(turn);
    if (selected.length >= MAX_TURNS) break;
  }
  return selected;
}

/** Head turns kept for a REFRESH prompt (mt#4961) — see {@link selectRefreshTitleTurns}. */
export const TITLE_REFRESH_HEAD_TURNS = 4;

/**
 * Hard cap on the turns actually sent to the model, applied inside
 * {@link TitleGenerator.generateTitle} itself (PR #3724 R1). Equal to the
 * largest window any selection function produces —
 * {@link TITLE_REFRESH_HEAD_TURNS} + {@link MAX_TURNS} (a refresh's head +
 * tail) — so a well-behaved caller (one that pre-selected via
 * {@link selectTitleTurns} or {@link selectRefreshTitleTurns}) is never
 * truncated, while a caller that bypasses selection entirely and hands
 * `generateTitle` a raw, unbounded turn array cannot blow the prompt budget.
 */
const MAX_PROMPT_TURNS = TITLE_REFRESH_HEAD_TURNS + MAX_TURNS;

/**
 * The window shown to the model when REFRESHING a title (mt#4961): the
 * conversation's opening ({@link TITLE_REFRESH_HEAD_TURNS} substantive turns —
 * so a conversation that never left its original subject is not made to look
 * like it drifted) plus {@link MAX_TURNS} substantive turns selected from the
 * LAST {@link TURN_SCAN_LIMIT} turns (recent-weighted, since the entire point
 * of a refresh is to catch where the conversation moved).
 *
 * `headTurns` and `tailTurns` are two independently-loaded, non-overlapping-by-
 * INTENT windows (see `TitlePipeline.loadTurns` / `loadTailTurns`), but on a
 * short conversation the "last 36 turns" IS the opening — so the tail pool is
 * de-duplicated against whichever head turns were actually SELECTED (by
 * {@link IndexedTitleTurn.turnIndex}) before its own selection runs, and the
 * combined result is re-sorted into conversation order (the two selections
 * each preserve order internally, but concatenation does not).
 */
export function selectRefreshTitleTurns<T extends IndexedTitleTurn>(
  headTurns: T[],
  tailTurns: T[]
): T[] {
  const head = selectTitleTurns(headTurns).slice(0, TITLE_REFRESH_HEAD_TURNS);
  const headIndexes = new Set(head.map((t) => t.turnIndex));
  const tailPool = tailTurns.filter((t) => !headIndexes.has(t.turnIndex));
  const tail = selectTitleTurns(tailPool);
  return [...head, ...tail].sort((a, b) => a.turnIndex - b.turnIndex);
}

/**
 * Succession-claim shape on a conversation's first human turn (mt#4961, SC3,
 * ADR-046): `handoff mt#N`, `action handoff mt#N`, optionally slash-prefixed
 * (the harness command form), or a `minsky://task/mt%23N` deeplink. Returns
 * the claimed task id (`mt#N`), or null when the text matches neither shape.
 */
function extractHandoffTaskId(text: string | null | undefined): string | null {
  if (!text) return null;
  const claim = text.match(/^\s*\/?(?:handoff|action\s+handoff)\s+mt#(\d+)/i);
  if (claim) return `mt#${claim[1]}`;
  const link = text.match(/minsky:\/\/task\/mt%23(\d+)/i);
  if (link) return `mt#${link[1]}`;
  return null;
}

/**
 * Render the work-package prefix prepended to a handoff-resumed conversation's
 * prompt (mt#4961, SC3) — instructing the model to title the WORK rather than
 * the claim, and naming the package and its members so it can.
 */
function buildWorkPackagePrefix(pkg: {
  title: string;
  members: Array<{ id: string; title: string | null }>;
}): string {
  const memberLines = pkg.members
    .map((m) => `- ${m.id}${m.title ? `: ${m.title}` : ""}`)
    .join("\n");
  const lines = [
    "This conversation was resumed via a handoff claim on a work package.",
    "Title the session after the WORK described below, never after the act of",
    "claiming it or handing it off.",
    `Work package: ${pkg.title}`,
  ];
  if (memberLines) lines.push("Members:", memberLines);
  return `${lines.join("\n")}\n\n`;
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
    private readonly modelHint: ModelHint = TITLE_MODEL_HINT,
    /** Resolve a handoff claim's task to a work package (mt#4961, SC3). Absent means never prefix. */
    private readonly workPackageLookup?: WorkPackageLookup
  ) {}

  /**
   * Generate a short title from the given turns.
   *
   * `turns` is trusted to already be the window the caller wants shown —
   * {@link selectTitleTurns} for a first-time titling, {@link
   * selectRefreshTitleTurns} for a refresh. This method itself only strips any
   * turn that carries no visible content (a defensive filter for a caller that
   * passes raw, unselected turns directly, which several tests here do); it
   * does NOT re-apply {@link MAX_TURNS} alone — that cap belongs to the
   * SELECTION the caller already made, and re-imposing IT here would truncate
   * a refresh's wider (head + tail) window back down to the size of a
   * first-time one. It DOES enforce {@link MAX_PROMPT_TURNS} (PR #3724 R1) —
   * the largest window ANY selection function produces — as a hard backstop:
   * a caller that bypasses selection entirely and hands this an unbounded
   * array still cannot blow the prompt budget.
   *
   * Returns null when there is nothing to title (no turn carries visible
   * content) or the model reports no identifiable subject. THROWS on provider
   * failure — the caller (the title pipeline) decides whether to skip the row
   * and record the error; a silent null here would be indistinguishable from
   * "nothing to do", which is the dominant latent-bug shape in this codebase
   * (mem#682).
   */
  async generateTitle(agentSessionId: string, turns: TitleTurn[]): Promise<string | null> {
    const selected = turns.filter(hasVisibleContent).slice(0, MAX_PROMPT_TURNS);
    if (selected.length === 0) return null;

    // mt#4961, SC3 — the succession-claim check reads the FIRST turn handed
    // in, which for both the fresh and refresh callers is the conversation's
    // earliest surviving turn (selectTitleTurns/selectRefreshTitleTurns both
    // preserve order and start from the opening).
    const prefix = await this.buildHandoffPrefix(turns[0]?.userText ?? null);

    const result = await this.cognitionProvider.perform({
      id: `session-title:${agentSessionId}`,
      kind: "synthesize-narrative",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: prefix + buildUserPrompt(selected),
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

  /**
   * Build the work-package prefix for a handoff-resumed conversation (mt#4961,
   * SC3), or the empty string when no lookup is wired, the first turn does not
   * match the succession-claim shape, or the claimed task is not a work
   * package (a bare `handoff mt#N` naming an ordinary task is not this
   * pattern — see {@link WorkPackageLookup}).
   */
  private async buildHandoffPrefix(firstHumanText: string | null): Promise<string> {
    if (!this.workPackageLookup) return "";
    const taskId = extractHandoffTaskId(firstHumanText);
    if (!taskId) return "";
    const pkg = await this.workPackageLookup(taskId);
    if (!pkg) return "";
    return buildWorkPackagePrefix(pkg);
  }
}
