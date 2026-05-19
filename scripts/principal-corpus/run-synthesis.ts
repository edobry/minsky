#!/usr/bin/env bun
/**
 * Phase 2 of the principal-corpus pipeline (mt#1930): synthesize
 * memeplex entries from the classified corpus and write them to the
 * product memory store via `memory_create`.
 *
 * Reads the classifier cache + parsed archive, runs the synthesis pass,
 * and writes ~15-25 cluster-level entries.
 */

import "reflect-metadata";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { setupConfiguration } from "../../src/config-setup";
import { parseTwitterArchive } from "../../src/domain/principal-corpus/tweet-archive-parser";
import {
  synthesizeMemeplexes,
  type TweetForSynthesis,
} from "../../src/domain/principal-corpus/memeplex-synthesizer";

const ARCHIVE_ZIP =
  "/Users/edobry/Downloads/twitter-2025-09-21-7b577fd37a1599577caac86a86d9f0a69b739bb5a741dce078dba1ffa9237906.zip";
const ACCOUNT_USER_ID = "1278573670739464192";
const SCREEN_NAME = "pee_zombie";
const FILTER_CACHE = "tmp/principal-corpus-classifications.json";
const MEMEPLEX_OUT = "tmp/principal-corpus-memeplexes.json";

interface CachedClassification {
  id: string;
  relevance: number;
  theme?: string;
}

async function main() {
  mkdirSync("tmp", { recursive: true });
  await setupConfiguration();

  if (!existsSync(FILTER_CACHE)) {
    throw new Error(`Classifier cache not found at ${FILTER_CACHE} — run ingestion first`);
  }

  const raw = JSON.parse(String(readFileSync(FILTER_CACHE, { encoding: "utf8" })));
  const cache = new Map<string, CachedClassification>();
  for (const row of raw as CachedClassification[]) cache.set(row.id, row);
  console.log(`[synth] loaded ${cache.size} classifications`);

  const parsed = parseTwitterArchive({
    zipPath: ARCHIVE_ZIP,
    accountUserId: ACCOUNT_USER_ID,
    screenName: SCREEN_NAME,
  });

  const tweets: TweetForSynthesis[] = parsed.originals
    .map((t) => {
      const c = cache.get(t.id);
      return { ...t, relevance: c?.relevance, theme: c?.theme };
    })
    .filter((t): t is TweetForSynthesis => (t.relevance ?? 0) >= 0.7);

  console.log(
    `[synth] ${tweets.length} tweets at relevance ≥ 0.7 will be surfaced to the synthesizer`
  );

  if (tweets.length === 0) {
    throw new Error("No tweets above the relevance floor — classifier pass may be incomplete");
  }

  const memeplexes = await synthesizeMemeplexes(tweets, {
    maxMemeplexes: 25,
    maxTweets: 600,
    relevanceFloor: 0.7,
  });

  console.log(`[synth] synthesized ${memeplexes.length} memeplexes:`);
  for (const m of memeplexes) {
    console.log(`  - ${m.name} (theme: ${m.theme}, cites ${m.citations.length})`);
  }

  writeFileSync(MEMEPLEX_OUT, JSON.stringify(memeplexes, null, 2));
  console.log(`[synth] wrote ${memeplexes.length} memeplexes to ${MEMEPLEX_OUT}`);
}

main().catch((err) => {
  console.error("[synth] FATAL:", err);
  process.exit(1);
});
