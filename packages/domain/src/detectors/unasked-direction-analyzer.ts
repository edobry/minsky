/**
 * Unasked-direction analyzer — Surface 4 of the System 3* detector.
 *
 * Async post-merge analyzer: reads a finished session transcript, asks an
 * LLM to surface preference-bound decisions the agent made without being
 * directed to. Outputs structured findings that feed the rule library.
 *
 * Design pattern follows mt#969 `AuthorshipJudge`: cost-efficient model
 * (Haiku) + Vercel AI SDK `generateObject` + Zod schema for typed results.
 *
 * Findings DO NOT block merge — Surface 4 runs after merge, by definition
 * too late for that. The value is in the corpus, which Surface 2 (deferred
 * to v0.2) will consume.
 *
 * Reference: docs/research/mt1035-system3-detector.md §Surface 4
 * Reference: src/domain/provenance/authorship-judge.ts (sibling pattern)
 * Reference: src/domain/detectors/index.ts (mt#1574 shared infra)
 */

import { z } from "zod";
import type { DefaultAICompletionService } from "../ai/completion-service";
import type { TranscriptMessage } from "../provenance/transcript-service";
import { classifyUserLineOrigin, OPERATOR_ORIGIN } from "../transcripts/user-line-origin";
import {
  detectBlindRendering,
  nonTextRatio,
  resolveMessageText,
} from "../provenance/transcript-content";
import type { DetectionSignal } from "./types";
import { log } from "@minsky/shared/logger";
import { safeTruncate } from "@minsky/shared/safe-truncate";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stable detector identifier. */
export const DETECTOR_ID = "unasked-direction-postmortem";

/** Versioned ruleset; bump when the prompt or schema changes. */
export const DETECTOR_VERSION = "v0.1.0";

/** Cost-efficient classifier model (mirrors AuthorshipJudge choice). */
const ANALYZER_MODEL = "claude-haiku-4-5-20251001";

/** Provider for analysis. */
const ANALYZER_PROVIDER = "anthropic";

/**
 * Token cap for the analyzer's structured answer.
 *
 * **This value now takes effect (mt#4314).** It did not until then:
 * `DefaultAICompletionService.generateObject` dropped `maxTokens`, so the real ceiling was
 * the SDK's provider default and this number was inert. mt#4235's note here said exactly
 * that, and recorded that its 2000 → 8000 → 16000 sweep produced 9 → 4 → 6 failures —
 * variance around a disconnected knob rather than a dose-response curve.
 *
 * Raised 2000 → 12000 because the value is now REAL, not because 2000 was measured to be
 * the cause of anything. Both caps in this codebase were chosen while they did nothing, so
 * connecting the knob means re-sizing them to values that are safe to actually enforce; a
 * 2000 ceiling that binds for the first time is a behaviour change on long answers even if
 * nothing observed today is hitting it. 12000 is chosen to be clearly NON-BINDING for this
 * analyzer's output shape — an array of findings, each with a label, rationale, severity,
 * evidence indices and a suggested signature, plus a trailing summary.
 *
 * **The cap is NOT what drives this analyzer's observed failures, and this comment must not
 * be read as claiming it is (mt#4314).** Live 20-transcript replays with the knob connected:
 * 2000 → 7 failures, 12000 → 8. That is flat. The failures are the model returning an object
 * missing a REQUIRED field — and at 12000 one row came back missing `findings`, which is the
 * FIRST field in the schema, so it cannot be truncation. The emitted JSON Schema was checked
 * and does carry `required: ["findings","summary"]`, so the model is being told. That is a
 * structured-output compliance problem with this model on this schema, owned by mt#4317.
 *
 * A cap is a CEILING rather than a spend: a quiet session still costs what its short answer
 * costs, so the headroom is free.
 */
const MAX_TOKENS = 12000;

/**
 * Cap on how many messages are rendered into the prompt.
 *
 * Unchanged at 60 by mt#4235, deliberately: this constant is the analyzer's COST
 * ceiling, and the defect it fixed was in WHICH 60 were chosen, not how many. See
 * `selectAnalysisWindow` for the selection rule and its cost consequence.
 */
const TRANSCRIPT_MESSAGE_CAP = 60;

/** Cap per-message body size. */
const MESSAGE_TRUNCATE_CHARS = 400;

// ---------------------------------------------------------------------------
// Output schema (Zod)
// ---------------------------------------------------------------------------

/**
 * Severity of a single finding.
 *
 * Matches the `DetectionSignal.severity` triple from mt#1574 so findings
 * can be lifted directly into signals without remapping.
 */
const findingSeveritySchema = z.union([z.literal("low"), z.literal("medium"), z.literal("high")]);

/** A single unasked-direction finding the analyzer surfaces. */
const findingSchema = z.object({
  /** Short label for the decision (e.g. "chose Redis as queue backend"). */
  label: z.string(),
  /** Why this decision is preference-bound (citation-style explanation). */
  rationale: z.string(),
  /** Severity assigned by the analyzer. */
  severity: findingSeveritySchema,
  /** Specific transcript-message indices (1-based) that evidence the decision. */
  evidenceMessages: z.array(z.number()),
  /** Suggested signature for Surface 2 (free-text; refined when Surface 2 ships). */
  suggestedSignature: z.string(),
});

/**
 * Full analyzer output.
 *
 * ## Declaration order was investigated and does NOT currently matter (mt#4317)
 *
 * Recorded because it is a live question that has already been asked once and answered
 * two different ways, and the second answer is the one that governs.
 *
 * This analyzer loses a minority of runs to the model returning a well-formed object
 * MISSING a field the schema marks required. Measured 2026-08-19 over 40 stored
 * transcripts, the field that went missing was whichever was declared LAST, and moving
 * `summary` ahead of `findings` cut rejections from 15/40 to 5/40 — paired on identical
 * prompts, McNemar exact p = 0.0063.
 *
 * **It did not replicate.** Re-measured 2026-08-20 against 40 transcripts after mt#4289
 * changed how a harness-written user line is rendered: baseline 5/40, reordered 6/40,
 * 1 vs 2 discordant, p = 1.0 — no effect, nominally the wrong way. So the reorder is NOT
 * applied: shipping it would credit it with an improvement it does not deliver on this
 * code, which is the error mt#4314's PR exists to document.
 *
 * Two things moved between those runs and neither can be isolated after the fact: mt#4289
 * changed the prompt, AND the corpus rotated (the replay draws the 40 most recently
 * ingested transcripts). The 15/40 → 5/40 drop in the untouched baseline therefore has no
 * attributable cause — do not record it as "mt#4289 fixed it".
 *
 * Also established and still standing: the token budget is not the cause (flat across a
 * 6x range); the emitted schema does carry `required: ["findings","summary"]` and
 * `additionalProperties: false`; `jsonSchema()` installs no validator, so the AI SDK checks
 * nothing and `request.schema.parse()` is the only gate. Adding `.describe()` to both
 * fields (19/40) and naming `summary` in the system prompt (18/40) were each measured and
 * each came out nominally WORSE than baseline — do not re-propose them without new evidence.
 *
 * The leading open hypothesis is PROMPT SIZE rather than field identity, and it is a LEAD,
 * not a result. Over the 40 transcripts of the second run, no prompt under ~10,000
 * characters produced a failure (0/13) against 5/27 above it — but at the transcript level
 * with a round threshold that is p = 0.15, i.e. not significant, and the apparent effect
 * is driven by a floor rather than a gradient (above the median, size does not grade the
 * risk further: 13% vs 14%). Quoting a stronger figure than this requires care — computed
 * per ROW it looks like p = 0.03, which is wrong twice over: the two arms of one transcript
 * share a prompt and are not independent observations, and the threshold was read off the
 * smallest failing prompt rather than chosen in advance.
 *
 * `scripts/experiment-analyzer-field-compliance.ts` records `promptChars` on every row so a
 * larger run can settle this without re-deriving it.
 */
const analyzerOutputSchema = z.object({
  findings: z.array(findingSchema),
  /** Quick summary of what the analyzer judged in this session. */
  summary: z.string(),
});

export type UnaskedDirectionFinding = z.infer<typeof findingSchema>;
export type AnalyzerOutput = z.infer<typeof analyzerOutputSchema>;

/**
 * Every non-message parameter of the analyzer's completion call, in one place.
 *
 * Extracted by mt#4317 so the measurement harness
 * (`scripts/experiment-analyzer-field-compliance.ts`) reproduces the PRODUCTION call
 * exactly rather than mirroring four literals that can drift. The harness spreads this and
 * overrides only the one variable its arm is testing; anything it does not override is by
 * construction the shipped value.
 *
 * **`mode` is deliberately absent**, so the SDK picks (`"auto"`) exactly as it always has.
 * `AIObjectGenerationRequest.mode` exists and is forwarded — mt#4317 added it — but setting
 * it here would be an unmeasured behaviour change to a production path. Tool mode was
 * measured once, at 11/40 against `auto`'s 15/40 on n=40 per arm, which is not separable
 * from run-to-run variance; that is the same standard under which this task declined to ship
 * a field reorder, and it applies here too. The harness carries a `tool-mode` arm so a run
 * large enough to settle it does not have to rebuild the plumbing.
 *
 * Caveat on the recorded figures below and in `analyzerOutputSchema`: both mt#4317 runs were
 * taken on a branch that DID set `mode: "tool"`, so their absolute rates are tool-mode rates.
 * The paired comparisons between arms are unaffected — every arm in a run shared the mode —
 * but the current production rate under `auto` has not been re-measured.
 */
const ANALYZER_REQUEST_DEFAULTS = {
  model: ANALYZER_MODEL,
  provider: ANALYZER_PROVIDER,
  temperature: 0.2,
  maxTokens: MAX_TOKENS,
} as const;

// ---------------------------------------------------------------------------
// Message selection (mt#4235)
// ---------------------------------------------------------------------------

/** A message chosen for analysis, paired with where it sat in the FULL transcript. */
export interface SelectedMessage {
  message: TranscriptMessage;
  /** 0-based position in the full stored transcript. */
  index: number;
}

/**
 * How a run's analyzed window was chosen — recorded alongside every run.
 *
 * Without this, a run that read 7 text-bearing messages of setup chatter and a run that
 * read 60 spanning the whole session produce the same record: `findings: []`. mt#4196
 * spent 496 runs in the first state and the record could not say so. These fields are what
 * make a future zero interpretable without re-deriving it (mt#4235 SC4).
 */
export interface TranscriptSampling {
  /** `head-fallback` means nothing in the transcript carried prose; see the selector. */
  strategy: "text-bearing-even" | "head-fallback";
  /** Messages in the full stored transcript. */
  totalMessages: number;
  /** How many of those carried non-empty text. */
  textBearingMessages: number;
  /** How many were actually rendered into the prompt. */
  analyzedMessages: number;
  /** Fraction of the ANALYZED window resolving to empty text. The mt#4235 headline. */
  emptyTextRatio: number;
  /** Fraction of the analyzed window that fell back to the non-text marker (mt#4196). */
  nonTextRatio: number;
  /** Transcript position of the first analyzed message (`null` for an empty window). */
  firstIndex: number | null;
  /** Transcript position of the last analyzed message — with `firstIndex`, the span. */
  lastIndex: number | null;
}

/** Does this message carry any prose for the model to read? */
function hasRenderableText(msg: TranscriptMessage): boolean {
  return resolveMessageText(msg).text.trim() !== "";
}

/**
 * Choose which messages the model actually reads.
 *
 * ## The decision (mt#4235 SC1)
 *
 * **Filter to text-bearing messages, then take an evenly-spaced sample across the whole
 * filtered sequence, keeping the cap at 60.** Two independent defects made the previous
 * rule — `messages.slice(0, 60)` — unable to say anything about a session:
 *
 * 1. **Emptiness.** A tool-use-only assistant message holds a real block array with no
 *    `text` block, so extraction SUCCEEDS and returns `""`. Measured over 20 real stored
 *    transcripts, 75–93% of the head-60 window was empty in EVERY one of them — roughly 7
 *    of 60 slots carried prose. That is a property of what a coding-agent transcript IS,
 *    not of the sample.
 * 2. **Position.** These sessions run 41–2,805 messages, so the first 60 are handoff,
 *    skill-loading and command metadata. The analyzer model said so unprompted in 4 of the
 *    first 6 summaries of mt#4196's replay.
 *
 * Filtering alone fixes (1) and leaves (2) — the first 60 text-bearing messages of a
 * 2,800-message session are still its setup phase. Even spacing over the filtered sequence
 * fixes both, and spans first-to-last inclusive so the end of the session is always seen.
 *
 * ## Cost consequence, stated plainly
 *
 * The cap exists to keep a routine post-merge call cheap, so the change is priced against
 * it. The WORST-CASE prompt is unchanged: still at most 60 messages × 400 chars. The
 * TYPICAL prompt grows toward that ceiling, because slots that used to render as `""` now
 * carry prose — roughly 7 text-bearing messages becoming 60. That is a real increase in
 * transcript-body tokens against the previous typical case, and it buys the only thing
 * that makes the call worth making at all: a window that has something in it.
 *
 * Rejected alternatives, each against that same ceiling:
 * - **Raise the cap.** Multiplies the ceiling and leaves the emptiness ratio untouched —
 *   a 300-message window would be ~240 empty slots.
 * - **Segment long sessions, analyze each.** Multiplies CALLS per session, which is the
 *   one cost the cap was chosen to bound.
 * - **Text-bearing from the head only.** Fixes emptiness, keeps the preamble problem.
 *
 * Order is chronological throughout, and the rendered labels carry TRANSCRIPT positions
 * rather than window positions, so a gap in the numbering tells the model messages were
 * skipped — and `evidenceMessages` keeps pointing at real transcript rows.
 */
export function selectAnalysisWindow(messages: readonly TranscriptMessage[]): SelectedMessage[] {
  const textBearing: SelectedMessage[] = [];
  messages.forEach((message, index) => {
    if (hasRenderableText(message)) textBearing.push({ message, index });
  });

  // Degenerate: nothing in this transcript carries prose. Fall back to the head so the run
  // records what was actually there rather than sending an empty transcript — and so the
  // recorded `strategy` says which case produced the window.
  if (textBearing.length === 0) {
    return messages.slice(0, TRANSCRIPT_MESSAGE_CAP).map((message, index) => ({ message, index }));
  }

  if (textBearing.length <= TRANSCRIPT_MESSAGE_CAP) return textBearing;

  // Spans [0, length-1] inclusive rather than striding by `length / CAP`, which would
  // never pick the final message — the end of a session is where its decisions land.
  // `step > 1` whenever length > CAP, so the rounded picks are strictly increasing and
  // cannot duplicate.
  const step = (textBearing.length - 1) / (TRANSCRIPT_MESSAGE_CAP - 1);
  const sampled: SelectedMessage[] = [];
  for (let i = 0; i < TRANSCRIPT_MESSAGE_CAP; i++) {
    const pick = textBearing[Math.round(i * step)];
    if (pick !== undefined) sampled.push(pick);
  }
  return sampled;
}

/** Describe what a selection actually produced, for the run record. */
export function describeSampling(
  messages: readonly TranscriptMessage[],
  selected: readonly SelectedMessage[]
): TranscriptSampling {
  const windowMessages = selected.map((s) => s.message);
  const textBearingMessages = messages.reduce((n, m) => (hasRenderableText(m) ? n + 1 : n), 0);
  const emptyCount = windowMessages.reduce(
    (n, m) => (resolveMessageText(m).text.trim() === "" ? n + 1 : n),
    0
  );

  return {
    strategy: textBearingMessages === 0 ? "head-fallback" : "text-bearing-even",
    totalMessages: messages.length,
    textBearingMessages,
    analyzedMessages: selected.length,
    emptyTextRatio: selected.length === 0 ? 0 : emptyCount / selected.length,
    nonTextRatio: nonTextRatio(windowMessages),
    firstIndex: selected[0]?.index ?? null,
    lastIndex: selected[selected.length - 1]?.index ?? null,
  };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert post-mortem reviewer of AI-assisted software-engineering sessions. Given a session transcript, identify decisions the agent made that the spec did not dictate AND that are preference-bound (architectural style, default values, user-facing wording, library / dependency choice, abstraction shape, scope expansion).

A "preference-bound decision" is a choice where reasonable engineers could pick differently and the spec / instructions did not specify. Examples:
- Choosing one library over another when no spec criterion named one
- Setting a numeric default (timeout, retry count, threshold) without policy citation
- Renaming or coining a user-facing term
- Introducing a new abstraction (helper, interface, builder) that the spec did not request
- Expanding scope beyond the explicit ask

NOT preference-bound (do not surface):
- Decisions explicitly cited from CLAUDE.md, project rules, or the task spec
- Mechanical refactors / fixes that have only one correct shape
- Test additions for existing behavior
- Decisions where the spec named the answer

Findings DO NOT block merge — they feed a rule library. Lean toward surfacing borderline cases (medium severity); save "high" for clear unasked architectural decisions.

For each finding, return:
- label: short noun-phrase ("chose Redis over Postgres for queue backend")
- rationale: one or two sentences explaining why this is preference-bound and what authority would have resolved it
- severity: "low" | "medium" | "high" — confidence that this is genuinely unasked
- evidenceMessages: 1-based transcript-message indices that show the decision
- suggestedSignature: short signature string Surface 2 (diff signature detector) could use to catch this class — e.g. "ts:new-class:*Builder" or "config:default:timeout=*"

If the session has NO unasked directions, return an empty findings array.`;

/**
 * Render a single transcript message into prompt-friendly form.
 *
 * Content resolution goes through the shared resolver (mt#4196). This function used to
 * read `msg.content` directly, which is `undefined` on every stored row — so every message
 * rendered as `[non-text content]` and the model was asked to analyze a transcript of
 * nothing but markers. 496 recorded runs, 0 findings, no error on any of them.
 *
 * `index` is the message's 0-based position in the FULL transcript, rendered 1-based.
 * It used to coincide with the window position because the window was the head; since
 * mt#4235 the window is sampled, and the label must keep naming the real row so a
 * finding's `evidenceMessages` stay resolvable against the transcript.
 */
function summarizeMessage(msg: TranscriptMessage, index: number): string {
  // mt#4289: `Human` means the OPERATOR, not any `user`-role line. This detector
  // asks a model whether the agent took a direction nobody asked for, so a
  // harness-written line rendered as `Human:` is the exact input that
  // manufactures a request — and the compact summary is the worst case, being
  // ~15KB of model prose whose SUBJECT is what the operator asked for. Labelled
  // rather than dropped: the window is position-indexed against the full
  // transcript (see `index` above), and removing rows would desynchronize
  // `evidenceMessages`.
  const origin = msg.type === "user" ? classifyUserLineOrigin(msg) : null;
  const role =
    msg.type !== "user" ? "Agent" : origin === OPERATOR_ORIGIN ? "Human" : `Harness(${origin})`;
  const { text } = resolveMessageText(msg);

  const truncated =
    text.length > MESSAGE_TRUNCATE_CHARS
      ? `${safeTruncate(text, MESSAGE_TRUNCATE_CHARS, "head")}…`
      : text;
  return `[${index + 1}] ${role}: ${truncated}`;
}

/**
 * Describe to the MODEL how its window was chosen.
 *
 * Reads the recorded `strategy` rather than inferring from lengths. Inferring is what the
 * first version did — `selected.length < messages.length` — and it reported the head-fallback
 * path as "sampled evenly across the whole session, skipping messages with no text", which
 * is false twice over on that path: the window is the unfiltered HEAD and nothing was
 * skipped. A prompt that misdescribes its own sampling teaches the model to read gaps that
 * are not there, and on the one path where the transcript is degenerate it also hides that
 * fact. Caught in review on PR #3153.
 */
function describeSelection(sampling: TranscriptSampling): string {
  if (sampling.strategy === "head-fallback") {
    return (
      `first ${sampling.analyzedMessages} shown — no message in this transcript carried ` +
      `extractable text, so this is the head of the transcript, not a sample`
    );
  }
  if (sampling.analyzedMessages >= sampling.textBearingMessages) {
    return `all ${sampling.analyzedMessages} text-bearing messages shown`;
  }
  return (
    `${sampling.analyzedMessages} of ${sampling.textBearingMessages} text-bearing messages, ` +
    `sampled evenly across the whole session`
  );
}

/**
 * Build the user prompt body from an already-chosen window.
 *
 * Split from `buildUserPrompt` so `analyzeTranscript` can render and DESCRIBE the same
 * selection without running the selector twice — the run record must report the window
 * that was actually sent, not an equivalent one computed a second time. It takes the
 * `TranscriptSampling` for the same reason: the note the model reads and the note the record
 * carries are then the same fact, not two derivations that can disagree.
 */
function buildUserPromptFromSelection(
  selected: readonly SelectedMessage[],
  sampling: TranscriptSampling,
  context: AnalyzerContext
): string {
  const transcriptText = selected
    .map(({ message, index }) => summarizeMessage(message, index))
    .join("\n");

  const taskContext = context.taskId
    ? `Task: ${context.taskId}`
    : "Task: (none — session-level analysis)";

  return `${taskContext}
Session: ${context.sessionId}
Total messages: ${sampling.totalMessages} (${describeSelection(sampling)})
Message numbers below are positions in the FULL transcript, so gaps mean messages were skipped.

Transcript:
${transcriptText}

Identify any preference-bound decisions the agent made that the spec did not dictate. Return a JSON object with:
- findings: array of findings (empty if none)
- summary: brief one-sentence overall judgment of the session`;
}

/** Build the user prompt body from a transcript, selecting the window first. */
function buildUserPrompt(messages: TranscriptMessage[], context: AnalyzerContext): string {
  const selected = selectAnalysisWindow(messages);
  return buildUserPromptFromSelection(selected, describeSampling(messages, selected), context);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One analyzer run: the model's output plus how the window it read was chosen.
 *
 * Widens `AnalyzerOutput` rather than replacing it, so existing readers of `.findings` /
 * `.summary` are unaffected and `writeFindings` can record the sampling by passing the
 * same object through (mt#4235 SC4).
 */
export interface AnalyzerRunResult extends AnalyzerOutput {
  sampling: TranscriptSampling;
}

/** Context fed to the analyzer alongside the transcript. */
export interface AnalyzerContext {
  /** The session ID (Minsky session UUID). */
  sessionId: string;
  /** Optional task ID for task-scoped sessions. */
  taskId?: string;
}

/**
 * Lift an analyzer finding to a `DetectionSignal` shaped per mt#1574.
 *
 * The hook layer turns these into `AskIntent` via `signalToAskIntent` from
 * the shared infra; `direction.decide` is the suspected kind for unasked
 * preferences (the operator decides what to do — promote to seed, dismiss,
 * etc.).
 */
export function findingToDetectionSignal(
  finding: UnaskedDirectionFinding,
  context: AnalyzerContext
): DetectionSignal {
  return {
    detectorId: DETECTOR_ID,
    detectorVersion: DETECTOR_VERSION,
    suspectedKind: "direction.decide",
    severity: finding.severity,
    summary: finding.label,
    suggestedQuestion: finding.rationale,
    evidence: [
      {
        kind: "trajectory-step",
        payload: {
          sessionId: context.sessionId,
          taskId: context.taskId,
          messageIndices: finding.evidenceMessages,
        },
      },
      {
        kind: "diff-snippet",
        payload: {
          suggestedSignature: finding.suggestedSignature,
        },
      },
    ],
    contextRefs: context.taskId ? [{ kind: "task", ref: context.taskId }] : [],
  };
}

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

/**
 * Async post-mortem analyzer.
 *
 * Best-effort: callers must wrap in try/catch and treat failures as
 * "no findings produced." The hook layer uses that policy to keep the
 * post-merge path non-blocking even if the AI provider is unavailable.
 */
export class UnaskedDirectionAnalyzer {
  constructor(private readonly completionService: DefaultAICompletionService) {}

  /**
   * Analyze a transcript and return structured findings.
   *
   * @throws If the AI call fails or the response does not parse against the
   *         output schema. Callers must catch and degrade gracefully.
   */
  async analyzeTranscript(
    messages: TranscriptMessage[],
    context: AnalyzerContext
  ): Promise<AnalyzerRunResult> {
    if (messages.length === 0) {
      log.debug("UnaskedDirectionAnalyzer: empty transcript, returning empty findings");
      return {
        findings: [],
        summary: "No transcript messages available.",
        sampling: describeSampling(messages, []),
      };
    }

    // Selected once, then both rendered and described — so the recorded sampling is a
    // fact about the prompt that was sent, not about a second equivalent computation.
    const selected = selectAnalysisWindow(messages);
    const sampling = describeSampling(messages, selected);

    // mt#4196: the transcript this analyzer was handed rendered as nothing but
    // `[non-text content]` markers for 496 consecutive runs, and reported "no findings"
    // every time — the failure and a genuinely clean session produce identical output.
    // Measure the rendering before spending an LLM call on it, so a recurrence is loud.
    const blindness = detectBlindRendering(selected.map((s) => s.message));
    if (blindness.blind) {
      log.warn(
        "UnaskedDirectionAnalyzer: transcript rendered almost entirely as non-text — " +
          "findings from this run carry no information about the session (mt#4196)",
        {
          sessionId: context.sessionId,
          taskId: context.taskId,
          nonTextRatio: blindness.ratio,
          messageCount: blindness.messageCount,
        }
      );
    }

    const userPrompt = buildUserPromptFromSelection(selected, sampling, context);

    log.debug("UnaskedDirectionAnalyzer: analyzing transcript", {
      sessionId: context.sessionId,
      taskId: context.taskId,
      messageCount: messages.length,
      ...sampling,
    });

    const result = await this.completionService.generateObject({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      schema: analyzerOutputSchema,
      ...ANALYZER_REQUEST_DEFAULTS,
    });

    const output = result as AnalyzerOutput;

    log.debug("UnaskedDirectionAnalyzer: analysis complete", {
      sessionId: context.sessionId,
      findingsCount: output.findings.length,
      emptyTextRatio: sampling.emptyTextRatio,
      analyzedMessages: sampling.analyzedMessages,
    });

    return { ...output, sampling };
  }
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __TEST_ONLY = {
  buildUserPrompt,
  buildUserPromptFromSelection,
  describeSelection,
  summarizeMessage,
  hasRenderableText,
  analyzerOutputSchema,
  SYSTEM_PROMPT,
  ANALYZER_REQUEST_DEFAULTS,
  ANALYZER_MODEL,
  ANALYZER_PROVIDER,
  TRANSCRIPT_MESSAGE_CAP,
  MESSAGE_TRUNCATE_CHARS,
} as const;
