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

export async function callReviewer(
  config: ReviewerConfig,
  systemPrompt: string,
  userPrompt: string,
  options?: CallReviewerOptions
): Promise<ReviewOutput> {
  switch (config.provider) {
    case "openai":
      return callOpenAI(config, systemPrompt, userPrompt, options);
    case "google":
      return callGoogle(config, systemPrompt, userPrompt);
    case "anthropic":
      return callAnthropic(config, systemPrompt, userPrompt);
  }
}

async function callOpenAI(
  config: ReviewerConfig,
  systemPrompt: string,
  userPrompt: string,
  options?: CallReviewerOptions
): Promise<ReviewOutput> {
  const client = new OpenAI({ apiKey: config.providerApiKey });
  const response = await client.chat.completions.create({
    model: config.providerModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
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
    ...(isReasoningModel(config.providerModel)
      ? { reasoning_effort: options?.reasoningEffort ?? ("medium" as const) }
      : {}),
  });

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
    model: config.providerModel,
  };
}

async function callGoogle(
  config: ReviewerConfig,
  systemPrompt: string,
  userPrompt: string
): Promise<ReviewOutput> {
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
  userPrompt: string
): Promise<ReviewOutput> {
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
