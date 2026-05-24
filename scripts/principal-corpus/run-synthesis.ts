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

/**
 * Required inputs (CLI args or env vars; no defaults — see run-ingestion.ts):
 *   --archive=<path>     | PRINCIPAL_CORPUS_ARCHIVE
 *   --account-id=<id>    | PRINCIPAL_CORPUS_ACCOUNT_ID
 *   --screen-name=<h>    | PRINCIPAL_CORPUS_SCREEN_NAME
 */
const FILTER_CACHE = "tmp/principal-corpus-classifications.json";
const MEMEPLEX_OUT = "tmp/principal-corpus-memeplexes.json";

function parseArgsAndEnv(): { archiveZip: string; accountUserId: string; screenName: string } {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match && match[1] !== undefined && match[2] !== undefined) {
      args.set(match[1], match[2]);
    }
  }
  const archiveZip = args.get("archive") ?? process.env.PRINCIPAL_CORPUS_ARCHIVE ?? "";
  const accountUserId = args.get("account-id") ?? process.env.PRINCIPAL_CORPUS_ACCOUNT_ID ?? "";
  const screenName = args.get("screen-name") ?? process.env.PRINCIPAL_CORPUS_SCREEN_NAME ?? "";
  const missing: string[] = [];
  if (!archiveZip) missing.push("--archive=<path> (or PRINCIPAL_CORPUS_ARCHIVE)");
  if (!accountUserId) missing.push("--account-id=<id> (or PRINCIPAL_CORPUS_ACCOUNT_ID)");
  if (!screenName) missing.push("--screen-name=<handle> (or PRINCIPAL_CORPUS_SCREEN_NAME)");
  if (missing.length > 0) {
    console.error("[synth] missing required inputs:");
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(2);
  }
  return { archiveZip, accountUserId, screenName };
}

interface CachedClassification {
  id: string;
  relevance: number;
  theme?: string;
}

async function main() {
  const { archiveZip, accountUserId, screenName } = parseArgsAndEnv();
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
    zipPath: archiveZip,
    accountUserId,
    screenName,
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
