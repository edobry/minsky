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
import type { DetectionSignal } from "./types";
import { log } from "../../utils/logger";
import { safeTruncate } from "../../utils/safe-truncate";

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

/** Token cap; keeps the call cheap for routine post-merge runs. */
const MAX_TOKENS = 2000;

/** Cap transcript messages used in the prompt. */
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

/** Full analyzer output. */
const analyzerOutputSchema = z.object({
  findings: z.array(findingSchema),
  /** Quick summary of what the analyzer judged in this session. */
  summary: z.string(),
});

export type UnaskedDirectionFinding = z.infer<typeof findingSchema>;
export type AnalyzerOutput = z.infer<typeof analyzerOutputSchema>;

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

/** Render a single transcript message into prompt-friendly form. */
function summarizeMessage(msg: TranscriptMessage, index: number): string {
  const role = msg.type === "user" ? "Human" : "Agent";
  let content: string;

  if (typeof msg.content === "string") {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    content = (msg.content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join(" ");
  } else {
    content = "[non-text content]";
  }

  const truncated =
    content.length > MESSAGE_TRUNCATE_CHARS
      ? `${safeTruncate(content, MESSAGE_TRUNCATE_CHARS, "head")}…`
      : content;
  return `[${index + 1}] ${role}: ${truncated}`;
}

/** Build the user prompt body from a transcript. */
function buildUserPrompt(messages: TranscriptMessage[], context: AnalyzerContext): string {
  const sliced = messages.slice(0, TRANSCRIPT_MESSAGE_CAP);
  const transcriptText = sliced.map((msg, i) => summarizeMessage(msg, i)).join("\n");

  const taskContext = context.taskId
    ? `Task: ${context.taskId}`
    : "Task: (none — session-level analysis)";

  return `${taskContext}
Session: ${context.sessionId}
Total messages: ${messages.length} (analyzer sees first ${sliced.length})

Transcript:
${transcriptText}

Identify any preference-bound decisions the agent made that the spec did not dictate. Return a JSON object with:
- findings: array of findings (empty if none)
- summary: brief one-sentence overall judgment of the session`;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
  ): Promise<AnalyzerOutput> {
    if (messages.length === 0) {
      log.debug("UnaskedDirectionAnalyzer: empty transcript, returning empty findings");
      return { findings: [], summary: "No transcript messages available." };
    }

    const userPrompt = buildUserPrompt(messages, context);

    log.debug("UnaskedDirectionAnalyzer: analyzing transcript", {
      sessionId: context.sessionId,
      taskId: context.taskId,
      messageCount: messages.length,
    });

    const result = await this.completionService.generateObject({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      schema: analyzerOutputSchema,
      model: ANALYZER_MODEL,
      provider: ANALYZER_PROVIDER,
      temperature: 0.2,
      maxTokens: MAX_TOKENS,
    });

    const output = result as AnalyzerOutput;

    log.debug("UnaskedDirectionAnalyzer: analysis complete", {
      sessionId: context.sessionId,
      findingsCount: output.findings.length,
    });

    return output;
  }
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __TEST_ONLY = {
  buildUserPrompt,
  summarizeMessage,
  analyzerOutputSchema,
  ANALYZER_MODEL,
  ANALYZER_PROVIDER,
  TRANSCRIPT_MESSAGE_CAP,
  MESSAGE_TRUNCATE_CHARS,
} as const;
