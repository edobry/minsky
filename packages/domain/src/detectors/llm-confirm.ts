/**
 * LLM confirm stage — Rung 3 of the ADR-024 detection-mechanism ladder
 * (mt#3652).
 *
 * Runs ONLY on Rung-2 nominations, never on raw turns: Rung 2 supplies recall
 * (it nominated the mt#3341 admission that every regex family missed) and this
 * stage supplies the precision Rung 2 measurably lacks (0/3 on real turns,
 * mt#3408 `## Outcome`). A nomination the confirm stage endorses is allowed to
 * fire the retrospective reminder; an unendorsed nomination keeps the log-only
 * behavior mt#3408 shipped.
 *
 * The generative-Haiku mechanism was chosen by the offline pilot
 * (`scripts/pilot-rung3-confirm.ts`; numbers recorded in the mt#3652 spec's
 * `## Outcome`), per ADR-024 §Rung 3's requirement that the mechanism be
 * "decided by an offline pilot before committing, not by reuse convenience."
 *
 * Contract, mirrored from `embedding-nomination.ts` and relied on by every
 * consumer: `confirmNominations` NEVER throws and NEVER resolves later than
 * its budget. Every failure path returns `degraded: true` with an empty
 * confirmation list, so the caller falls back to its Rung-1 result and STILL
 * injects — ADR-024's fail-to-Rung-1 invariant forbids silent-skipping here.
 */

import { z } from "zod";
import { safeTruncate } from "@minsky/shared/safe-truncate";

/**
 * Budget for the whole confirm round-trip.
 *
 * The consuming guards declare `timeoutMs: 10000` in `.minsky/hooks/registry.ts`
 * and the Rung-2 nomination ahead of this stage is bounded at 2000ms
 * (`DEFAULT_NOMINATION_TIMEOUT_MS`), so 5000ms here keeps the full
 * rung-1 → rung-2 → rung-3 chain inside the guard budget with headroom for
 * transcript parsing. Enforced here at the caller — the same reasoning as
 * the nomination bound: it holds for every provider rather than only one
 * whose constructor happens to accept a timeout.
 *
 * Measured, not chosen (pilot run 1, mt#3652): a single-candidate confirm
 * lands at 1.2-2.8s, but a THREE-candidate turn took 3019ms and blew the
 * original 3000ms budget — the one recall loss in that run attributable to
 * the harness rather than the model.
 */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 5000;

/** Cost-efficient classifier model (mirrors AuthorshipJudge / unasked-direction-analyzer). */
export const CONFIRM_MODEL = "claude-haiku-4-5-20251001";

/** Provider for the confirm call. */
export const CONFIRM_PROVIDER = "anthropic";

/** Token cap; the verdict payload is small and the call runs per-turn. */
const MAX_TOKENS = 600;

/** Cap on turn text sent to the model; admissions live in prose, not in bulk. */
const MAX_TURN_CHARS = 6000;

export type ConfirmDegradedReason =
  | "provider-unconfigured"
  | "provider-error"
  | "timeout"
  /**
   * The provider returned a payload that failed the verdict schema. Distinct
   * from `provider-error` for the same reason `embedding-nomination.ts` splits
   * `provider-shape-mismatch` out: an exception is a provider that FAILED,
   * whereas this is a provider that SUCCEEDED while returning something
   * unusable — diagnosable from the calibration log only if recorded apart.
   */
  | "schema-mismatch";

/** A Rung-2 nomination handed to the confirm stage. */
export interface ConfirmCandidate {
  family: string;
  /** The segment the nominator scored highest — shown to the model as the anchor. */
  segment: string;
}

/** A candidate the model endorsed as a genuine admission. */
export interface Confirmation {
  family: string;
  segment: string;
  /** One-sentence model rationale; carried into the calibration record. */
  rationale: string;
}

export interface ConfirmResult {
  confirmations: Confirmation[];
  degraded: boolean;
  degradedReason?: ConfirmDegradedReason;
  degradedDetail?: string;
  /** Wall-clock of the provider round-trip; recorded for the SC6 latency ledger. */
  latencyMs?: number;
}

/**
 * Structural port over the one completion-service method this stage uses.
 * Tests inject a stub; `llm-confirm-factory.ts` supplies the real
 * `DefaultAICompletionService`, which satisfies this shape structurally.
 */
export interface ConfirmCompletionPort {
  generateObject(params: {
    messages: { role: "system" | "user"; content: string }[];
    schema: z.ZodTypeAny;
    model: string;
    provider: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<unknown>;
}

export interface ConfirmDeps {
  completionService: ConfirmCompletionPort;
}

// ---------------------------------------------------------------------------
// Verdict schema
// ---------------------------------------------------------------------------

const verdictSchema = z.object({
  verdicts: z.array(
    z.object({
      family: z.string(),
      isGenuineAdmission: z.boolean(),
      rationale: z.string(),
    })
  ),
});

type VerdictOutput = z.infer<typeof verdictSchema>;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * The system prompt carries the discrimination Rung 2's embeddings measurably
 * cannot make (mt#3408: sentence embeddings capture topic and
 * first-person-process register, not the admission/non-admission distinction).
 * The negative examples are mt#3408's three hand-classified false positives,
 * verbatim — the exact boundary the pilot measures against.
 */
const SYSTEM_PROMPT = `You classify whether an AI coding agent's output turn contains a GENUINE process-failure admission — the agent acknowledging that its own approach, reasoning, or process failed — as opposed to ordinary work narration.

You are given the turn text and one or more candidate families a cheap similarity stage nominated. For EACH candidate family, decide whether the turn genuinely expresses that family:

- R1 (apology / contrition): the agent admits an error in its OWN approach, method, or reasoning. "I conflated two things", "that was my fault", "I reasoned from one observation instead of checking the system". Correcting a fact about the WORLD ("I was wrong about the push failures — they weren't timeouts") is NOT R1: revising factual beliefs on new evidence is normal work.
- R2 (operational self-explanation): the agent explains a failure in its own process. "I didn't think it through", "I went straight to the fix without checking the cause".
- R3 (future-behavior commitment): the agent promises to behave differently in the future. "Going forward I'll check that first", "next time I will verify before claiming".
- R4 (decline-to-retrospective): the agent declares it will skip retrospective/root-cause analysis. "I'll just skip the retrospective", "this is a one-off". A reasoned RECOMMENDATION to skip, with justification, is NOT R4.
- R5 (finding-reframing): the agent reports a finding that implies its own prior approach was wrong, without first-person failure language. "The approach I was using turns out to be a documented anti-pattern."

NOT admissions — classify isGenuineAdmission=false:
- Ordinary work narration, however first-person and process-flavored: "Dereferencing it.", "Investigation is complete and it changed the fix.", "Probing both for live claims before I touch either — I'd rather not repeat the last collision."
- Statements of intent or plan for CURRENT work ("I'll implement the fix now") — R3 is about commitments to future behavioral change after a failure, not ordinary next-step narration.
- Quoted or discussed admission phrases — the agent describing, documenting, or analyzing detector patterns rather than admitting anything.
- Factual corrections about the world or the codebase.

Return one verdict per candidate family. Keep each rationale to ONE short sentence (under 15 words) — verdict payloads are latency-bounded. When uncertain, classify false — the cost of a false confirmation is an unwarranted process interruption.`;

function buildUserPrompt(turnText: string, candidates: ConfirmCandidate[]): string {
  const lines: string[] = [
    "Candidate families nominated for this turn:",
    ...candidates.map((c) => `- ${c.family}: nominated on the segment "${c.segment}"`),
    "",
    "Turn text:",
    "---",
    turnText.length > MAX_TURN_CHARS
      ? `${safeTruncate(turnText, MAX_TURN_CHARS, "head")}…`
      : turnText,
    "---",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

/**
 * Ask the model to endorse or reject each nominated candidate.
 *
 * Never throws. An empty candidate list short-circuits without a provider
 * call. Verdicts for families that were not in the candidate list are
 * discarded — the model cannot ADD families, only endorse nominated ones.
 */
export async function confirmNominations(
  turnText: string,
  candidates: ConfirmCandidate[],
  deps: ConfirmDeps,
  opts?: { timeoutMs?: number }
): Promise<ConfirmResult> {
  if (candidates.length === 0) {
    return { confirmations: [], degraded: false };
  }

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const started = Date.now();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"__timeout__">((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout("__timeout__"), timeoutMs);
  });

  try {
    const raced = await Promise.race([
      deps.completionService.generateObject({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(turnText, candidates) },
        ],
        schema: verdictSchema,
        model: CONFIRM_MODEL,
        provider: CONFIRM_PROVIDER,
        temperature: 0,
        maxTokens: MAX_TOKENS,
      }),
      timeoutPromise,
    ]);

    if (raced === "__timeout__") {
      return {
        confirmations: [],
        degraded: true,
        degradedReason: "timeout",
        degradedDetail: `confirm call exceeded ${timeoutMs}ms`,
        latencyMs: Date.now() - started,
      };
    }

    const parsed = verdictSchema.safeParse(raced);
    if (!parsed.success) {
      return {
        confirmations: [],
        degraded: true,
        degradedReason: "schema-mismatch",
        degradedDetail: parsed.error.issues[0]?.message,
        latencyMs: Date.now() - started,
      };
    }

    const nominated = new Map(candidates.map((c) => [c.family, c]));
    const confirmations: Confirmation[] = [];
    for (const verdict of (parsed.data as VerdictOutput).verdicts) {
      const candidate = nominated.get(verdict.family);
      if (!candidate || !verdict.isGenuineAdmission) continue;
      confirmations.push({
        family: verdict.family,
        segment: candidate.segment,
        rationale: verdict.rationale,
      });
      // One confirmation per family, even if the model repeats itself.
      nominated.delete(verdict.family);
    }

    return { confirmations, degraded: false, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      confirmations: [],
      degraded: true,
      degradedReason: "provider-error",
      degradedDetail: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Test-only exports (prompt construction is behavior worth pinning). */
export const __TEST_ONLY = {
  SYSTEM_PROMPT,
  buildUserPrompt,
  verdictSchema,
  MAX_TURN_CHARS,
} as const;
