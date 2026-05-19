/**
 * Relevance classifier for the principal-corpus.
 *
 * Uses a cost-efficient model (Claude Haiku) to score each tweet's
 * relevance to the principal's Minsky intellectual substrate. Tweets
 * scoring ≥ 0.5 are kept. Personal observations, mundane status
 * updates, jokes-without-content, and noise are dropped.
 *
 * Originating task: mt#1930.
 */

import { z } from "zod";
import type { TweetRecord } from "./types";
import { createCompletionService } from "../ai/service-factory";
import { getConfiguration } from "../configuration";
import type { ResolvedConfig, BackendConfig } from "../configuration/types";
import { log } from "../../utils/logger";

const JUDGING_MODEL = "claude-haiku-4-5-20251001";
const JUDGING_PROVIDER = "anthropic";

const classificationSchema = z.object({
  relevance: z.number().min(0).max(1),
  theme: z.string().max(64).optional(),
  reason: z.string().max(160).optional(),
});

export type TweetClassification = z.infer<typeof classificationSchema>;

export interface ClassifyOptions {
  concurrency?: number;
  /** Score at or above which a tweet is kept. Default 0.5. */
  relevanceThreshold?: number;
  /** Hard upper bound on tweets to classify (debug). */
  limit?: number;
}

export interface ClassifyResult {
  kept: TweetRecord[];
  dropped: TweetRecord[];
  classifications: Map<string, TweetClassification>;
  failed: number;
}

const SYSTEM_PROMPT = `You are a relevance classifier for a corpus of tweets by an AI-product builder. The goal is to keep tweets that articulate concepts, frameworks, observations, or arguments — the kind of tweet a future reader could quote in a position paper about the author's thinking.

Score 1.0: tweets articulating a concept, framework, hot take, or argument. Theory-laden, citation-worthy, naming a non-obvious distinction.

Score 0.7-0.9: tweets that gesture at a concept or use loaded vocabulary (cybernetics, exocortex, attention, mesh, agents, principal, declaration, intent, etc.) even if not fully articulated.

Score 0.5-0.6: borderline — has some intellectual content but mostly personal/observational.

Score 0.2-0.4: personal status, jokes-without-content, mundane events, social signals.

Score 0.0-0.1: noise — single emoji, "lol", food/social pics, etc.

The corpus author writes about:
- AI agents, agent systems, multi-agent orchestration, agent autonomy
- Cognitive engineering, cybernetics, attention economics, exocortex
- Software engineering, programming-language theory, type systems
- Operative ontology, magick-as-substrate, declaration, intent, will
- Society of mind, ego plurality, Manfred Macx-style cognitive extension
- Cockpit / mission control / mesh / asks subsystem (Minsky product terms)
- Tools, infrastructure, platforms, build-vs-buy decisions
- Cultural codes, brand semiotics, marketing structure (recent)

Return a strict JSON object: {"relevance": <0-1>, "theme": "<short tag>", "reason": "<≤20 words>"}.`;

/**
 * Classify all tweets and partition into kept/dropped based on the
 * relevance threshold. Concurrent batching honors the configured limit.
 */
export async function classifyAndFilterTweets(
  tweets: TweetRecord[],
  opts: ClassifyOptions = {}
): Promise<ClassifyResult> {
  const concurrency = Math.max(1, Math.min(16, opts.concurrency ?? 4));
  const threshold = typeof opts.relevanceThreshold === "number" ? opts.relevanceThreshold : 0.5;
  const limit = opts.limit && opts.limit > 0 ? opts.limit : tweets.length;
  const slice = tweets.slice(0, limit);

  const cfg = await getConfiguration();
  const resolvedConfig: ResolvedConfig = {
    backendConfig: cfg.backendConfig as BackendConfig,
    persistence: cfg.persistence,
    github: cfg.github,
    ai: cfg.ai,
    logger: cfg.logger,
    tasks: cfg.tasks as Record<string, unknown> | undefined,
  };
  const completionService = createCompletionService(resolvedConfig);

  const classifications = new Map<string, TweetClassification>();
  let failed = 0;
  let i = 0;

  const worker = async () => {
    while (true) {
      const idx = i++;
      if (idx >= slice.length) break;
      const tweet = slice[idx];
      if (!tweet) break;
      try {
        const result = await classifyOne(completionService, tweet);
        classifications.set(tweet.id, result);
      } catch (err) {
        failed++;
        log.warn("[relevance-filter] classification failed", {
          tweetId: tweet.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const kept: TweetRecord[] = [];
  const dropped: TweetRecord[] = [];
  for (const tweet of slice) {
    const c = classifications.get(tweet.id);
    if (c && c.relevance >= threshold) {
      kept.push(tweet);
    } else {
      dropped.push(tweet);
    }
  }
  return { kept, dropped, classifications, failed };
}

async function classifyOne(
  completionService: ReturnType<typeof createCompletionService>,
  tweet: TweetRecord
): Promise<TweetClassification> {
  const userPrompt = `Tweet ID: ${tweet.id}
Created: ${tweet.createdAt}
Engagement: ${tweet.favoriteCount} likes, ${tweet.retweetCount} RTs
Text:
${tweet.text}

Classify this tweet's relevance to the corpus author's intellectual substrate.`;

  const result = await completionService.generateObject({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    schema: classificationSchema,
    model: JUDGING_MODEL,
    provider: JUDGING_PROVIDER,
    temperature: 0.0,
    maxTokens: 200,
  });
  return result as TweetClassification;
}
