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

/** OpenAI function definitions for the reviewer tools. */
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

  const baseParams = {
    model,
    // Reasoning models (GPT-5, o-series) consume this budget for hidden
    // reasoning tokens as well as output. 8192 was too tight — reasoning
    // sometimes exhausted the budget before producing any output, yielding
    // empty reviews. 16384 gives enough runway for both a full adversarial
    // analysis AND a detailed output. See mt#1125.
    max_completion_tokens: 16384,
    // reasoning_effort is "o-series models only" per the OpenAI SDK. Passing
    // it to non-reasoning models (gpt-4o, gpt-4, etc.) returns 400 from the
    // API — so only include it when the configured model supports it. The
    // default is "medium"; retries override with "low" to shift the budget
    // toward visible output when the first attempt returned empty (mt#1131).
    ...(isReasoningModel(model)
      ? { reasoning_effort: options?.reasoningEffort ?? ("medium" as const) }
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
    };
  }

  // Tool-use loop: run up to MAX_TOOL_ROUNDS rounds.
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalReasoningTokens = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const isLastRound = round === MAX_TOOL_ROUNDS - 1;

    const response = await client.chat.completions.create({
      ...baseParams,
      messages,
      // On the last round, force the model to respond with text only.
      ...(isLastRound ? {} : { tools: REVIEWER_TOOL_DEFINITIONS, tool_choice: "auto" }),
    });

    const usage = response.usage;
    if (usage) {
      totalPromptTokens += usage.prompt_tokens ?? 0;
      totalCompletionTokens += usage.completion_tokens ?? 0;
      totalReasoningTokens += usage.completion_tokens_details?.reasoning_tokens ?? 0;
    }

    const message = response.choices[0]?.message;
    if (!message) break;

    const toolCalls = message.tool_calls;

    // No tool calls: model is done — return the text response.
    if (!toolCalls || toolCalls.length === 0) {
      const text =
        message.content ??
        (isLastRound
          ? "[TOOL CAP REACHED] The reviewer hit the 10-iteration tool-use limit. The review above may be incomplete. Manual review is recommended."
          : "");
      const totalTokens = totalPromptTokens + totalCompletionTokens;
      return {
        text,
        tokensUsed: totalTokens,
        usage: {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          reasoningTokens: totalReasoningTokens,
          totalTokens,
        },
        provider: "openai",
        model,
      };
    }

    // Append the assistant message with tool calls to the conversation.
    messages.push(message);

    // Execute all tool calls and append results.
    for (const toolCall of toolCalls) {
      const fnName = toolCall.function.name;
      let resultContent: string;

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

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: resultContent,
      });
    }
  }

  // Should not reach here in practice — the loop always returns inside — but
  // handle it defensively.
  const totalTokens = totalPromptTokens + totalCompletionTokens;
  return {
    text: "[TOOL CAP REACHED] The reviewer hit the 10-iteration tool-use limit without producing a final response. Manual review is recommended.",
    tokensUsed: totalTokens,
    usage: {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      reasoningTokens: totalReasoningTokens,
      totalTokens,
    },
    provider: "openai",
    model,
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
  };
}
