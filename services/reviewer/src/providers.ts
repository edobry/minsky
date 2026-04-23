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

export async function callReviewer(
  config: ReviewerConfig,
  systemPrompt: string,
  userPrompt: string
): Promise<ReviewOutput> {
  switch (config.provider) {
    case "openai":
      return callOpenAI(config, systemPrompt, userPrompt);
    case "google":
      return callGoogle(config, systemPrompt, userPrompt);
    case "anthropic":
      return callAnthropic(config, systemPrompt, userPrompt);
  }
}

async function callOpenAI(
  config: ReviewerConfig,
  systemPrompt: string,
  userPrompt: string
): Promise<ReviewOutput> {
  const client = new OpenAI({ apiKey: config.providerApiKey });
  const response = await client.chat.completions.create({
    model: config.providerModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    // Reasoning models (GPT-5) consume this budget for hidden reasoning tokens
    // as well as output. 8192 was too tight — reasoning sometimes exhausted the
    // budget before producing any output, yielding empty reviews. 16384 gives
    // enough runway for both a full adversarial analysis AND a detailed output.
    // See mt#1125 for the empty-review failure mode this mitigates.
    max_completion_tokens: 16384,
    // Explicit reasoning_effort for predictability — "medium" is the GPT-5
    // default; declaring it removes dependence on future default changes.
    reasoning_effort: "medium",
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
