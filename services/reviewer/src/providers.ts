/**
 * Model-provider abstraction for the reviewer service.
 *
 * The reviewer deliberately routes to a different model family than the
 * implementer. This module wraps each supported provider in a uniform
 * interface so the rest of the service doesn't need to know which provider
 * is in use.
 *
 * See the Structural Review paper, section "Nine levers — lever 2: Model
 * diversity" for why this is load-bearing rather than a nice-to-have.
 */

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import type * as OpenAICore from "openai/core";
import { REVIEWER_CALLTIME_ENV_VAR_NAMES, type ReviewerConfig } from "./config";
import type { ReviewerToolContext, DirEntry, ReadFileResult } from "./tools";
import {
  OUTPUT_TOOL_DEFINITIONS,
  parseToolCall,
  parseToolCallExpanded,
  BATCHED_FINDINGS_TOOL,
  BATCHED_TOOL_EXPANSIONS,
  type ReviewToolCall,
} from "./output-tools";
import { withTimeout, TimeoutError } from "./with-timeout";
import { log } from "./logger";
import { safeTruncate } from "@minsky/shared/safe-truncate";
import { createHash } from "node:crypto";
import {
  evaluateConcludeReviewCall,
  DEFAULT_MAX_CONCLUDE_REVIEW_REJECTIONS,
} from "./conclude-review-guard";
import { evaluateSubmitFindingCall, markUntrackedDeferral } from "./resolution-note-guard";
import {
  evaluateForcedFindingsPass,
  buildForcedFindingsUserMessage,
  describeForcedFindingsOutcome,
} from "./forced-findings-guard";

/**
 * Default model timeout used when callOpenAIWithClient is called without an
 * explicit value. Matches the production default in `config.ts`
 * (`REVIEWER_MODEL_TIMEOUT_MS`); kept in sync manually because the test
 * surface that calls callOpenAIWithClient directly doesn't load config.
 *
 * mt#1086.
 */
const DEFAULT_MODEL_TIMEOUT_MS = 120_000;

/**
 * Default retry-on-timeout ceiling for the openai.chat.completions.create.toolloop
 * inner call. mt#1969: when a single inner SDK call times out at the primary
 * `timeoutMs` cap, we retry ONCE with this ceiling.
 *
 * mt#2083: raised from 90s to 120s (matching the primary timeout). The original
 * 90s was designed to "fail fast on genuinely-stuck" retries, but empirical
 * latency data shows normal gpt-5 reviews take ~80-100s — the 90s retry was
 * shorter than healthy-case latency, causing retries to fail even when the
 * provider-side transient had cleared. Matching the primary timeout gives the
 * retry the same budget as the first attempt.
 *
 * Tunable at process-env load time via the TOOLLOOP_RETRY_TIMEOUT_MS entry in
 * config.ts's REVIEWER_CALLTIME_ENV_VAR_NAMES, which is where the operator-
 * facing variable name lives (mt#4619 — naming it here too would be a second
 * spelling that a rename leaves stale).
 */
const DEFAULT_TOOLLOOP_RETRY_TIMEOUT_MS = 120_000;

/**
 * Read the toolloop-retry config from process env at call time. Defaults match
 * the empirically-grounded values above. mt#1969.
 */
/**
 * Parse the toolloop-retry flag (mt#1969).
 *
 * Default TRUE, and deliberately a DIFFERENT rule from the default-OFF
 * behavioural flags parsed by `config-fingerprint.ts` — which is why it is
 * defined here beside its consumer and exported for the fingerprint to reuse,
 * rather than re-derived there against the wrong default. mt#4556.
 */
export function parseToolloopRetryEnabled(raw: string | undefined): boolean {
  return raw === undefined ? true : raw === "true" || raw === "1";
}

function resolveToolloopRetryConfig(): { enabled: boolean; retryTimeoutMs: number } {
  // Names come from config.ts's registry, never spelled here (mt#4619) — a
  // typo'd property is a type error; a typo'd string would read no env var.
  const enabled = parseToolloopRetryEnabled(
    process.env[REVIEWER_CALLTIME_ENV_VAR_NAMES.TOOLLOOP_RETRY_ON_TIMEOUT]
  );
  const rawMs = process.env[REVIEWER_CALLTIME_ENV_VAR_NAMES.TOOLLOOP_RETRY_TIMEOUT_MS];
  const parsedMs = rawMs ? parseInt(rawMs, 10) : NaN;
  const retryTimeoutMs =
    Number.isFinite(parsedMs) && parsedMs > 0 ? parsedMs : DEFAULT_TOOLLOOP_RETRY_TIMEOUT_MS;
  return { enabled, retryTimeoutMs };
}

export interface ToolloopRetryResult<T> {
  result: T;
  retriedOnTimeout: boolean;
}

/**
 * Run the toolloop SDK call with a single retry on TimeoutError (mt#1969).
 *
 * Behavior:
 *   - First attempt uses the caller-supplied `primaryTimeoutMs` (production
 *     default 120s from config.ts → DEFAULT_MODEL_TIMEOUT_MS).
 *   - On TimeoutError AND retry-enabled (the TOOLLOOP_RETRY_ON_TIMEOUT entry
 *     in config.ts's REVIEWER_CALLTIME_ENV_VAR_NAMES, default "true"), emits a
 *     `toolloop.timeout_retry` log line and retries once with that registry's
 *     TOOLLOOP_RETRY_TIMEOUT_MS entry (default 90s).
 *   - If the retry also times out OR retry is disabled, the TimeoutError
 *     propagates to the toolloop caller and surfaces in logs as the existing
 *     `sweeper.retrigger_failed` / equivalent shape.
 *
 * Why retry with a SMALLER ceiling, not a larger one: the goal is to recover
 * transient provider-side slowness, not mask sustained slowness. A larger
 * retry ceiling would just inflate wall-clock on hopeless retries. A smaller
 * ceiling preserves the "fail fast on genuinely-stuck" property while
 * giving transient hiccups a second chance.
 *
 * Non-TimeoutError throws (e.g., HTTP 4xx/5xx from OpenAI, schema validation,
 * etc.) propagate without retry — they aren't timeout-class issues and the
 * retry doesn't address them.
 */
export async function callToolloopWithRetry<T>(
  op: string,
  round: number,
  primaryTimeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<ToolloopRetryResult<T>> {
  try {
    const result = await withTimeout(op, primaryTimeoutMs, fn);
    return { result, retriedOnTimeout: false };
  } catch (err) {
    if (!(err instanceof TimeoutError)) throw err;
    const { enabled, retryTimeoutMs } = resolveToolloopRetryConfig();
    if (!enabled) throw err;
    log.warn("toolloop.timeout_retry", {
      event: "toolloop.timeout_retry",
      op,
      round,
      primary_timeout_ms: primaryTimeoutMs,
      retry_timeout_ms: retryTimeoutMs,
    });
    const result = await withTimeout(`${op}.retry`, retryTimeoutMs, fn);
    return { result, retriedOnTimeout: true };
  }
}

export interface ReviewUsage {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  /**
   * Cached input tokens (OpenAI prompt_tokens_details.cached_tokens); mt#2721.
   *
   * REQUIRED, unlike its siblings (mt#3665). Cached input is billed at 0.1x, so
   * an omitted count is not a harmless gap — `computeCostUsd` has to price the
   * whole prompt at the full rate, overstating the call ~4x. While this was
   * optional, `buildChunkedReview` silently omitted it for 25 days and roughly
   * half of all recorded reviewer spend was attributed to calls priced as
   * 0%-cached whose non-chunked neighbours ran 77-92% cached.
   *
   * A provider with no prompt caching sets 0 — that is a real observation and
   * prices correctly. Requiredness is what makes the distinction between "no
   * cache" and "forgot to thread it" a compile error rather than a billing one.
   */
  cachedTokens: number;
  totalTokens?: number;
}

export interface TimingData {
  roundLatenciesMs: number[];
  timeoutCount: number;
  retryOutcomes: string[];
}

/**
 * `retryOutcomes` entry for a round whose timeout was NOT recovered by the
 * mt#1969 single retry — the review is about to throw.
 *
 * This string has been written since mt#2088 and read by nothing: the value was
 * pushed onto a local array one statement before `throw`, so it died with the
 * stack frame. 30 days of `review_timing` therefore contained zero rows carrying
 * it while the service produced at least five unrecovered timeouts on
 * 2026-08-18 alone (mt#4281).
 */
export const TIMEOUT_UNRECOVERED = "timeout-unrecovered";

/**
 * Carries partial timing out of a review that THREW (mt#4281).
 *
 * A non-enumerable symbol property rather than a field on `TimeoutError`:
 * `TimeoutError` lives in `with-timeout.ts` and is shared with non-reviewer
 * callers (`merge-state-sweeper.ts`), so reviewer-specific timing has no
 * business in its shape. Non-enumerable so the attachment cannot alter how the
 * error serializes into a log line.
 */
const PARTIAL_TIMING = Symbol.for("minsky.reviewer.partialTiming");

/**
 * Attach salvaged timing to an in-flight error and return it for `throw`.
 *
 * The arrays are COPIED. The caller's are still live locals at the throw site,
 * and a carrier that aliased them would report whatever they held later rather
 * than what they held at the failure.
 */
export function attachPartialTiming<E>(err: E, timing: TimingData): E {
  if (err === null || typeof err !== "object") return err;

  // PR #3136 R1 (BLOCKING, correct): `Object.defineProperty` THROWS on a
  // frozen, sealed, or otherwise non-extensible object. Every caller is
  // `throw attachPartialTiming(err, …)` inside a catch, so an unguarded throw
  // here would REPLACE the original error with a TypeError — masking the actual
  // failure and defeating this task's own criterion that recording must not
  // alter control flow. Losing the timing is a bad outcome; losing the ERROR is
  // a far worse one, so this degrades to returning `err` untouched.
  //
  // Both a pre-check and a catch: `isExtensible` covers the common frozen case
  // without relying on an exception, and the catch covers the rest
  // (a pre-existing non-configurable property under the same key, a hostile
  // Proxy's `defineProperty` trap) rather than enumerating them.
  if (!Object.isExtensible(err)) {
    logPartialTimingAttachFailure("non-extensible-error");
    return err;
  }
  try {
    Object.defineProperty(err, PARTIAL_TIMING, {
      value: {
        roundLatenciesMs: [...timing.roundLatenciesMs],
        timeoutCount: timing.timeoutCount,
        retryOutcomes: [...timing.retryOutcomes],
      } satisfies TimingData,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  } catch {
    logPartialTimingAttachFailure("define-property-threw");
  }
  return err;
}

/**
 * Report a dropped timing attachment.
 *
 * Silence here would reproduce, in the recovery path, the exact defect this
 * task exists to fix: a row that never gets written and nothing saying why. A
 * reader seeing an unrecovered-timeout row with empty timing needs to be able
 * to tell "no timing was accumulated" from "timing was accumulated and could
 * not be attached".
 */
function logPartialTimingAttachFailure(reason: string): void {
  log.warn("reviewer.partial_timing_attach_failed", {
    event: "reviewer.partial_timing_attach_failed",
    reason,
  });
}

/** Read back timing attached by {@link attachPartialTiming}; undefined if absent. */
export function extractPartialTiming(err: unknown): TimingData | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const carried = (err as Record<symbol, unknown>)[PARTIAL_TIMING];
  if (carried === null || typeof carried !== "object") return undefined;
  const candidate = carried as Partial<TimingData>;
  if (!Array.isArray(candidate.roundLatenciesMs)) return undefined;
  if (typeof candidate.timeoutCount !== "number") return undefined;
  if (!Array.isArray(candidate.retryOutcomes)) return undefined;
  return candidate as TimingData;
}

export interface ReviewOutput {
  text: string;
  tokensUsed?: number;
  usage?: ReviewUsage;
  provider: ReviewerConfig["provider"];
  model: string;
  /**
   * Structured output tool calls emitted by the model during review. Each
   * entry is a parsed, validated discriminated-union call: submit_finding,
   * submit_inline_comment, submit_spec_verification, submit_documentation_impact,
   * submit_thread_resolve, or conclude_review.
   * Always an array — never undefined; empty when no output tools were called.
   */
  toolCalls: ReviewToolCall[];
  timing?: TimingData;
  /**
   * mt#2828: outcome of the conclude_review forcing-function guard for this
   * review. Present only on the OpenAI tool-use path (undefined on the
   * no-tools path and for other providers, which never call conclude_review
   * as a tool). `rejectionCount` is how many incoherent
   * `conclude_review(REQUEST_CHANGES)` calls (zero BLOCKING findings) were
   * rejected back to the model this review; `boundExhausted` is true when an
   * incoherent call was ultimately let through after exhausting the bound
   * (see conclude-review-guard.ts), meaning the mt#2685 recovery pass had to
   * run as backstop.
   */
  concludeReviewGuard?: { rejectionCount: number; boundExhausted: boolean };
  /**
   * mt#3547: what the tool-use loop actually did. Present only on the OpenAI
   * tool-use path (the only path with a loop). Exists because round count and
   * "did the model stop on its own?" are not otherwise recoverable by a caller:
   * `toolCalls` includes calls the post-loop forced passes supplied, so a
   * conclude_review in that array does NOT mean the model emitted one in-loop.
   *
   * `roundsUsed` counts main-loop rounds only, excluding the forced passes —
   * the same quantity `timing.roundLatenciesMs.length` carries, named here so
   * consumers do not have to know that coincidence.
   */
  toolLoop?: ToolLoopDiagnostics;
}

/**
 * Observed behavior of one tool-use loop (mt#3547).
 *
 * The reviewer's cost is dominated by round count, and its long-standing defect
 * is that the model does not emit `conclude_review` in-loop — so a forced
 * post-loop pass has to extract the verdict. Both facts were previously
 * observable only in logs; the round-budget replay harness needs them as data.
 */
export interface ToolLoopDiagnostics {
  /** Main-loop rounds actually run (excludes the post-loop forced passes). */
  roundsUsed: number;
  /** The cap in force for this run, so a consumer can test "did it exhaust?". */
  maxRounds: number;
  /**
   * True when the model emitted `conclude_review` itself during the loop —
   * i.e. the stop signal worked and no forced pass was needed. This is the
   * metric mt#3547 moves; `false` here is the ~15-month-old defect.
   */
  concludedInLoop: boolean;
  /**
   * 1-based round on which the model first emitted `conclude_review`, or null
   * if it never did in-loop.
   *
   * Distinguishes two behaviors that `concludedInLoop` alone conflates when the
   * loop also runs to the cap: concluding on the LAST tool-capable round (the
   * model paced itself to the deadline) versus concluding EARLY and continuing
   * to call tools afterward (conclude_review is not acting as a stop signal at
   * all). They imply different fixes, so measure rather than infer.
   */
  concludedAtRound: number | null;
  /**
   * Which forced-pass branch fired, or null when none did (`concludedInLoop`
   * true). Mirrors the `gate_branch` discriminator on the
   * `reviewer.conclude_review_reminder` audit log.
   */
  forcedConcludeGateBranch: "emitted_no_conclude" | "emitted_nothing" | null;
}

/**
 * Per-call overrides for the reviewer model invocation.
 *
 * Currently only `reasoningEffort` is configurable; it maps to OpenAI's
 * `reasoning_effort` parameter on o-series and gpt-5 reasoning models.
 * Google and Anthropic paths have no equivalent knob and ignore this option.
 *
 * Used primarily by the retry path in `review-worker.ts`: when a reasoning
 * model exhausts its output budget on hidden reasoning tokens, a second
 * attempt with `reasoningEffort: "low"` shifts the budget toward visible
 * output and usually succeeds.
 */
export interface CallReviewerOptions {
  reasoningEffort?: ReasoningEffort;
}

/**
 * Whether the given OpenAI model supports the `reasoning_effort` parameter.
 *
 * OpenAI's `reasoning_effort` parameter is documented as "o-series models
 * only" — the API returns 400 when passed to non-reasoning models (gpt-4o,
 * gpt-4, gpt-3.5, etc.). As of 2026-04, `gpt-5` is also a reasoning model
 * and accepts the field.
 *
 * Exported for tests.
 */
export function isReasoningModel(model: string): boolean {
  // o1, o3, o4 and future o-series reasoning models
  if (/^o\d/.test(model)) return true;
  // gpt-5 family (gpt-5, gpt-5-turbo, gpt-5-mini, etc.)
  if (/^gpt-5(\b|-)/.test(model)) return true;
  return false;
}

/**
 * The values OpenAI's `reasoning_effort` parameter accepts.
 *
 * The ARRAY is the source of truth and the type is derived from it, rather
 * than the other way round: consumers that need to VALIDATE a runtime string
 * (the eval runner's `--model` effort suffix) would otherwise hand-enumerate
 * the same values, and a widening here — mt#3526 proposes adding `"minimal"` —
 * would leave them silently rejecting a value this module accepts.
 */
export const REASONING_EFFORTS = ["low", "medium", "high"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * The `reasoning_effort` a call resolves to, or `null` when none is sent.
 *
 * There is no reasoning-effort SETTING — the value is computed per call, which
 * is why this is a function rather than a config field. `callOpenAIWithClient`
 * below is the one caller that acts on it; `config-fingerprint.ts` (mt#4556) is
 * the one caller that RECORDS it, and both go through here so a recorded effort
 * cannot disagree with the effort actually sent.
 *
 * `null` when the provider is not OpenAI (Google and Anthropic have no
 * equivalent knob and ignore the option) or when the model takes no
 * `reasoning_effort` parameter — passing it to a non-reasoning model returns
 * 400 from the API, which is why the parameter is omitted rather than defaulted.
 *
 * The default varies by path: `"low"` when tools are active, so budget goes to
 * tool-call JSON rather than hidden CoT, and `"medium"` for single-turn
 * no-tools reviews (mt#1232). A caller-supplied override always wins — the
 * retry path uses it to force `"low"` (mt#1131).
 */
export function resolveReasoningEffort(
  provider: string,
  model: string,
  toolsActive: boolean,
  override?: ReasoningEffort
): ReasoningEffort | null {
  if (provider !== "openai") return null;
  if (!isReasoningModel(model)) return null;
  return override ?? (toolsActive ? "low" : "medium");
}

// TODO(mt#1126 follow-up): add Gemini function-calling implementation
// TODO(mt#1126 follow-up): add Anthropic tool-use implementation
// TODO(mt#1126 follow-up): add search and spec-fetch tools

export async function callReviewer(
  config: ReviewerConfig,
  systemPrompt: string,
  userPrompt: string,
  tools?: ReviewerToolContext,
  options?: CallReviewerOptions
): Promise<ReviewOutput> {
  switch (config.provider) {
    case "openai":
      return callOpenAI(config, systemPrompt, userPrompt, tools, options);
    case "google":
      return callGoogle(config, systemPrompt, userPrompt, tools);
    case "anthropic":
      return callAnthropic(config, systemPrompt, userPrompt, tools);
  }
}

/** Maximum number of tool-use rounds before forcing the model to finalize. */
const MAX_TOOL_ROUNDS = 10;

/**
 * How many tool-capable rounds remain when the budget notice switches from
 * reporting the count to telling the model to wrap up (mt#3547).
 *
 * Two, not one: `conclude_review` is a tool call, and the final round passes no
 * tools (see the `isLastRound` guard in the loop), so a model that waits for
 * "one round left" to start finalizing has already lost the ability to emit
 * findings and conclude in separate rounds.
 */
const ROUND_BUDGET_WRAP_UP_THRESHOLD = 2;

/**
 * The per-round budget notice appended after each round's tool results
 * (mt#3547).
 *
 * Structural half of "give the reviewer permission to stop". The prompt grants
 * the permission once, at the top, where it competes with the coverage mandates
 * for attention; this restates the remaining budget at the only moment the
 * model can act on it. Prose mandates have failed twice in this service and
 * been replaced by structural mechanisms both times (PR #614 → a coverage gate;
 * mt#2828 → a tool-call-boundary rejection), so the wording alone is not
 * trusted to carry this.
 *
 * APPEND-ONLY, deliberately: it is pushed after the round's tool results and no
 * earlier message is ever rewritten. An in-place edit would invalidate the
 * OpenAI prompt-cache prefix from the edit point on, which at the reviewer's
 * ~0.82 cache-hit rate costs roughly 10x what it saves (mem#806).
 *
 * @param roundIndex Zero-based index of the round that just completed.
 * @param maxRounds  The cap in force (`MAX_TOOL_ROUNDS`).
 */
export function buildRoundBudgetNotice(roundIndex: number, maxRounds: number): string {
  const roundsDone = roundIndex + 1;
  // The last round is text-only, so tool-capable rounds are indices
  // 0..maxRounds-2 — one fewer than the cap.
  const toolCapableRemaining = Math.max(0, maxRounds - 1 - roundsDone);

  const header = `[TOOL BUDGET] Round ${roundsDone} of ${maxRounds} complete. ${toolCapableRemaining} tool-capable round(s) remain.`;

  if (toolCapableRemaining === 0) {
    return (
      `${header} This was your LAST round that could emit tool calls — the next round has no tools, ` +
      `so no further findings or conclude_review can be recorded from it. ` +
      `Nothing you were saving for later will be captured.`
    );
  }

  if (toolCapableRemaining <= ROUND_BUDGET_WRAP_UP_THRESHOLD) {
    return (
      `${header} Stop opening new lines of investigation now. Emit any findings you are still holding, ` +
      `then call conclude_review. If you did not cover everything, say so in the summary — ` +
      `an honest, bounded review is the goal, not an exhaustive one. Remember conclude_review is ` +
      `itself a tool call and cannot be emitted after your tool rounds run out.`
    );
  }

  return (
    `${header} Spend them on the verification the constitution asks for, then conclude on your own — ` +
    `you do not need to exhaust the budget to be done.`
  );
}

/**
 * Envelope shapes returned to the model for each tool call (mt#1216).
 *
 * Previously, tool results were returned as either a raw string (for text),
 * a JSON-stringified array (for directory listings), or the literal string
 * `"null"` for not-found — requiring the model to disambiguate a missing
 * file from a file whose content is the four characters `null`. The envelope
 * disambiguates structurally: `ok: true/false`, with domain fields on the
 * success branch and `error` on the failure branch.
 */
export type ReadFileEnvelope =
  | { ok: true; content: string; truncated: boolean; window?: ReadFileWindow }
  | { ok: true; content: string; truncated: boolean; binary: true; size: number }
  | { ok: false; error: string };

/**
 * Describes the slice of a file the model was actually shown (mt#3544).
 *
 * Present only when the file exceeded a cap and was windowed. Its absence means
 * the model saw the whole file — so the model never has to guess whether it is
 * looking at a complete picture.
 */
export interface ReadFileWindow {
  /** 1-based line number of the first line shown. */
  startLine: number;
  /** 1-based line number of the last line shown. */
  endLine: number;
  /** Total lines in the file. */
  totalLines: number;
  /** Offset to pass back to `read_file` for the next window; absent at EOF. */
  nextOffset?: number;
}

/**
 * Line cap for a single `read_file` result (mt#3544).
 *
 * Before this cap, `readFileAtRef` returned whole files uncapped and every
 * result was appended to the tool-loop conversation and RESENT on each of up to
 * 10 subsequent rounds. Sized from the external precedent cluster — SWE-agent
 * windows at ~100 lines/turn, Pi/OpenClaw at 2,000 lines or 50KB, Claude Code
 * at a 256KB gate then a 25K-token budget. 2,000 lines is the permissive end of
 * that range: it leaves ordinary source files untouched (so the common case is
 * byte-identical to pre-cap behavior) while bounding the pathological reads that
 * dominate the long tail of expensive reviews.
 */
export const MAX_READ_FILE_LINES = 2000;

/**
 * Character cap for a single `read_file` result, applied alongside the line cap
 * so one minified or generated line cannot blow the budget on its own — the
 * same single-huge-line gap mt#2243 closed for the chunked path's per-file
 * patches. 50,000 chars is ~16.7K tokens at `chunked-review.ts`'s
 * `CHARS_PER_TOKEN = 3` convention.
 */
export const MAX_READ_FILE_CHARS = 50_000;

/**
 * Apply the line/char window to a text file's content.
 *
 * Returns the original content untouched when it fits under both caps — the
 * uncapped path must stay byte-identical, since most reads are ordinary source
 * files and a cap that perturbs them would be a silent behavior change.
 *
 * Pure; exported for tests.
 */
export function applyReadFileWindow(
  content: string,
  offset: number
): { content: string; window?: ReadFileWindow } {
  const lines = content.split("\n");
  const totalLines = lines.length;
  // A 1-based offset; anything below 1 is treated as "from the top" rather than
  // rejected, since the model supplies it and an off-by-one should degrade to
  // the obvious reading rather than an error.
  const startIndex = Math.max(0, offset - 1);

  // Whole file requested from the top and it fits: return it verbatim.
  if (
    startIndex === 0 &&
    totalLines <= MAX_READ_FILE_LINES &&
    content.length <= MAX_READ_FILE_CHARS
  ) {
    return { content };
  }

  if (startIndex >= totalLines) {
    return {
      content: "",
      window: { startLine: totalLines, endLine: totalLines, totalLines },
    };
  }

  let windowed = lines.slice(startIndex, startIndex + MAX_READ_FILE_LINES);
  // Char cap second: drop whole lines from the end until the slice fits, so the
  // result never ends mid-line. A single line longer than the cap is kept (and
  // hard-sliced below) rather than dropped — losing it entirely would be worse.
  while (windowed.length > 1 && windowed.join("\n").length > MAX_READ_FILE_CHARS) {
    windowed = windowed.slice(0, -1);
  }
  let text = windowed.join("\n");
  if (text.length > MAX_READ_FILE_CHARS) {
    // safeTruncate, not slice: a raw cut can land between a high and low
    // surrogate and hand the model a broken character (mt#1615).
    text = safeTruncate(text, MAX_READ_FILE_CHARS, "head");
  }

  const endLine = startIndex + windowed.length;
  const hasMore = endLine < totalLines;
  return {
    content: text,
    window: {
      startLine: startIndex + 1,
      endLine,
      totalLines,
      ...(hasMore ? { nextOffset: endLine + 1 } : {}),
    },
  };
}

export type ListDirectoryEnvelope =
  | { ok: true; entries: DirEntry[] }
  | { ok: false; error: string };

/**
 * Map a ReadFileResult from `readFileAtRef` to the JSON envelope the model
 * sees. Exported for tests.
 */
export function buildReadFileEnvelope(result: ReadFileResult | null, offset = 1): ReadFileEnvelope {
  if (result === null) return { ok: false, error: "not_found" };
  if (result.kind === "binary") {
    const suffix = result.truncated ? ", truncated snippet" : "";
    return {
      ok: true,
      content: `[BINARY FILE: ${result.size} bytes${suffix}, not decoded]`,
      truncated: result.truncated,
      binary: true,
      size: result.size,
    };
  }
  // mt#3544: window the text so an uncapped whole-file read cannot enter the
  // conversation and be resent on every later round. The window is reported
  // structurally AND announced in-band below — a silent truncation is the
  // documented anti-pattern (the model then answers confidently from a partial
  // file with no signal that it was partial).
  const { content, window } = applyReadFileWindow(result.content, offset);
  if (window === undefined) {
    return { ok: true, content, truncated: result.truncated };
  }
  const continuation =
    window.nextOffset !== undefined
      ? ` Call read_file again with offset=${window.nextOffset} to continue.`
      : " This is the end of the file.";
  const notice =
    `[Showing lines ${window.startLine}-${window.endLine} of ${window.totalLines}.` +
    `${continuation}]\n`;
  return {
    ok: true,
    content: `${notice}${content}`,
    truncated: result.truncated,
    window,
  };
}

/**
 * Map a `listDirectoryAtRef` result to the JSON envelope the model sees.
 * Exported for tests.
 */
export function buildListDirectoryEnvelope(entries: DirEntry[] | null): ListDirectoryEnvelope {
  if (entries === null) return { ok: false, error: "not_found" };
  return { ok: true, entries };
}

/** OpenAI function definitions for the reviewer read-only tools. */
const REVIEWER_TOOL_DEFINITIONS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        'Read the content of a file from the PR\'s HEAD ref. Returns a JSON envelope: {"ok":true,"content":string,"truncated":boolean} for text, {"ok":true,"content":string,"truncated":false,"binary":true,"size":number} for binary (not decoded), {"ok":false,"error":"not_found"} when the file does not exist, or {"ok":false,"error":string} on other failures. Large files are returned one window at a time: the envelope then carries a "window" object {startLine,endLine,totalLines,nextOffset?} and the content begins with a "[Showing lines X-Y of Z...]" notice. When "window" is present you have NOT seen the whole file — call read_file again with offset=nextOffset to read on. See the system prompt for full envelope semantics.',
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file, relative to the repository root (e.g. src/foo/bar.ts)",
          },
          offset: {
            type: "integer",
            description:
              "1-based line number to start reading from. Omit to start at the beginning. Pass the nextOffset from a previous windowed result to continue reading a large file.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description:
        'List immediate children of a directory at the PR\'s HEAD ref. Returns a JSON envelope: {"ok":true,"entries":[{"name":string,"type":"file"|"dir"|"symlink"|"submodule"},…]} on success, {"ok":false,"error":"not_found"} when the directory does not exist, or {"ok":false,"error":string} on other failures. See the system prompt for full envelope semantics.',
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Path to the directory, relative to the repository root (e.g. src/foo). Use an empty string "" for the repository root.',
          },
        },
        required: ["path"],
      },
    },
  },
];

/** Set of output tool names for fast membership checks in the tool-use loop. */
const OUTPUT_TOOL_NAMES = new Set<string>(OUTPUT_TOOL_DEFINITIONS.map((t) => t.function.name));

/**
 * Tool names whose args carry a BATCH that expands to N singular calls
 * (mt#3545, extended mt#4979). Derived from the expansion registry rather than
 * listed here, so a third batch tool needs no edit in this file.
 */
const BATCH_TOOL_NAMES = new Set<string>(Object.keys(BATCHED_TOOL_EXPANSIONS));

/**
 * Apply the mt#2863 / mt#3300 resolution-note guard to one parsed
 * `submit_finding`, mutating its args in place and logging the decision.
 *
 * Extracted (mt#4979) because there are now THREE emission paths for a
 * `submit_finding` — the main loop's singular branch, the main loop's BATCH
 * branch via `submit_findings`, and mt#2926's post-loop forced pass — and a
 * guard applied at only some of them is a route around it. That is the exact
 * gap class mt#2926 was filed to close, so re-creating it while adding the
 * batch tool would be self-defeating.
 *
 * Note this is precisely where mt#3545's "the blast radius is nil" stops
 * generalising: it held for `submit_spec_verifications` because NO emission
 * guard applies to a spec verification, which is why the batch branch could
 * bypass the singular path wholesale. Findings are the case that breaks that
 * assumption.
 */
function applyResolutionNoteGuard(
  parsed: Extract<ReviewToolCall, { name: "submit_finding" }>,
  logFields: Record<string, unknown>
): void {
  const evaluation = evaluateSubmitFindingCall({ args: parsed.args });
  if (evaluation.decision === "reclassify") {
    log.info("reviewer.submit_finding_resolution_note_reclassified", {
      event: "reviewer.submit_finding_resolution_note_reclassified",
      provider: "openai",
      ...logFields,
      file: parsed.args.file,
      line: parsed.args.line,
      argumentKind: evaluation.argumentKind,
      reason: evaluation.reason,
    });
    parsed.args.severity = evaluation.newSeverity;
  } else if (evaluation.decision === "reject") {
    log.info("reviewer.submit_finding_resolution_note_rejected", {
      event: "reviewer.submit_finding_resolution_note_rejected",
      provider: "openai",
      ...logFields,
      file: parsed.args.file,
      line: parsed.args.line,
      argumentKind: evaluation.argumentKind,
      reason: evaluation.reason,
    });
    parsed.args.details = markUntrackedDeferral(parsed.args.details);
  }
}

/**
 * All tools registered with the model in the tool-use loop: the two
 * read-only reviewer tools (read_file, list_directory) plus the six
 * structured output tools (submit_finding, submit_inline_comment,
 * submit_spec_verification, submit_documentation_impact, submit_thread_resolve,
 * conclude_review).
 *
 * OutputToolDefinition.function.parameters uses a concrete shape (type, properties,
 * required, additionalProperties) while OpenAI's FunctionParameters is typed as
 * Record<string, unknown>. We map each definition to rebuild the object with the
 * OpenAI-SDK-compatible parameter type instead of casting.
 */
// Exported (mt#2926) so the forced-findings live smoke sends the SAME tools
// array production sends. Rebuilding it in the script would make the smoke's
// request diverge from the real one on exactly the axis mem#614 measured —
// array width against a pinned tool_choice — which is the axis the smoke
// exists to keep honest.
export const ALL_TOOL_DEFINITIONS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  ...REVIEWER_TOOL_DEFINITIONS,
  ...OUTPUT_TOOL_DEFINITIONS.map((def) => ({
    type: "function" as const,
    function: {
      name: def.function.name,
      description: def.function.description,
      parameters: def.function.parameters as Record<string, unknown>,
    },
  })),
];

/**
 * The submit_documentation_impact tool definition extracted from
 * OUTPUT_TOOL_DEFINITIONS, adapted to the OpenAI SDK's tool-shape. Used by
 * the post-loop forced doc-impact pass (mt#2115) to constrain the model to
 * emit submit_documentation_impact via tool_choice.
 */
const DOC_IMPACT_RAW_DEF = OUTPUT_TOOL_DEFINITIONS.find(
  (t) => t.function.name === "submit_documentation_impact"
);
const DOC_IMPACT_TOOL_DEF: OpenAI.Chat.Completions.ChatCompletionTool | null = DOC_IMPACT_RAW_DEF
  ? {
      type: "function" as const,
      function: {
        name: DOC_IMPACT_RAW_DEF.function.name,
        description: DOC_IMPACT_RAW_DEF.function.description,
        parameters: DOC_IMPACT_RAW_DEF.function.parameters as Record<string, unknown>,
      },
    }
  : null;

/** User message injected before the post-loop forced doc-impact pass. */
const DOC_IMPACT_REMINDER_USER_MSG =
  "Your review is incomplete — you must emit a `submit_documentation_impact` tool call now. " +
  'Provide a JSON object with: `kind` (one of "no-update-needed", "updated-in-pr", "blocking-needs-update"), ' +
  "`evidence` (string justifying the verdict), and optional `affectedDocs` (string[] of affected doc paths). " +
  // mt#3527: this forced pass pins tool_choice to submit_documentation_impact, so the model
  // CANNOT call read_file here. It must therefore report what it actually read during the
  // loop rather than assert an accuracy it never checked — the exact shape of the PR #2508
  // miss ("existing docs ... remain accurate", asserted without opening the doc).
  "You cannot read files on this call. If you did not read the docs covering behavior this PR " +
  "changes, do NOT claim they remain accurate — state in `evidence` which docs you checked and " +
  "which you did not. Remember that a doc needing an update may be one whose existing prose the " +
  "PR makes FALSE, not only one that omits something the PR adds.";

/**
 * The conclude_review tool definition extracted from OUTPUT_TOOL_DEFINITIONS,
 * adapted to the OpenAI SDK's tool-shape. Used by the post-loop forced
 * conclude_review pass (mt#1471) to constrain the model to emit conclude_review
 * via tool_choice.
 */
const CONCLUDE_REVIEW_RAW_DEF = OUTPUT_TOOL_DEFINITIONS.find(
  (t) => t.function.name === "conclude_review"
);
// Runtime guard rather than a module-load throw: if conclude_review is somehow
// absent from OUTPUT_TOOL_DEFINITIONS (refactor slip), the rest of the reviewer
// service still starts; only the post-loop forced pass is disabled, and
// composition-side severity-derived event recovery (mt#1413) takes over.
const CONCLUDE_REVIEW_TOOL_DEF: OpenAI.Chat.Completions.ChatCompletionTool | null =
  CONCLUDE_REVIEW_RAW_DEF
    ? {
        type: "function" as const,
        function: {
          name: CONCLUDE_REVIEW_RAW_DEF.function.name,
          description: CONCLUDE_REVIEW_RAW_DEF.function.description,
          parameters: CONCLUDE_REVIEW_RAW_DEF.function.parameters as Record<string, unknown>,
        },
      }
    : null;

/** User message injected before the post-loop forced conclude_review pass. */
const CONCLUDE_REVIEW_REMINDER_USER_MSG =
  "Your review is incomplete. Emit conclude_review(event, summary) now as your final tool call.";

/**
 * The BATCHED `submit_findings` tool definition extracted from
 * OUTPUT_TOOL_DEFINITIONS, adapted to the OpenAI SDK's tool-shape. Used by the
 * post-loop forced findings pass (mt#2926) to constrain the model via
 * tool_choice.
 *
 * Named for the batch, not the singular (PR #3640 R1): mt#4979 changed which
 * tool this pins, and a `SUBMIT_FINDING_*` name would have kept asserting the
 * old referent to every later reader. Same runtime-guard-not-module-throw pattern as its two
 * siblings above: if submit_finding is somehow absent (refactor slip), only
 * this pass is disabled and the mt#2685 recovery synthesis takes over.
 */
// mt#4979: the forced pass pins the BATCHED tool, not the singular one. A
// pinned tool_choice returns exactly ONE call (measured 3/3 on live gpt-5 in
// mt#2926's smoke), so pinning `submit_finding` capped recovery at one finding
// however many the conclusion named. One call carrying N findings lifts that
// ceiling without loosening the pin that guarantees emission at all.
const SUBMIT_FINDINGS_BATCH_RAW_DEF = OUTPUT_TOOL_DEFINITIONS.find(
  (t) => t.function.name === BATCHED_FINDINGS_TOOL
);
const SUBMIT_FINDINGS_BATCH_TOOL_DEF: OpenAI.Chat.Completions.ChatCompletionTool | null =
  SUBMIT_FINDINGS_BATCH_RAW_DEF
    ? {
        type: "function" as const,
        function: {
          name: SUBMIT_FINDINGS_BATCH_RAW_DEF.function.name,
          description: SUBMIT_FINDINGS_BATCH_RAW_DEF.function.description,
          parameters: SUBMIT_FINDINGS_BATCH_RAW_DEF.function.parameters as Record<string, unknown>,
        },
      }
    : null;

/**
 * Subset of the model invocation parameters preserved across the main loop and
 * the post-loop forced pass. Typed explicitly so `client.chat.completions.create`
 * sees `model` as a required field — `Record<string, unknown>` widens it away
 * and trips the SDK's overload resolution under `tsc --noEmit`.
 */
interface ChatCreateBaseParams {
  model: string;
  max_completion_tokens: number;
  reasoning_effort?: ReasoningEffort;
  // mt#2722 — OpenAI prompt-cache controls. Neither field is typed by the
  // installed openai@4.104.0 (both postdate it); the OpenAI Node SDK forwards
  // unknown body fields verbatim, so we carry them as a typed passthrough on
  // baseParams and let the spread into `client.chat.completions.create` forward
  // them (spread-originated properties are exempt from TS excess-property
  // checks). `prompt_cache_key` is only a routing HINT — it can never cause an
  // incorrect cache hit (OpenAI validates the actual prefix bytes), so a
  // stale/colliding key is at worst a missed optimization, never wrong data.
  prompt_cache_key: string;
  prompt_cache_retention: "24h";
}

/**
 * Run a single forced conclude_review API call and, if it returns a parseable
 * conclude_review tool call, append it to `accumulatedToolCalls`.
 *
 * Uses `tool_choice: { type: "function", function: { name: "conclude_review" } }`
 * with only the conclude_review tool registered to force the model to emit
 * exactly one conclude_review call. This eliminates the in-loop reminder's
 * reliance on the model voluntarily complying.
 *
 * Conversation history is NOT mutated: a shallow-copied `forcedMessages` array
 * (parent `messages` + optional exit turn + user reminder) is constructed and
 * passed to the API. The caller's `messages` array is unaffected, which is
 * verified by a dedicated regression test.
 *
 * @returns Token usage from the call plus whether a parseable conclude_review
 *          was actually appended to accumulatedToolCalls.
 */
async function forceConcludeReview(
  client: OpenAI,
  baseParams: ChatCreateBaseParams,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  exitMessage: OpenAI.Chat.Completions.ChatCompletionMessage | null,
  accumulatedToolCalls: ReviewToolCall[],
  timeoutMs: number
): Promise<{
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  emitted: boolean;
}> {
  // Runtime guard: if the conclude_review tool definition is missing (refactor
  // slip in OUTPUT_TOOL_DEFINITIONS), skip the forced pass and let composition-
  // side recovery (mt#1413) handle the missing-conclude_review case. Emitted via
  // log.info for parity with all other reviewer.* JSON events so log-pipeline
  // ingestion picks it up; the `severity: "error"` field is available for
  // dashboards/alerts that want to escalate it.
  if (!CONCLUDE_REVIEW_TOOL_DEF) {
    log.info("reviewer.conclude_review_tool_def_missing", {
      event: "reviewer.conclude_review_tool_def_missing",
      provider: "openai",
      severity: "error",
    });
    return {
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      emitted: false,
    };
  }

  // Build a shallow-copied messages array for the forced call so the parent
  // `messages` array (shared with the main loop) isn't mutated by appending
  // the exit turn or the user reminder. Avoids implicit coupling and removes
  // the risk of the exit turn being double-pushed if a future caller already
  // appended it.
  const forcedMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    ...messages,
    ...(exitMessage ? [exitMessage] : []),
    { role: "user", content: CONCLUDE_REVIEW_REMINDER_USER_MSG },
  ];

  const response = await withTimeout(
    "openai.chat.completions.create.forceConclude",
    timeoutMs,
    (signal) =>
      client.chat.completions.create(
        {
          ...baseParams,
          messages: forcedMessages,
          // mt#2722 — pass the FULL tools array (was [CONCLUDE_REVIEW_TOOL_DEF])
          // so the forced pass preserves the cached prefix shared with the main
          // loop: swapping the `tools` array busts the prompt cache from the
          // tools position onward. `tool_choice` below still pins the model to
          // emit exactly conclude_review regardless of array width, so effective
          // tool availability is unchanged. NOTE (mt#2722 AT 2b): the original
          // single-tool narrowing was a deliberate mt#1471 choice (memory
          // c57a9479 records that narrowing + forced tool_choice reached 15/15
          // emission on gpt-5); widening to the full array is expected to stay
          // quality-neutral because tool_choice removes the compliance question,
          // but this is EMPIRICALLY GATED, not assumed — the replay emission
          // rate must stay >= the mt#1471 baseline. If it regresses, revert to
          // the narrow array and accept the forced-pass cache-bust (spec
          // Contingency: change (a)/(b) separability).
          tools: ALL_TOOL_DEFINITIONS,
          // Reference the extracted tool def's name so the constraint stays in
          // lockstep with OUTPUT_TOOL_DEFINITIONS — if conclude_review is ever
          // renamed there, this call updates automatically.
          tool_choice: {
            type: "function",
            function: { name: CONCLUDE_REVIEW_TOOL_DEF.function.name },
          },
        },
        { signal }
      )
  );

  const usage = response.usage;
  const tokenUsage = {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };

  const message = response.choices[0]?.message;
  const rawToolCalls = message?.tool_calls;
  if (!rawToolCalls || rawToolCalls.length === 0) {
    return { ...tokenUsage, emitted: false };
  }

  // Parse the (forced) conclude_review tool call. Only the first one wins.
  for (const toolCall of rawToolCalls) {
    if (toolCall.function.name !== "conclude_review") continue;
    try {
      const parsed = parseToolCall("conclude_review", toolCall.function.arguments);
      accumulatedToolCalls.push(parsed);
      // Observability parity with main-loop output tool calls: emit the same
      // shape so downstream metrics tracking `reviewer.output_tool_call`
      // counts include the forced-path conclude_review emission.
      log.info("reviewer.output_tool_call", {
        event: "reviewer.output_tool_call",
        provider: "openai",
        tool: "conclude_review",
        count: accumulatedToolCalls.length,
      });
      return { ...tokenUsage, emitted: true };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.info("reviewer.output_tool_call_parse_error", {
        event: "reviewer.output_tool_call_parse_error",
        provider: "openai",
        tool: "conclude_review",
        phase: "post_loop_forced",
        error: errMsg,
      });
      // Malformed forced call: do not append. Composition-side severity-derived
      // event recovery (mt#1413) handles the absent-conclude_review case.
      return { ...tokenUsage, emitted: false };
    }
  }

  // Forced call returned tool calls but none was conclude_review (shouldn't
  // happen with tool_choice constraint, but defensive).
  return { ...tokenUsage, emitted: false };
}

/**
 * Run a single forced submit_documentation_impact API call and, if it returns
 * a parseable tool call, append it to `accumulatedToolCalls`.
 *
 * Same pattern as forceConcludeReview (mt#1471) — uses tool_choice to
 * constrain the model. Fires BEFORE forceConcludeReview so the doc-impact
 * assessment is available when the model formulates its conclusion.
 */
async function forceDocumentationImpact(
  client: OpenAI,
  baseParams: ChatCreateBaseParams,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  exitMessage: OpenAI.Chat.Completions.ChatCompletionMessage | null,
  accumulatedToolCalls: ReviewToolCall[],
  timeoutMs: number
): Promise<{
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  emitted: boolean;
}> {
  if (!DOC_IMPACT_TOOL_DEF) {
    log.info("reviewer.doc_impact_tool_def_missing", {
      event: "reviewer.doc_impact_tool_def_missing",
      provider: "openai",
      severity: "error",
    });
    return {
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      emitted: false,
    };
  }

  const forcedMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    ...messages,
    ...(exitMessage ? [exitMessage] : []),
    { role: "user", content: DOC_IMPACT_REMINDER_USER_MSG },
  ];

  const response = await withTimeout(
    "openai.chat.completions.create.forceDocImpact",
    timeoutMs,
    (signal) =>
      client.chat.completions.create(
        {
          ...baseParams,
          messages: forcedMessages,
          // mt#2722 — pass the FULL tools array (was [DOC_IMPACT_TOOL_DEF]) so
          // the forced pass preserves the cached prefix shared with the main
          // loop. `tool_choice` still pins exactly submit_documentation_impact.
          // Empirically gated the same as the conclude_review forced pass — see
          // that pass's comment and mt#2722 AT 2b.
          tools: ALL_TOOL_DEFINITIONS,
          tool_choice: {
            type: "function",
            function: { name: DOC_IMPACT_TOOL_DEF.function.name },
          },
        },
        { signal }
      )
  );

  const usage = response.usage;
  const tokenUsage = {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };

  const message = response.choices[0]?.message;
  const rawToolCalls = message?.tool_calls;
  if (!rawToolCalls || rawToolCalls.length === 0) {
    return { ...tokenUsage, emitted: false };
  }

  for (const toolCall of rawToolCalls) {
    if (toolCall.function.name !== "submit_documentation_impact") continue;
    try {
      const parsed = parseToolCall("submit_documentation_impact", toolCall.function.arguments);
      accumulatedToolCalls.push(parsed);
      log.info("reviewer.output_tool_call", {
        event: "reviewer.output_tool_call",
        provider: "openai",
        tool: "submit_documentation_impact",
        count: accumulatedToolCalls.length,
        phase: "post_loop_forced",
      });
      return { ...tokenUsage, emitted: true };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.info("reviewer.output_tool_call_parse_error", {
        event: "reviewer.output_tool_call_parse_error",
        provider: "openai",
        tool: "submit_documentation_impact",
        phase: "post_loop_forced",
        error: errMsg,
      });
      return { ...tokenUsage, emitted: false };
    }
  }

  return { ...tokenUsage, emitted: false };
}

/**
 * Run a single forced `submit_finding` API call and append every parseable
 * finding it returns to `accumulatedToolCalls` (mt#2926).
 *
 * Same pattern as `forceConcludeReview` / `forceDocumentationImpact` — full
 * `tools` array for prompt-cache continuity (mt#2722), `tool_choice` pinned
 * to the one function we require. Fires AFTER `forceConcludeReview`, because
 * its trigger is a property of the CONCLUSION: we cannot know the verdict is
 * an incoherent REQUEST_CHANGES until the conclusion exists. See
 * `forced-findings-guard.ts` for the trigger predicate and why it is keyed on
 * final accumulated state rather than on which path produced it.
 *
 * Two deliberate differences from its two siblings:
 *
 * 1. **Every returned call is appended, not just the first.** Those passes
 *    require exactly one artifact (one conclusion, one doc-impact verdict) so
 *    they return on the first match; a review can have several blocking
 *    findings, and a pinned `tool_choice` does not forbid the model from
 *    emitting more than one call to the pinned function. Dropping the rest
 *    would silently re-create a lossy channel — the defect this pass exists
 *    to close.
 * 2. **The mt#2863 / mt#3300 resolution-note guard is applied** to each
 *    finding, exactly as the main loop applies it at its own parse site.
 *    Without this, the forced path would be a second `submit_finding`
 *    emission route that bypasses an emission guard — the same shape of gap
 *    that made this task necessary.
 *
 * Conversation history is NOT mutated: a shallow-copied `forcedMessages`
 * array is passed to the API, so the caller's `messages` array is unaffected.
 *
 * @returns Token usage, whether a provider call was actually ATTEMPTED, and how
 *          many findings were appended. `attempted` is separate from a zero
 *          count on purpose (PR #3627 R1): the missing-tool-def branch returns
 *          before any call, and a caller that sees only `emittedCount: 0`
 *          cannot tell that apart from a call that came back empty.
 */
async function forceFindings(
  client: OpenAI,
  baseParams: ChatCreateBaseParams,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  exitMessage: OpenAI.Chat.Completions.ChatCompletionMessage | null,
  accumulatedToolCalls: ReviewToolCall[],
  conclusionSummary: string,
  timeoutMs: number
): Promise<{
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  attempted: boolean;
  emittedCount: number;
}> {
  if (!SUBMIT_FINDINGS_BATCH_TOOL_DEF) {
    log.info("reviewer.submit_finding_tool_def_missing", {
      event: "reviewer.submit_finding_tool_def_missing",
      provider: "openai",
      severity: "error",
    });
    return {
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      attempted: false,
      emittedCount: 0,
    };
  }

  const forcedMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    ...messages,
    ...(exitMessage ? [exitMessage] : []),
    { role: "user", content: buildForcedFindingsUserMessage(conclusionSummary) },
  ];

  const response = await withTimeout(
    "openai.chat.completions.create.forceFindings",
    timeoutMs,
    (signal) =>
      client.chat.completions.create(
        {
          ...baseParams,
          messages: forcedMessages,
          tools: ALL_TOOL_DEFINITIONS,
          tool_choice: {
            type: "function",
            function: { name: SUBMIT_FINDINGS_BATCH_TOOL_DEF.function.name },
          },
        },
        { signal }
      )
  );

  const usage = response.usage;
  const tokenUsage = {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };

  const message = response.choices[0]?.message;
  const rawToolCalls = message?.tool_calls;
  if (!rawToolCalls || rawToolCalls.length === 0) {
    return { ...tokenUsage, attempted: true, emittedCount: 0 };
  }

  let emittedCount = 0;
  const seenFindingKeys = new Set<string>();
  for (const toolCall of rawToolCalls) {
    // mt#4979: the pinned tool is the BATCH form, so one returned call carries
    // N findings. The singular name is still accepted — the model may emit it
    // despite the pin, and dropping a well-formed finding because it arrived
    // under the other name would re-create the lossy channel this pass exists
    // to close.
    const fnName = toolCall.function.name;
    if (fnName !== BATCHED_FINDINGS_TOOL && fnName !== "submit_finding") continue;
    try {
      const expanded = parseToolCallExpanded(fnName, toolCall.function.arguments);
      for (const parsed of expanded) {
        // The expansion of either accepted name yields only submit_finding
        // entries; the check keeps the discriminated union honest.
        if (parsed.name !== "submit_finding") continue;

        // PR #3640 R1: accepting BOTH the batch and singular names means a
        // response carrying both could append the same finding twice, which
        // reaches the review body as a visible duplicate. The pin makes that
        // shape unlikely, not impossible — and a dedupe is cheaper than the
        // report. Keyed on the fields that identify a finding to a reader;
        // `details` is excluded so a re-worded restatement of the same anchor
        // still collapses.
        const dedupeKey = [
          parsed.args.severity,
          parsed.args.file,
          String(parsed.args.line),
          parsed.args.summary,
        ].join("\u0000");
        if (seenFindingKeys.has(dedupeKey)) {
          log.info("reviewer.forced_findings_duplicate_skipped", {
            event: "reviewer.forced_findings_duplicate_skipped",
            provider: "openai",
            phase: "post_loop_forced_findings",
            file: parsed.args.file,
            line: parsed.args.line,
          });
          continue;
        }
        seenFindingKeys.add(dedupeKey);

        // mt#2863 / mt#3300 emission guard, applied on this path for the same
        // reason it is applied in the main loop: a BLOCKING finding whose text
        // reads as a completed resolution note is self-contradictory, and this
        // pass must not become a route around that.
        applyResolutionNoteGuard(parsed, { phase: "post_loop_forced_findings" });

        accumulatedToolCalls.push(parsed);
        emittedCount += 1;
      }
      log.info("reviewer.output_tool_call", {
        event: "reviewer.output_tool_call",
        provider: "openai",
        tool: fnName,
        count: accumulatedToolCalls.length,
        expandedTo: expanded.length,
        phase: "post_loop_forced_findings",
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.info("reviewer.output_tool_call_parse_error", {
        event: "reviewer.output_tool_call_parse_error",
        provider: "openai",
        tool: fnName,
        phase: "post_loop_forced_findings",
        error: errMsg,
      });
      // Malformed finding: skip it and keep going — one bad call must not
      // discard its well-formed siblings from the same response. If NONE
      // parse, emittedCount stays 0 and the mt#2685 recovery pass supplies
      // the placeholder downstream, exactly as it does today.
    }
  }

  return { ...tokenUsage, attempted: true, emittedCount };
}

/**
 * Internal implementation of the OpenAI provider, split out so tests can
 * inject a fake client without module mocking (no-global-module-mocks rule).
 * Exported for tests only — production code should call callOpenAI.
 */
export async function callOpenAIWithClient(
  client: OpenAI,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  tools?: ReviewerToolContext,
  options?: CallReviewerOptions,
  // mt#1086: per-SDK-call timeout. Optional + defaulted so the dozens of
  // existing test sites and replay scripts that call this directly without
  // loading config don't need to change. Production callers (`callOpenAI`
  // below) pass `config.modelTimeoutMs`.
  timeoutMs: number = DEFAULT_MODEL_TIMEOUT_MS
): Promise<ReviewOutput> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  // When tools are active the model must finish reasoning AND emit structured
  // tool-call JSON within the same budget. 16384 was too tight — reasoning at
  // "medium" effort exhausted the budget before the model could emit tool-call
  // JSON, causing it to narrate "Calling read_file..." into the review body
  // instead of actually invoking the tool. 32768 gives enough runway for both
  // steps. The no-tools path is unchanged at 16384 (single-turn, no tool-call
  // overhead). See mt#1232.
  const maxCompletionTokens = tools ? 32768 : 16384;

  // The reasoning_effort actually sent on this call. Resolved by the single
  // function that owns the rule (mt#4556) rather than inline, so the value
  // recorded in the config fingerprint cannot disagree with the value sent
  // here. Tools-active defaults to "low" so the model spends budget on
  // structured output rather than hidden CoT; the no-tools path keeps "medium"
  // (mt#1232). A caller-supplied override wins on both paths (mt#1131).
  const effectiveReasoningEffort = resolveReasoningEffort(
    "openai",
    model,
    tools !== undefined,
    options?.reasoningEffort
  );

  // mt#2722 — stable prompt-cache routing key. The OpenAI cached prefix is the
  // systemPrompt + tools array; the systemPrompt (built by
  // buildCriticConstitution) is repo-INDEPENDENT — a pure function of
  // (toolsActive, scopeBucket, outputToolsActive, priorReviewsPresent) — so a
  // hash of it is the correct variant discriminator, stable across reviews,
  // across the tool-use rounds within a review, and across the forced passes
  // (all four create call sites spread this baseParams). This DEVIATES from the
  // spec's original `reviewer:<repo>:<variant>` shape by dropping <repo>: the
  // repo is not part of the cacheable prefix (it lives in the per-PR user
  // message, past the shared prefix), so keying on it would fragment cross-repo
  // cache sharing for negligible sharding benefit (single dominant repo,
  // sporadic cadence far under OpenAI's ~15 RPM/prefix ceiling). See the spec's
  // "cache-key value" reconciliation note.
  const promptCacheKey = `reviewer:${createHash("sha256")
    .update(systemPrompt)
    .digest("hex")
    .slice(0, 16)}`;

  const baseParams = {
    model,
    max_completion_tokens: maxCompletionTokens,
    // mt#2722 — see ChatCreateBaseParams. Applied uniformly to every OpenAI call
    // in a review (main-loop rounds, both forced passes, and the no-tools path)
    // so they share one cached prefix.
    prompt_cache_key: promptCacheKey,
    prompt_cache_retention: "24h" as const,
    // reasoning_effort is "o-series models only" per the OpenAI SDK. Passing
    // it to non-reasoning models (gpt-4o, gpt-4, etc.) returns 400 from the
    // API — so resolveReasoningEffort returns null for those and the field is
    // omitted entirely rather than defaulted.
    ...(effectiveReasoningEffort !== null ? { reasoning_effort: effectiveReasoningEffort } : {}),
  };

  // No tools provided — preserve original single-turn behavior.
  if (!tools) {
    const noToolsStart = Date.now();
    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await withTimeout("openai.chat.completions.create.notools", timeoutMs, (signal) =>
        client.chat.completions.create({ ...baseParams, messages }, { signal })
      );
    } catch (err) {
      // mt#4281: the SAME class as the tool-loop catch below. This path has its
      // own `withTimeout` and its own success-only `timing` block, so a timeout
      // here lost its duration exactly the way the loop's did. Found by the
      // loop's own test taking this branch (no `tools` argument) — fixing only
      // the site that prompted the work would have left this one silent.
      throw attachPartialTiming(err, {
        roundLatenciesMs: [Date.now() - noToolsStart],
        timeoutCount: err instanceof TimeoutError ? 1 : 0,
        retryOutcomes: err instanceof TimeoutError ? [TIMEOUT_UNRECOVERED] : [],
      });
    }
    const noToolsDurationMs = Date.now() - noToolsStart;
    const text = response.choices[0]?.message?.content ?? "";
    const usage = response.usage;
    return {
      text,
      tokensUsed: usage?.total_tokens,
      usage: {
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
        // `?? 0` (mt#3665): an absent prompt_tokens_details means the response
        // reported no cache read, which is 0 cached — not "unknown". Without it
        // this path was the one OpenAI site that could emit undefined.
        cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
        totalTokens: usage?.total_tokens,
      },
      provider: "openai",
      model,
      toolCalls: [],
      timing: {
        roundLatenciesMs: [noToolsDurationMs],
        timeoutCount: 0,
        retryOutcomes: [],
      },
    };
  }

  // Tool-use loop: run up to MAX_TOOL_ROUNDS rounds.
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalReasoningTokens = 0;
  let totalCachedTokens = 0;

  /** Accumulated output tool calls parsed during the loop. */
  const accumulatedToolCalls: ReviewToolCall[] = [];

  /**
   * mt#2828 conclude_review forcing-function state: how many times this
   * review has rejected an incoherent `conclude_review(REQUEST_CHANGES)`
   * call (zero BLOCKING findings recorded), and whether the bound
   * ({@link DEFAULT_MAX_CONCLUDE_REVIEW_REJECTIONS}) was exhausted (i.e. an
   * incoherent call was ultimately let through for the mt#2685 recovery pass
   * to handle). Surfaced on `ReviewOutput.concludeReviewGuard` so
   * `review-recovery-logging.ts` can emit the counted, budgeted signal.
   */
  let concludeReviewRejectionCount = 0;
  let concludeReviewGuardBoundExhausted = false;

  /**
   * Text content from the round in which the model exited the tool-use loop
   * (i.e., the round on which `rawToolCalls.length === 0`). Used as the
   * `text` field in the final ReviewOutput.
   *
   * - Set inside the loop when the model voluntarily stops emitting tool calls.
   * - On the last round (MAX_TOOL_ROUNDS - 1), tools are not passed and the
   *   model is forced to text-only; we set this to the model's text or, if
   *   absent, the [TOOL CAP REACHED] sentinel.
   * - Stays null only if the loop ran zero iterations (impossible) or we
   *   somehow fell through without entering the no-tool-calls branch.
   */
  let exitText: string | null = null;

  /**
   * The assistant message that ended the loop (the no-tool-calls turn).
   * Held so the post-loop forced conclude_review pass (mt#1471) can append it
   * to the conversation history before the user reminder.
   */
  let exitMessage: OpenAI.Chat.Completions.ChatCompletionMessage | null = null;

  /**
   * The most recent non-empty assistant text observed across any round. Used
   * as a fallback for `text` when the exit turn has empty content but a
   * prior round produced narrative text. Avoids surfacing the misleading
   * [TOOL CAP REACHED] sentinel for non-last-round early exits with empty
   * content (mt#1471 PR #915 round-2 finding).
   */
  let lastNonEmptyAssistantText: string | null = null;

  /** How many rounds the main loop actually ran (1-indexed for logging). */
  let totalRoundsUsed = 0;

  /**
   * 1-based round on which the model first emitted `conclude_review` itself,
   * or null if it never did in-loop (mt#3547).
   */
  let concludedAtRound: number | null = null;

  const roundLatenciesMs: number[] = [];
  let timeoutCount = 0;
  const retryOutcomes: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const isLastRound = round === MAX_TOOL_ROUNDS - 1;

    // mt#1969: retry-on-timeout once with a reduced ceiling to recover
    // transient provider-side slowness. See callToolloopWithRetry's docstring.
    const roundStart = Date.now();
    let response: OpenAI.Chat.Completions.ChatCompletion;
    let retriedOnTimeout = false;
    try {
      const retryResult = await callToolloopWithRetry(
        "openai.chat.completions.create.toolloop",
        round,
        timeoutMs,
        (signal) =>
          client.chat.completions.create(
            {
              ...baseParams,
              messages,
              // On the last round, force the model to respond with text only.
              ...(isLastRound ? {} : { tools: ALL_TOOL_DEFINITIONS, tool_choice: "auto" }),
            },
            { signal }
          )
      );
      response = retryResult.result;
      retriedOnTimeout = retryResult.retriedOnTimeout;
    } catch (err) {
      roundLatenciesMs.push(Date.now() - roundStart);
      if (err instanceof TimeoutError) {
        timeoutCount++;
        retryOutcomes.push(TIMEOUT_UNRECOVERED);
      }
      // mt#4281: everything accumulated above dies with this frame unless it
      // rides out on the error — this function's only other exit builds
      // `ReviewOutput.timing`, which a throw never reaches. runReview's boundary
      // reads it back and writes the `review_timing` row this path has never had.
      throw attachPartialTiming(err, { roundLatenciesMs, timeoutCount, retryOutcomes });
    }
    roundLatenciesMs.push(Date.now() - roundStart);
    if (retriedOnTimeout) {
      timeoutCount++;
      retryOutcomes.push("timeout-recovered");
    }

    totalRoundsUsed = round + 1;

    const usage = response.usage;
    if (usage) {
      totalPromptTokens += usage.prompt_tokens ?? 0;
      totalCompletionTokens += usage.completion_tokens ?? 0;
      totalReasoningTokens += usage.completion_tokens_details?.reasoning_tokens ?? 0;
      totalCachedTokens += usage.prompt_tokens_details?.cached_tokens ?? 0;
    }

    const message = response.choices[0]?.message;
    if (!message) break;

    // Track the most recent non-empty assistant text across the entire loop
    // (including tool-call rounds). Used as fallback for `result.text` if
    // the exit turn happens to have empty content.
    if (typeof message.content === "string" && message.content.length > 0) {
      lastNonEmptyAssistantText = message.content;
    }

    const rawToolCalls = message.tool_calls;

    // No tool calls: the model is done emitting tool calls — capture exit
    // state and break. Any missing conclude_review is handled after the loop
    // by `forceConcludeReview` (see mt#1471).
    if (!rawToolCalls || rawToolCalls.length === 0) {
      exitMessage = message;
      // Resolve `text` field with the following priority:
      //   1. This turn's non-empty content (current model output).
      //   2. Any earlier round's non-empty assistant content.
      //   3. [TOOL CAP REACHED] sentinel — only on the last round, when the
      //      round budget genuinely was exhausted.
      //   4. Neutral "no final summary provided" notice for early empty
      //      exits — avoids the UX lie of saying "tool cap reached" when
      //      the cap wasn't actually hit (mt#1471 PR #915 round-2 finding).
      const exitContent =
        typeof message.content === "string" && message.content.length > 0 ? message.content : null;
      if (exitContent !== null) {
        exitText = exitContent;
      } else if (lastNonEmptyAssistantText !== null) {
        exitText = lastNonEmptyAssistantText;
      } else if (isLastRound) {
        exitText =
          "[TOOL CAP REACHED] The reviewer hit the 10-iteration tool-use limit. The review above may be incomplete. Manual review is recommended.";
      } else {
        exitText = "[REVIEWER NOTE] No final summary provided.";
      }
      break;
    }

    // Append the assistant message with tool calls to the conversation.
    messages.push(message);

    // Execute all tool calls and append results.
    for (const toolCall of rawToolCalls) {
      const fnName = toolCall.function.name;
      let resultContent: string;

      if (BATCH_TOOL_NAMES.has(fnName)) {
        // mt#3545: the batched form expands to N singular calls. Handled in its
        // own branch rather than threading a list through the singular path,
        // because a list-shaped `parsed` would have reordered entries relative
        // to the spec.
        //
        // mt#3545's other reason — "none of that path's guards apply" — was
        // true of spec verifications and is NOT true of the mt#4979
        // `submit_findings` batch: the resolution-note guard applies to every
        // finding regardless of which tool carried it. So the guard runs per
        // expanded entry below. The conclude_review coherence guard still does
        // not apply here, because no batch tool carries a conclusion.
        try {
          const expanded = parseToolCallExpanded(fnName, toolCall.function.arguments);
          for (const call of expanded) {
            if (call.name === "submit_finding") {
              applyResolutionNoteGuard(call, { round, phase: "batch", tool: fnName });
            }
          }
          accumulatedToolCalls.push(...expanded);
          log.info("reviewer.output_tool_call", {
            event: "reviewer.output_tool_call",
            provider: "openai",
            tool: fnName,
            count: accumulatedToolCalls.length,
            expandedTo: expanded.length,
          });
          resultContent = JSON.stringify({
            ok: true,
            recorded: true,
            recordedCount: expanded.length,
          });
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.info("reviewer.output_tool_call_parse_error", {
            event: "reviewer.output_tool_call_parse_error",
            provider: "openai",
            tool: fnName,
            error: errMsg,
          });
          // Malformed batch: nothing is accumulated (all-or-nothing, so a bad
          // entry can never land a partial verdict set), and the model gets the
          // path-qualified zod issue back so it can self-correct.
          resultContent = JSON.stringify({ ok: false, error: `parse_error: ${errMsg}` });
        }
      } else if (OUTPUT_TOOL_NAMES.has(fnName)) {
        // Output tool: parse and accumulate; return a stub success response so
        // the loop continues normally.
        try {
          const parsed = parseToolCall(fnName, toolCall.function.arguments);

          // mt#2828: service-layer forcing function. A conclude_review(event=
          // REQUEST_CHANGES) call with zero BLOCKING submit_finding calls
          // recorded so far is incoherent — reject it back to the model
          // (bounded retries) instead of silently accumulating it and relying
          // on the mt#2685 recovery pass to patch it after the fact. See
          // conclude-review-guard.ts for the full rationale.
          if (parsed.name === "conclude_review") {
            const evaluation = evaluateConcludeReviewCall({
              args: parsed.args,
              accumulatedToolCalls,
              rejectionCountSoFar: concludeReviewRejectionCount,
            });

            if (evaluation.decision === "reject") {
              concludeReviewRejectionCount = evaluation.rejectionCount;
              log.info("reviewer.conclude_review_rejected_zero_findings", {
                event: "reviewer.conclude_review_rejected_zero_findings",
                provider: "openai",
                round,
                rejectionCount: concludeReviewRejectionCount,
                maxRejections: DEFAULT_MAX_CONCLUDE_REVIEW_REJECTIONS,
              });
              resultContent = JSON.stringify({ ok: false, error: evaluation.correctiveMessage });
              messages.push({ role: "tool", tool_call_id: toolCall.id, content: resultContent });
              continue;
            }

            if (evaluation.boundExhausted) {
              concludeReviewGuardBoundExhausted = true;
              log.info("reviewer.conclude_review_zero_findings_bound_exhausted", {
                event: "reviewer.conclude_review_zero_findings_bound_exhausted",
                provider: "openai",
                round,
                rejectionCount: concludeReviewRejectionCount,
                maxRejections: DEFAULT_MAX_CONCLUDE_REVIEW_REJECTIONS,
              });
            }
          }

          // mt#2863: emission guard for resolution-note findings. A
          // submit_finding(severity="BLOCKING") whose text reads as a completed
          // resolution note ("no action required — resolved in the current diff")
          // is self-contradictory: the BLOCKING severity forces an
          // APPROVE→REQUEST_CHANGES reconciliation (mt#2655) and fails the
          // required findings-check on an approved-in-substance PR. Reclassify it
          // to NON-BLOCKING at emission (stateless / per-finding) so the
          // incoherent BLOCKING never reaches composition. See
          // resolution-note-guard.ts for the full rationale.
          //
          // mt#3300: a resolution note that names no recognized argument, or
          // names a deferral with no tracking task id, is REJECTED rather than
          // reclassified — the finding stays BLOCKING and its `details` is
          // marked `[untracked-deferral]` so the gap is visible in the
          // persisted finding body, forcing a genuine fix, a named spec
          // amendment, or a task-id-tracked deferral before it can converge.
          if (parsed.name === "submit_finding") {
            applyResolutionNoteGuard(parsed, { round });
          }

          accumulatedToolCalls.push(parsed);
          // mt#3547: record WHICH round the model concluded on, not just that it
          // did. Without this, `roundsUsed === maxRounds && concludedInLoop` is
          // ambiguous between "concluded on the last tool-capable round" and
          // "concluded early and kept calling tools anyway" — two different
          // behaviors that call for different fixes.
          if (parsed.name === "conclude_review" && concludedAtRound === null) {
            concludedAtRound = round + 1;
          }
          const count = accumulatedToolCalls.length;
          log.info("reviewer.output_tool_call", {
            event: "reviewer.output_tool_call",
            provider: "openai",
            tool: fnName,
            count,
          });
          resultContent = JSON.stringify({ ok: true, recorded: true });
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.info("reviewer.output_tool_call_parse_error", {
            event: "reviewer.output_tool_call_parse_error",
            provider: "openai",
            tool: fnName,
            error: errMsg,
          });
          // Malformed call: do NOT add to accumulatedToolCalls; return an error
          // envelope so the model can self-correct.
          resultContent = JSON.stringify({ ok: false, error: `parse_error: ${errMsg}` });
        }
      } else {
        // Read-only tool (read_file, list_directory) or unknown tool.
        try {
          const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
          const path = typeof args.path === "string" ? args.path : "";

          if (fnName === "read_file") {
            // mt#1086 PR #969 R1 BLOCKING #2 + R2 BLOCKING #2:
            // Defense-in-depth wrap around the tool call AND propagate
            // the AbortSignal into the inner function so abort actually
            // cancels the underlying GitHub request (the R1 wrap by itself
            // only short-circuited locally). The signal flows:
            //   withTimeout → tools.readFile → readFileAtRef.callerSignal
            //   → Octokit `request: { signal }`.
            const content = await withTimeout("tools.read_file", timeoutMs, (signal) =>
              tools.readFile(path, signal)
            );
            // mt#3544: the model may pass a 1-based offset to continue reading a
            // previously windowed file. A non-numeric or absent value degrades to
            // "from the top" rather than erroring — the argument is model-supplied.
            const rawOffset = args.offset;
            const offset =
              typeof rawOffset === "number" && Number.isFinite(rawOffset)
                ? Math.trunc(rawOffset)
                : 1;
            const envelope = buildReadFileEnvelope(content, offset);
            resultContent = JSON.stringify(envelope);
            // mt#3544 SC4: per-read size logging. Three distinct measurements,
            // kept separate because conflating them makes the distribution
            // useless: `preCapChars` is the file as fetched, `postCapChars` is
            // the content field the model actually receives (window + notice),
            // and `envelopeChars` is the full serialized tool result — the true
            // wire cost, which also carries JSON escaping and the window object.
            // PR #2530 R1: `postCapChars` previously held the envelope's JSON
            // length, which is not comparable to `preCapChars` and would have
            // silently corrupted the reduction ratio this log exists to measure.
            const windowed = "window" in envelope && envelope.window !== undefined;
            log.info("reviewer.read_file_result", {
              event: "reviewer.read_file_result",
              path,
              offset,
              preCapChars: content !== null && content.kind === "text" ? content.content.length : 0,
              postCapChars: "content" in envelope ? envelope.content.length : 0,
              envelopeChars: resultContent.length,
              windowed,
              ...(windowed && envelope.window !== undefined
                ? { totalLines: envelope.window.totalLines }
                : {}),
            });
          } else if (fnName === "list_directory") {
            const entries = await withTimeout("tools.list_directory", timeoutMs, (signal) =>
              tools.listDirectory(path, signal)
            );
            resultContent = JSON.stringify(buildListDirectoryEnvelope(entries));
          } else {
            resultContent = JSON.stringify({ ok: false, error: `unknown_tool: ${fnName}` });
          }
        } catch (err: unknown) {
          resultContent = JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: resultContent,
      });
    }

    // mt#3547: tell the model how much budget is left, at the only point it can
    // still act on it. Appended AFTER this round's tool results and never
    // rewritten, so the prompt-cache prefix through the previous round stays
    // byte-identical (see buildRoundBudgetNotice's docstring).
    //
    // The `isLastRound` guard is defensive rather than load-bearing today:
    // that round passes no tools, so the API cannot return tool calls and
    // control breaks out above before reaching here. It states the invariant
    // explicitly so the behavior stays correct if the cap semantics change.
    if (!isLastRound) {
      messages.push({
        role: "user",
        content: buildRoundBudgetNotice(round, MAX_TOOL_ROUNDS),
      });
    }
  }

  // Snapshot main-loop output count BEFORE forced passes so the conclude
  // gate's gate_branch discriminator reflects main-loop behavior, not
  // forced-pass side-effects (mt#2115 reviewer finding).
  const mainLoopOutputCount = accumulatedToolCalls.length;

  // mt#3547: snapshot the stop-signal outcome BEFORE any forced pass can supply
  // a conclude_review. Read after the forced passes this is always true and the
  // metric mt#3547 exists to move would be invisible.
  const concludedInLoop = accumulatedToolCalls.some((tc) => tc.name === "conclude_review");
  let forcedConcludeGateBranch: "emitted_no_conclude" | "emitted_nothing" | null = null;

  // Post-loop forced submit_documentation_impact pass (mt#2115).
  const hasDocImpact = accumulatedToolCalls.some((tc) => tc.name === "submit_documentation_impact");
  if (!hasDocImpact) {
    try {
      const forced = await forceDocumentationImpact(
        client,
        baseParams,
        messages,
        exitMessage,
        accumulatedToolCalls,
        timeoutMs
      );
      totalPromptTokens += forced.promptTokens;
      totalCompletionTokens += forced.completionTokens;
      totalReasoningTokens += forced.reasoningTokens;
      totalCachedTokens += forced.cachedTokens;

      log.info("reviewer.doc_impact_reminder", {
        event: "reviewer.doc_impact_reminder",
        provider: "openai",
        mode: "post_loop_forced",
        fired_at_turn: totalRoundsUsed,
        finally_emitted: forced.emitted,
      });
    } catch (err: unknown) {
      log.info("reviewer.doc_impact_reminder", {
        event: "reviewer.doc_impact_reminder",
        provider: "openai",
        mode: "post_loop_forced",
        fired_at_turn: totalRoundsUsed,
        finally_emitted: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Post-loop forced conclude_review pass (mt#1471 + mt#1639).
  //
  // The main loop has exited. If the model did NOT emit conclude_review, run
  // one more API call with `tool_choice` constrained to conclude_review. This
  // covers two gate branches:
  //
  //   - "emitted_no_conclude": model emitted output tool calls (findings,
  //     inline comments, or spec verifications) but omitted conclude_review.
  //     This was mt#1471's original gate (`!hasConcludeReview &&
  //     hasEmittedOutputCalls`).
  //
  //   - "emitted_nothing": model exited the loop without emitting any output
  //     tool calls at all — no findings, no inline comments, no spec
  //     verifications, no conclude_review. mt#1471's gate skipped this case
  //     (`hasEmittedOutputCalls=false`), leaving the reviewer to submit an
  //     empty structural-envelope review. mt#1639 closes the gap by dropping
  //     the `&& hasEmittedOutputCalls` clause so both cases reach the forced
  //     pass. Live instance: PR #973 (mt#1618, 2026-05-07 18:54Z).
  //
  // Tool-list scope for the forced pass (CORRECTED mt#2926 — this comment
  // described mt#1471's original narrow array long after mt#2722 replaced it).
  // What actually ships: the FULL ALL_TOOL_DEFINITIONS array, for prompt-cache
  // continuity, with `tool_choice` pinned to conclude_review. The pin is what
  // constrains emission — array width does not (mem#614: 6/6 emission on gpt-5
  // after the widening) — so submit_finding is present in the array and
  // unreachable on this call regardless.
  //
  // The alternative mt#1471 recorded as rejected — let the model retroactively
  // emit findings before concluding, because findings from an otherwise-empty
  // pass would be unanchored from read_file / list_directory evidence it never
  // gathered — is a claim about the `emitted_nothing` branch, where the model
  // produced no output calls at all. It does not carry to `emitted_no_conclude`,
  // where the model spent the full round budget gathering evidence and wrote
  // substantive prose. mt#2926's forced-findings pass therefore runs AFTER this
  // one rather than widening it, and only on an incoherent REQUEST_CHANGES
  // conclusion the model has already reached itself.
  //
  // The `gate_branch` discriminator on the audit log distinguishes the two
  // branches for downstream segmentation without a separate event name.
  //
  // Composition-side severity-derived event recovery (mt#1413) remains the
  // safety net if the forced pass fails to emit a parseable conclude_review.
  const hasConcludeReview = accumulatedToolCalls.some((tc) => tc.name === "conclude_review");
  const hasEmittedOutputCalls = mainLoopOutputCount > 0;
  if (!hasConcludeReview) {
    // Discriminator for audit log: which gate branch fired.
    const gateBranch: "emitted_no_conclude" | "emitted_nothing" = hasEmittedOutputCalls
      ? "emitted_no_conclude"
      : "emitted_nothing";
    forcedConcludeGateBranch = gateBranch;
    try {
      const forced = await forceConcludeReview(
        client,
        baseParams,
        messages,
        exitMessage,
        accumulatedToolCalls,
        timeoutMs
      );
      totalPromptTokens += forced.promptTokens;
      totalCompletionTokens += forced.completionTokens;
      totalReasoningTokens += forced.reasoningTokens;
      totalCachedTokens += forced.cachedTokens;

      log.info("reviewer.conclude_review_reminder", {
        event: "reviewer.conclude_review_reminder",
        provider: "openai",
        mode: "post_loop_forced",
        fired_at_turn: totalRoundsUsed,
        reminder_count: 1,
        finally_emitted: forced.emitted,
        gate_branch: gateBranch,
      });
    } catch (err: unknown) {
      // API error (network, rate limit, etc.) on the forced call. Log and
      // fall through; composition-side recovery handles the missing event.
      log.info("reviewer.conclude_review_reminder", {
        event: "reviewer.conclude_review_reminder",
        provider: "openai",
        mode: "post_loop_forced",
        fired_at_turn: totalRoundsUsed,
        reminder_count: 1,
        finally_emitted: false,
        gate_branch: gateBranch,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // mt#2926: post-loop forced FINDINGS pass. Runs unconditionally — not
  // inside the `!hasConcludeReview` branch above — because its trigger is a
  // property of the final accumulated state, and it must cover BOTH residual
  // paths mt#2828's in-loop guard cannot reach: the forced-conclude pass
  // right above (which pins tool_choice to conclude_review, so submit_finding
  // is unreachable there) and the guard's own bound-exhausted fall-through
  // (which emits an in-loop conclude_review and so never enters that branch).
  // Keying on final state rather than on the gate branch is what makes one
  // predicate cover both. See forced-findings-guard.ts.
  const forcedFindingsEvaluation = evaluateForcedFindingsPass({ accumulatedToolCalls });
  if (forcedFindingsEvaluation.decision === "run") {
    try {
      const forcedFindings = await forceFindings(
        client,
        baseParams,
        messages,
        exitMessage,
        accumulatedToolCalls,
        forcedFindingsEvaluation.conclusionSummary,
        timeoutMs
      );
      totalPromptTokens += forcedFindings.promptTokens;
      totalCompletionTokens += forcedFindings.completionTokens;
      totalReasoningTokens += forcedFindings.reasoningTokens;
      totalCachedTokens += forcedFindings.cachedTokens;

      // PR #3627 R1: `fired` is derived from whether a provider call was
      // actually ATTEMPTED, not from having reached this branch. The
      // missing-tool-def path returns here having called nothing, and counting
      // it as a fire would inflate exactly the numerator mt#4980 measures —
      // and inflate the "fired and did not help" bucket specifically, since
      // that path also emits nothing.
      const fields = describeForcedFindingsOutcome(
        forcedFindings.attempted
          ? { kind: "attempted", emittedCount: forcedFindings.emittedCount }
          : { kind: "not-attempted", reason: "tool-def-missing" }
      );
      log.info("reviewer.forced_findings_pass", {
        event: "reviewer.forced_findings_pass",
        provider: "openai",
        fired: fields.fired,
        fired_at_turn: totalRoundsUsed,
        emitted_count: fields.emittedCount,
        // Separates "did not need to fire" from "fired and did not help" —
        // the two produce the same downstream artifact (mt#2685's synthesized
        // finding) and must be distinguishable on a dashboard.
        fell_back_to_recovery_synth: fields.fellBackToRecoverySynth,
        ...(fields.skipReason ? { skip_reason: fields.skipReason } : {}),
      });
    } catch (err: unknown) {
      // API error (network, rate limit, timeout) on the forced call. Log and
      // fall through; the mt#2685 recovery pass supplies the placeholder
      // finding downstream exactly as it does today.
      const failedFields = describeForcedFindingsOutcome({
        kind: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      log.info("reviewer.forced_findings_pass", {
        event: "reviewer.forced_findings_pass",
        provider: "openai",
        fired: failedFields.fired,
        fired_at_turn: totalRoundsUsed,
        emitted_count: failedFields.emittedCount,
        fell_back_to_recovery_synth: failedFields.fellBackToRecoverySynth,
        error: failedFields.error,
      });
    }
  } else {
    // Unconditional no-fire record, so the pass's fire RATE is computable from
    // this one event stream without a separately-tracked denominator — the
    // same reason reviewer.empty_findings_recovery_summary fires on every
    // review (mt#2828).
    log.info("reviewer.forced_findings_pass", {
      event: "reviewer.forced_findings_pass",
      provider: "openai",
      fired: false,
      skip_reason: forcedFindingsEvaluation.reason,
    });
  }

  const totalTokens = totalPromptTokens + totalCompletionTokens;
  return {
    text:
      exitText ??
      "[TOOL CAP REACHED] The reviewer hit the 10-iteration tool-use limit without producing a final response. Manual review is recommended.",
    tokensUsed: totalTokens,
    usage: {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      reasoningTokens: totalReasoningTokens,
      cachedTokens: totalCachedTokens,
      totalTokens,
    },
    provider: "openai",
    model,
    toolCalls: accumulatedToolCalls,
    timing: {
      roundLatenciesMs,
      timeoutCount,
      retryOutcomes,
    },
    // mt#2828: conclude_review forcing-function outcome for this review, for
    // the counted/budgeted signal emitted by review-recovery-logging.ts.
    concludeReviewGuard: {
      rejectionCount: concludeReviewRejectionCount,
      boundExhausted: concludeReviewGuardBoundExhausted,
    },
    // mt#3547: what the loop actually did, for the round-budget replay harness.
    toolLoop: {
      roundsUsed: totalRoundsUsed,
      maxRounds: MAX_TOOL_ROUNDS,
      concludedInLoop,
      concludedAtRound,
      forcedConcludeGateBranch,
    },
  };
}

/**
 * SDK-level retry budget, PINNED to the value we were already inheriting
 * (mt#4281).
 *
 * `new OpenAI({ apiKey })` defaults `maxRetries` to 2 and `timeout` to 10
 * minutes (verified against the installed openai@4.104.0: `index.d.ts` docblocks
 * for both options). Stating them changes nothing about today's behaviour and is
 * deliberately NOT a tuning move — retry policy is a Class B guarantee trade
 * owned by mt#2718 / mt#3526, needing a measured before/after and principal
 * sign-off. What it buys is that the values are now a decision on the record
 * rather than a default nobody chose.
 *
 * Why the 10-minute timeout is inert here, and stays: every toolloop call is
 * already wrapped in `withTimeout(..., timeoutMs)` at ~120s, so the wrapper is
 * the binding constraint and the SDK's own timeout never fires. Lowering it
 * WOULD change behaviour — it would start firing — so it is left above the
 * wrapper on purpose.
 */
export const OPENAI_SDK_MAX_RETRIES = 2;
export const OPENAI_SDK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The SDK's own fetch signature, not a hand-written one: this type has to be
 * assignable to `ClientOptions.fetch`, and the reviewer's tsconfig has
 * `lib: ["ES2022"]` with no DOM, so `RequestInfo` is not a global here.
 */
type FetchLike = OpenAICore.Fetch;

/**
 * Statuses the OpenAI SDK retries internally, verified against the installed
 * openai@4.104.0 `core.js#shouldRetry` rather than taken from the docs: 408
 * (request timeout), 409 (lock timeout), 429 (rate limit), and any >= 500.
 * Connection errors are retried too, on a separate branch that never yields a
 * response and so cannot be observed here.
 */
export function isSdkRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Render the fetch target for a log line.
 *
 * Takes `unknown` deliberately. The SDK's shimmed `RequestInfo` resolves to a
 * bare `string` under this tsconfig, so a typed union narrows to `never` and the
 * URL/Request branches will not compile — but the RUNTIME union really is
 * `string | URL | Request`, and which one arrives depends on the shim the SDK
 * selects. Handling all three keeps this correct if that resolution changes.
 */
function describeFetchTarget(input: unknown): string {
  if (typeof input === "string") return input;
  // Same class as R1's `fetch` finding: a bare `URL` reference would throw
  // ReferenceError where the global is absent. Guarded off `globalThis` for the
  // same reason, and because this runs on the failure path — where an
  // incidental throw would replace the error being reported.
  if (typeof globalThis.URL === "function" && input instanceof globalThis.URL) {
    return input.toString();
  }
  if (typeof input === "object" && input !== null && "url" in input) {
    return String((input as { url: unknown }).url);
  }
  return String(input);
}

/**
 * Wrap a `fetch` so the SDK's own retries stop being invisible (mt#4281).
 *
 * The SDK retries up to `maxRetries` times INSIDE a single
 * `chat.completions.create()` call, emitting nothing this service logs. So a
 * 429 storm and one genuinely slow model call are indistinguishable from
 * outside: both present as the 120s wrapper firing, with no error in between.
 * Disambiguating those two is what this wrapper is for.
 *
 * ANSWERED 2026-09-04, and it is NOT the retry chain. On the first timeout
 * burst since this shipped (6 timeouts / 82 reviews, plus the first
 * `timeout-unrecovered` row ever written), `openai.sdk_retryable_response`
 * fired ZERO times across all five deployments that covered those timeouts
 * (matched on each review's START time, not its end — the service redeployed
 * 15 times that day, so a review can span a redeploy) — while `toolloop.timeout_retry`,
 * a `log.warn` from this same file, fired in every one of them, so the channel
 * was demonstrably live rather than silently blind. No retryable HTTP status
 * was returned. What the failures look like instead: four consecutive attempts
 * each burning the full 120s at round 0, on a day whose 1,090 completing rounds
 * ran p50 12.6s / p99 104.4s / max 117.7s — a request that returns nothing,
 * not one that returns slowly.
 *
 * This docblock previously argued the opposite ("the failures sit at ~2x p99 …
 * which is the shape a hidden retry chain produces"). That reasoning was
 * retired by mt#4284 — it pooled a healthy and a degraded regime — and the
 * conclusion it supported is now falsified by measurement. Do not reinstate it.
 * Note the percentiles it rested on could not have supported it either way: a
 * round that hits the cap is recorded at `120000 + retry`, an artifact of the
 * cap rather than a latency, so any percentile computed over timing-out rounds
 * is pulled toward the cap by construction.
 *
 * The wrapper stays. Ruling the hypothesis out IS its job, and it can only keep
 * doing that if it is still installed the next time someone asks. Its blind
 * spot is the standing one below: it observes RESPONSES, so a request that
 * never yields one — which is what the 2026-09-04 failures were — is invisible
 * to it, and our `withTimeout` aborts before any response arrives. Full
 * measurement: mt#1897 §BURST 2026-09-04.
 *
 * Observes only; the response is passed through untouched, so retry semantics
 * are unchanged. Logs the status and the request target — never headers, which
 * carry the API key.
 */
/**
 * Read the SDK's own attempt counter off an outgoing request.
 *
 * openai@4.104.0 `core.js#buildHeaders` stamps `x-stainless-retry-count` with
 * `maxRetries - retriesRemaining` — a 0-based attempt index — on every request
 * including the first. Returned 1-BASED, so `attempt: 1` is the original call
 * and `attempt: 2` is the first retry, which is how a log reader will read it.
 *
 * Returns null rather than guessing when the header is absent: a fabricated
 * attempt number is worse than a missing one, because it reads as measured.
 */
function readSdkAttempt(init: unknown): number | null {
  if (init === null || typeof init !== "object" || !("headers" in init)) return null;
  const headers = (init as { headers?: unknown }).headers;
  if (headers === null || typeof headers !== "object") return null;

  const raw =
    typeof (headers as Headers).get === "function"
      ? (headers as Headers).get("x-stainless-retry-count")
      : ((headers as Record<string, unknown>)["x-stainless-retry-count"] ?? null);

  if (raw === null || raw === undefined) return null;
  const retryCount = Number(raw);
  return Number.isInteger(retryCount) && retryCount >= 0 ? retryCount + 1 : null;
}

export function withSdkRetryVisibility(
  baseFetch: FetchLike,
  onRetryableResponse: (info: {
    status: number;
    target: string;
    /** 1-based attempt; null when the SDK's header was absent. */
    attempt: number | null;
  }) => void
): FetchLike {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (isSdkRetryableStatus(response.status)) {
      onRetryableResponse({
        status: response.status,
        target: describeFetchTarget(input),
        attempt: readSdkAttempt(init),
      });
    }
    return response;
  };
}

/**
 * Build the reviewer's OpenAI client with its request budget stated and its
 * internal retries observable (mt#4281).
 *
 * `baseFetch` is injected so the retry-visibility behaviour is testable against
 * a stub transport without patching a module import.
 */
export function createReviewerOpenAIClient(apiKey: string, baseFetch?: FetchLike): OpenAI {
  const budget = {
    apiKey,
    maxRetries: OPENAI_SDK_MAX_RETRIES,
    timeout: OPENAI_SDK_TIMEOUT_MS,
  };

  // PR #3136 R1 (BLOCKING, correct): the previous `baseFetch: FetchLike = fetch`
  // default made this hard-depend on a global `fetch`. Two problems. A bare
  // identifier reference throws ReferenceError where the global is absent, at
  // construction — turning a missing convenience into a dead reviewer. And
  // passing `fetch` explicitly BYPASSES the SDK's own `_shims` transport
  // selection, which exists precisely to supply a fetch on runtimes lacking one.
  // The pre-existing `new OpenAI({ apiKey })` delegated that choice entirely, so
  // this was a robustness regression introduced for instrumentation's sake.
  //
  // Resolved off `globalThis` (a property read, never a bare identifier) and
  // bound, so an unbound extraction cannot lose its receiver.
  const resolved =
    baseFetch ??
    (typeof globalThis.fetch === "function"
      ? (globalThis.fetch.bind(globalThis) as FetchLike)
      : undefined);

  if (resolved === undefined) {
    // No transport to wrap — hand the SDK its own. The pinned budget still
    // applies; only retry VISIBILITY is lost, and it is announced rather than
    // silently absent, so "no retry logs" cannot be misread as "no retries".
    log.warn("openai.sdk_retry_visibility_unavailable", {
      event: "openai.sdk_retry_visibility_unavailable",
      reason: "no-global-fetch",
    });
    return new OpenAI(budget);
  }

  return new OpenAI({
    ...budget,
    fetch: withSdkRetryVisibility(resolved, ({ status, target, attempt }) => {
      log.warn("openai.sdk_retryable_response", {
        event: "openai.sdk_retryable_response",
        status,
        target,
        attempt,
        maxRetries: OPENAI_SDK_MAX_RETRIES,
      });
    }),
  });
}

async function callOpenAI(
  config: ReviewerConfig,
  systemPrompt: string,
  userPrompt: string,
  tools?: ReviewerToolContext,
  options?: CallReviewerOptions
): Promise<ReviewOutput> {
  const client = createReviewerOpenAIClient(config.providerApiKey);
  return callOpenAIWithClient(
    client,
    config.providerModel,
    systemPrompt,
    userPrompt,
    tools,
    options,
    config.modelTimeoutMs
  );
}

async function callGoogle(
  config: ReviewerConfig,
  systemPrompt: string,
  userPrompt: string,
  tools?: ReviewerToolContext
): Promise<ReviewOutput> {
  if (tools) {
    log.warn(
      "provider google does not yet support reviewer tools (mt#1126 MVP is OpenAI-only); falling back to no-tools path"
    );
  }

  const client = new GoogleGenerativeAI(config.providerApiKey);
  const model = client.getGenerativeModel({
    model: config.providerModel,
    systemInstruction: systemPrompt,
  });

  // mt#1086: wrap in withTimeout. The Google SDK does not propagate
  // AbortSignal to its underlying HTTPS request as of @google/generative-ai
  // v0.21, so the abort is best-effort: the SDK call may continue running
  // in the background after timeout, but the caller has moved on.
  const googleStart = Date.now();
  const response = await withTimeout("google.generateContent", config.modelTimeoutMs, () =>
    model.generateContent(userPrompt)
  );
  const googleDurationMs = Date.now() - googleStart;
  const text = response.response.text();
  const usage = response.response.usageMetadata;
  return {
    text,
    tokensUsed: usage?.totalTokenCount,
    usage: {
      promptTokens: usage?.promptTokenCount,
      completionTokens: usage?.candidatesTokenCount,
      // mt#3665: the reviewer wires no prompt caching on the Google path, so 0
      // is the real observation, not a placeholder. If implicit/explicit Gemini
      // caching is ever enabled here, read usageMetadata.cachedContentTokenCount.
      cachedTokens: 0,
      totalTokens: usage?.totalTokenCount,
    },
    provider: "google",
    model: config.providerModel,
    toolCalls: [],
    timing: {
      roundLatenciesMs: [googleDurationMs],
      timeoutCount: 0,
      retryOutcomes: [],
    },
  };
}

async function callAnthropic(
  config: ReviewerConfig,
  systemPrompt: string,
  userPrompt: string,
  tools?: ReviewerToolContext
): Promise<ReviewOutput> {
  if (tools) {
    log.warn(
      "provider anthropic does not yet support reviewer tools (mt#1126 MVP is OpenAI-only); falling back to no-tools path"
    );
  }

  const client = new Anthropic({ apiKey: config.providerApiKey });
  // mt#1086: wrap in withTimeout. Anthropic SDK accepts `signal` in the
  // second arg (RequestOptions); it propagates to the underlying fetch.
  const anthropicStart = Date.now();
  const response = await withTimeout("anthropic.messages.create", config.modelTimeoutMs, (signal) =>
    client.messages.create(
      {
        model: config.providerModel,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      },
      { signal }
    )
  );
  const anthropicDurationMs = Date.now() - anthropicStart;

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  const totalTokens = response.usage.input_tokens + response.usage.output_tokens;
  return {
    text,
    tokensUsed: totalTokens,
    usage: {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
      // mt#3665, carrying mt#2721's decision forward: the reviewer's Anthropic
      // path sends no cache_control breakpoints, so nothing is cached and 0 is
      // the real observation. The installed SDK's usage type does not expose
      // cache_read_input_tokens; read it here if caching is ever enabled.
      cachedTokens: 0,
      totalTokens,
    },
    provider: "anthropic",
    model: config.providerModel,
    toolCalls: [],
    timing: {
      roundLatenciesMs: [anthropicDurationMs],
      timeoutCount: 0,
      retryOutcomes: [],
    },
  };
}
