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

export interface ReviewOutput {
  text: string;
  tokensUsed?: number;
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
    max_completion_tokens: 8192,
  });

  const text = response.choices[0]?.message?.content ?? "";
  return {
    text,
    tokensUsed: response.usage?.total_tokens,
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
  return {
    text,
    tokensUsed: response.response.usageMetadata?.totalTokenCount,
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

  return {
    text,
    tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
    provider: "anthropic",
    model: config.providerModel,
  };
}
