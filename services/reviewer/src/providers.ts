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
import type { ReviewerConfig } from "./config";
import type { ReviewerToolContext, DirEntry, ReadFileResult } from "./tools";
import { OUTPUT_TOOL_DEFINITIONS, parseToolCall, type ReviewToolCall } from "./output-tools";
import { withTimeout, TimeoutError } from "./with-timeout";
import { log } from "./logger";

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
 * Tunable via REVIEWER_TOOLLOOP_RETRY_TIMEOUT_MS at process-env load time.
 */
const DEFAULT_TOOLLOOP_RETRY_TIMEOUT_MS = 120_000;

/**
 * Read the toolloop-retry config from process env at call time. Defaults match
 * the empirically-grounded values above. mt#1969.
 */
function resolveToolloopRetryConfig(): { enabled: boolean; retryTimeoutMs: number } {
  const rawEnabled = process.env["REVIEWER_TOOLLOOP_RETRY_ON_TIMEOUT"];
  const enabled = rawEnabled === undefined ? true : rawEnabled === "true" || rawEnabled === "1";
  const rawMs = process.env["REVIEWER_TOOLLOOP_RETRY_TIMEOUT_MS"];
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
 *   - On TimeoutError AND retry-enabled (REVIEWER_TOOLLOOP_RETRY_ON_TIMEOUT,
 *     default "true"), emits a `toolloop.timeout_retry` log line and retries
 *     once with REVIEWER_TOOLLOOP_RETRY_TIMEOUT_MS (default 90s).
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
  totalTokens?: number;
}

export interface TimingData {
  roundLatenciesMs: number[];
  timeoutCount: number;
  retryOutcomes: string[];
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
  reasoningEffort?: "low" | "medium" | "high";
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
  | { ok: true; content: string; truncated: boolean }
  | { ok: true; content: string; truncated: boolean; binary: true; size: number }
  | { ok: false; error: string };

export type ListDirectoryEnvelope =
  | { ok: true; entries: DirEntry[] }
  | { ok: false; error: string };

/**
 * Map a ReadFileResult from `readFileAtRef` to the JSON envelope the model
 * sees. Exported for tests.
 */
export function buildReadFileEnvelope(result: ReadFileResult | null): ReadFileEnvelope {
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
  return { ok: true, content: result.content, truncated: result.truncated };
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
        'Read the content of a file from the PR\'s HEAD ref. Returns a JSON envelope: {"ok":true,"content":string,"truncated":boolean} for text, {"ok":true,"content":string,"truncated":false,"binary":true,"size":number} for binary (not decoded), {"ok":false,"error":"not_found"} when the file does not exist, or {"ok":false,"error":string} on other failures. See the system prompt for full envelope semantics.',
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file, relative to the repository root (e.g. src/foo/bar.ts)",
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
const ALL_TOOL_DEFINITIONS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
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
 * Subset of the model invocation parameters preserved across the main loop and
 * the post-loop forced pass. Typed explicitly so `client.chat.completions.create`
 * sees `model` as a required field — `Record<string, unknown>` widens it away
 * and trips the SDK's overload resolution under `tsc --noEmit`.
 */
interface ChatCreateBaseParams {
  model: string;
  max_completion_tokens: number;
  reasoning_effort?: "low" | "medium" | "high";
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
    return { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, emitted: false };
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
          tools: [CONCLUDE_REVIEW_TOOL_DEF],
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

  // When tools are active, default reasoning_effort to "low" so the model
  // spends budget on structured output (tool calls) rather than hidden CoT.
  // The no-tools path keeps "medium" as the baseline. Caller-supplied
  // options.reasoningEffort always takes precedence on both paths. See mt#1232.
  const defaultReasoningEffort = tools ? ("low" as const) : ("medium" as const);

  const baseParams = {
    model,
    max_completion_tokens: maxCompletionTokens,
    // reasoning_effort is "o-series models only" per the OpenAI SDK. Passing
    // it to non-reasoning models (gpt-4o, gpt-4, etc.) returns 400 from the
    // API — so only include it when the configured model supports it. The
    // default varies by path: "low" when tools are active (preserve budget for
    // tool-call JSON), "medium" for single-turn no-tools reviews. Retries
    // override with "low" to shift the budget toward visible output when the
    // first attempt returned empty (mt#1131).
    ...(isReasoningModel(model)
      ? { reasoning_effort: options?.reasoningEffort ?? defaultReasoningEffort }
      : {}),
  };

  // No tools provided — preserve original single-turn behavior.
  if (!tools) {
    const noToolsStart = Date.now();
    const response = await withTimeout(
      "openai.chat.completions.create.notools",
      timeoutMs,
      (signal) => client.chat.completions.create({ ...baseParams, messages }, { signal })
    );
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

  /** Accumulated output tool calls parsed during the loop. */
  const accumulatedToolCalls: ReviewToolCall[] = [];

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
        retryOutcomes.push("timeout-unrecovered");
      }
      throw err;
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

      if (OUTPUT_TOOL_NAMES.has(fnName)) {
        // Output tool: parse and accumulate; return a stub success response so
        // the loop continues normally.
        try {
          const parsed = parseToolCall(fnName, toolCall.function.arguments);
          accumulatedToolCalls.push(parsed);
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
            resultContent = JSON.stringify(buildReadFileEnvelope(content));
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
  // Tool-list scope for the empty-case forced pass: narrow to conclude_review
  // only, matching mt#1471's behavior for consistency. Alternative not taken:
  // include the full ALL_TOOL_DEFINITIONS list so the model could retroactively
  // emit findings before concluding. Rejected because the forced pass is a
  // last-resort structural backstop — retroactive findings from an otherwise-
  // empty pass would be unanchored from the read_file / list_directory evidence
  // the model never gathered, producing hallucinated severity assessments.
  //
  // The `gate_branch` discriminator on the audit log distinguishes the two
  // branches for downstream segmentation without a separate event name.
  //
  // Composition-side severity-derived event recovery (mt#1413) remains the
  // safety net if the forced pass fails to emit a parseable conclude_review.
  const hasConcludeReview = accumulatedToolCalls.some((tc) => tc.name === "conclude_review");
  const hasEmittedOutputCalls = accumulatedToolCalls.length > 0;
  if (!hasConcludeReview) {
    // Discriminator for audit log: which gate branch fired.
    const gateBranch: "emitted_no_conclude" | "emitted_nothing" = hasEmittedOutputCalls
      ? "emitted_no_conclude"
      : "emitted_nothing";
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
  };
}

async function callOpenAI(
  config: ReviewerConfig,
  systemPrompt: string,
  userPrompt: string,
  tools?: ReviewerToolContext,
  options?: CallReviewerOptions
): Promise<ReviewOutput> {
  const client = new OpenAI({ apiKey: config.providerApiKey });
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
