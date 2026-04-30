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

export interface ReviewUsage {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface ReviewOutput {
  text: string;
  tokensUsed?: number;
  usage?: ReviewUsage;
  provider: ReviewerConfig["provider"];
  model: string;
  /**
   * Structured output tool calls emitted by the model during review. Each
   * entry is a parsed, validated discriminated-union call (submit_finding,
   * submit_inline_comment, submit_spec_verification, or conclude_review).
   * Always an array — never undefined; empty when no output tools were called.
   */
  toolCalls: ReviewToolCall[];
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
 * read-only reviewer tools (read_file, list_directory) plus the four
 * structured output tools (submit_finding, submit_inline_comment,
 * submit_spec_verification, conclude_review).
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
if (!CONCLUDE_REVIEW_RAW_DEF) {
  // Module-load-time invariant: OUTPUT_TOOL_DEFINITIONS is built locally and
  // is expected to contain conclude_review. If this ever fails, it's a refactor
  // bug, not runtime data — surface it loudly.
  throw new Error("internal invariant: conclude_review missing from OUTPUT_TOOL_DEFINITIONS");
}
const CONCLUDE_REVIEW_TOOL_DEF: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function" as const,
  function: {
    name: CONCLUDE_REVIEW_RAW_DEF.function.name,
    description: CONCLUDE_REVIEW_RAW_DEF.function.description,
    parameters: CONCLUDE_REVIEW_RAW_DEF.function.parameters as Record<string, unknown>,
  },
};

/** User message injected before the post-loop forced conclude_review pass. */
const CONCLUDE_REVIEW_REMINDER_USER_MSG =
  "Your review is incomplete. Emit conclude_review(event, summary) now as your final tool call.";

/**
 * Run a single forced conclude_review API call and, if it returns a parseable
 * conclude_review tool call, append it to `accumulatedToolCalls`.
 *
 * Uses `tool_choice: { type: "function", function: { name: "conclude_review" } }`
 * to force the model to emit conclude_review (no other tools accepted). This
 * eliminates the in-loop reminder's reliance on the model voluntarily complying.
 *
 * The conversation history (`messages`) is mutated: the assistant's exit turn
 * (passed in as `exitMessage` if available) plus the user reminder are appended
 * before the API call.
 *
 * @returns Token usage from the call plus whether a parseable conclude_review
 *          was actually appended to accumulatedToolCalls.
 */
async function forceConcludeReview(
  client: OpenAI,
  baseParams: Record<string, unknown>,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  exitMessage: OpenAI.Chat.Completions.ChatCompletionMessage | null,
  accumulatedToolCalls: ReviewToolCall[]
): Promise<{
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  emitted: boolean;
}> {
  // Append the exiting assistant turn (so the model sees its own prior response)
  // and a user reminder directing it to emit conclude_review.
  if (exitMessage) {
    messages.push(exitMessage);
  }
  messages.push({
    role: "user",
    content: CONCLUDE_REVIEW_REMINDER_USER_MSG,
  });

  const response = await client.chat.completions.create({
    ...baseParams,
    messages,
    tools: [CONCLUDE_REVIEW_TOOL_DEF],
    tool_choice: { type: "function", function: { name: "conclude_review" } },
  });

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
      return { ...tokenUsage, emitted: true };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(
        JSON.stringify({
          event: "reviewer.output_tool_call_parse_error",
          provider: "openai",
          tool: "conclude_review",
          phase: "post_loop_forced",
          error: errMsg,
        })
      );
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
  options?: CallReviewerOptions
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
    const response = await client.chat.completions.create({ ...baseParams, messages });
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

  /** How many rounds the main loop actually ran (1-indexed for logging). */
  let totalRoundsUsed = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const isLastRound = round === MAX_TOOL_ROUNDS - 1;

    const response = await client.chat.completions.create({
      ...baseParams,
      messages,
      // On the last round, force the model to respond with text only.
      ...(isLastRound ? {} : { tools: ALL_TOOL_DEFINITIONS, tool_choice: "auto" }),
    });

    totalRoundsUsed = round + 1;

    const usage = response.usage;
    if (usage) {
      totalPromptTokens += usage.prompt_tokens ?? 0;
      totalCompletionTokens += usage.completion_tokens ?? 0;
      totalReasoningTokens += usage.completion_tokens_details?.reasoning_tokens ?? 0;
    }

    const message = response.choices[0]?.message;
    if (!message) break;

    const rawToolCalls = message.tool_calls;

    // No tool calls: model wants to exit the loop.
    //
    // mt#1471: previously this branch tried an in-loop reminder gated on
    // `!isLastRound`, which never fired in the dominant production failure
    // mode (model exhausts the round budget on read_file calls and exits via
    // round 9's forced text-only response). We now break out unconditionally
    // and run a single forced conclude_review pass after the loop, which is
    // independent of round-budget pressure and uses tool_choice to guarantee
    // the model emits conclude_review.
    if (!rawToolCalls || rawToolCalls.length === 0) {
      exitMessage = message;
      exitText =
        message.content ??
        (isLastRound
          ? "[TOOL CAP REACHED] The reviewer hit the 10-iteration tool-use limit. The review above may be incomplete. Manual review is recommended."
          : "");
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
          console.log(
            JSON.stringify({
              event: "reviewer.output_tool_call",
              provider: "openai",
              tool: fnName,
              count,
            })
          );
          resultContent = JSON.stringify({ ok: true, recorded: true });
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.log(
            JSON.stringify({
              event: "reviewer.output_tool_call_parse_error",
              provider: "openai",
              tool: fnName,
              error: errMsg,
            })
          );
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
            const content = await tools.readFile(path);
            resultContent = JSON.stringify(buildReadFileEnvelope(content));
          } else if (fnName === "list_directory") {
            const entries = await tools.listDirectory(path);
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

  // Post-loop forced conclude_review pass (mt#1471).
  //
  // The main loop has exited. If the model emitted output tool calls (findings,
  // inline comments, or spec verifications) but did NOT emit conclude_review,
  // run one more API call with `tool_choice` constrained to conclude_review.
  // This is the structural fix for the 1/15 production emission rate of
  // mt#1450's in-loop reminder: the post-loop pass is decoupled from the
  // round budget and uses tool_choice to force compliance.
  //
  // Composition-side severity-derived event recovery (mt#1413) remains the
  // safety net if the forced pass fails to emit a parseable conclude_review.
  const hasConcludeReview = accumulatedToolCalls.some((tc) => tc.name === "conclude_review");
  const hasEmittedOutputCalls = accumulatedToolCalls.length > 0;
  if (!hasConcludeReview && hasEmittedOutputCalls) {
    try {
      const forced = await forceConcludeReview(
        client,
        baseParams,
        messages,
        exitMessage,
        accumulatedToolCalls
      );
      totalPromptTokens += forced.promptTokens;
      totalCompletionTokens += forced.completionTokens;
      totalReasoningTokens += forced.reasoningTokens;

      console.log(
        JSON.stringify({
          event: "reviewer.conclude_review_reminder",
          provider: "openai",
          fired_at_turn: totalRoundsUsed,
          reminder_count: 1,
          finally_emitted: forced.emitted,
        })
      );
    } catch (err: unknown) {
      // API error (network, rate limit, etc.) on the forced call. Log and
      // fall through; composition-side recovery handles the missing event.
      console.log(
        JSON.stringify({
          event: "reviewer.conclude_review_reminder",
          provider: "openai",
          fired_at_turn: totalRoundsUsed,
          reminder_count: 1,
          finally_emitted: false,
          error: err instanceof Error ? err.message : String(err),
        })
      );
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
    options
  );
}

async function callGoogle(
  config: ReviewerConfig,
  systemPrompt: string,
  userPrompt: string,
  tools?: ReviewerToolContext
): Promise<ReviewOutput> {
  if (tools) {
    console.warn(
      "provider google does not yet support reviewer tools (mt#1126 MVP is OpenAI-only); falling back to no-tools path"
    );
  }

  const client = new GoogleGenerativeAI(config.providerApiKey);
  const model = client.getGenerativeModel({
    model: config.providerModel,
    systemInstruction: systemPrompt,
  });

  const response = await model.generateContent(userPrompt);
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
  };
}

async function callAnthropic(
  config: ReviewerConfig,
  systemPrompt: string,
  userPrompt: string,
  tools?: ReviewerToolContext
): Promise<ReviewOutput> {
  if (tools) {
    console.warn(
      "provider anthropic does not yet support reviewer tools (mt#1126 MVP is OpenAI-only); falling back to no-tools path"
    );
  }

  const client = new Anthropic({ apiKey: config.providerApiKey });
  const response = await client.messages.create({
    model: config.providerModel,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

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
  };
}
