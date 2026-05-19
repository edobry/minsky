#!/usr/bin/env bun
/**
 * Full principal-corpus ingestion pipeline (mt#1930).
 *
 * Steps:
 *  1. Parse the Twitter archive → originals (drop retweets, drop replies-to-others).
 *  2. Run Haiku relevance classifier on the full corpus (resumable via filter cache).
 *  3. Embed every kept tweet (threshold ≥ 0.5) into the `principal-corpus`
 *     vector namespace on the shared pgvector primitive.
 *
 * Outputs:
 *   - tmp/principal-corpus-classifications.json (cache for re-runs)
 *   - tmp/principal-corpus-stats.json
 */

import "reflect-metadata";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { setupConfiguration } from "../../src/config-setup";
import { parseTwitterArchive } from "../../src/domain/principal-corpus/tweet-archive-parser";
import { classifyAndFilterTweets } from "../../src/domain/principal-corpus/relevance-filter";
import { createPrincipalCorpusService } from "../../src/domain/principal-corpus/principal-corpus-service";
import type { TweetRecord } from "../../src/domain/principal-corpus/types";

const ARCHIVE_ZIP =
  "/Users/edobry/Downloads/twitter-2025-09-21-7b577fd37a1599577caac86a86d9f0a69b739bb5a741dce078dba1ffa9237906.zip";
const ACCOUNT_USER_ID = "1278573670739464192";
const SCREEN_NAME = "pee_zombie";
const FILTER_CACHE = "tmp/principal-corpus-classifications.json";
const STATS_OUT = "tmp/principal-corpus-stats.json";
const RELEVANCE_THRESHOLD = 0.5;
const CLASSIFIER_CONCURRENCY = 8;
const EMBEDDING_CONCURRENCY = 4;

interface CachedClassification {
  id: string;
  relevance: number;
  theme?: string;
}

async function main() {
  mkdirSync("tmp", { recursive: true });
  await setupConfiguration();

  // ----- 1. Parse archive -----
  console.log(`[ingest] parsing archive ${ARCHIVE_ZIP}...`);
  const parsed = parseTwitterArchive({
    zipPath: ARCHIVE_ZIP,
    accountUserId: ACCOUNT_USER_ID,
    screenName: SCREEN_NAME,
  });
  console.log(
    `[ingest] parsed ${parsed.total} entries → ${parsed.originals.length} originals ` +
      `(dropped: ${parsed.dropped.retweets} retweets, ${parsed.dropped.repliesToOthers} replies-to-others)`
  );

  // ----- 2. Classify (resumable) -----
  const cache = new Map<string, CachedClassification>();
  if (existsSync(FILTER_CACHE)) {
    const raw = JSON.parse(String(readFileSync(FILTER_CACHE, { encoding: "utf8" })));
    for (const row of raw as CachedClassification[]) {
      cache.set(row.id, row);
    }
    console.log(`[ingest] loaded ${cache.size} cached classifications`);
  }
  const toClassify = parsed.originals.filter((t) => !cache.has(t.id));
  if (toClassify.length > 0) {
    console.log(`[ingest] classifying ${toClassify.length} new tweets...`);
    const t0 = Date.now();
    const result = await classifyAndFilterTweets(toClassify, {
      concurrency: CLASSIFIER_CONCURRENCY,
      relevanceThreshold: RELEVANCE_THRESHOLD,
    });
    for (const [id, v] of result.classifications.entries()) {
      cache.set(id, { id, relevance: v.relevance, theme: v.theme });
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `[ingest] classifier elapsed=${elapsed}s, kept=${result.kept.length}, dropped=${result.dropped.length}, failed=${result.failed}`
    );
    writeFileSync(FILTER_CACHE, JSON.stringify([...cache.values()], null, 2));
    console.log(`[ingest] wrote classifier cache to ${FILTER_CACHE}`);
  } else {
    console.log(`[ingest] classifier cache is complete — no new tweets to classify`);
  }

  // ----- 3. Partition + embed -----
  const kept: TweetRecord[] = parsed.originals.filter((t) => {
    const c = cache.get(t.id);
    return c !== undefined && c.relevance >= RELEVANCE_THRESHOLD;
  });
  console.log(
    `[ingest] kept ${kept.length} tweets (relevance ≥ ${RELEVANCE_THRESHOLD}) for embedding`
  );

  const { resolvePersistenceProvider } = await import("../../src/domain/persistence/factory");
  const persistence = await resolvePersistenceProvider();
  if (!persistence) {
    throw new Error("Could not resolve persistence provider — check config and DB availability");
  }
  const service = await createPrincipalCorpusService(persistence);

  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  let i = 0;

  const worker = async () => {
    while (true) {
      const idx = i++;
      if (idx >= kept.length) break;
      const tweet = kept[idx];
      if (!tweet) break;
      const c = cache.get(tweet.id);
      try {
        const changed = await service.indexTweet(tweet, {
          relevance: c?.relevance,
          theme: c?.theme,
        });
        if (changed) indexed++;
        else skipped++;
        if ((indexed + skipped) % 100 === 0) {
          console.log(
            `[ingest] progress: indexed=${indexed} skipped=${skipped} failed=${failed} (of ${kept.length})`
          );
        }
      } catch (err) {
        failed++;
        console.error(
          `[ingest] embed FAIL ${tweet.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  };

  console.log(`[ingest] embedding with concurrency=${EMBEDDING_CONCURRENCY}...`);
  const t0 = Date.now();
  await Promise.all(Array.from({ length: EMBEDDING_CONCURRENCY }, () => worker()));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[ingest] embedding done in ${elapsed}s. indexed=${indexed} skipped=${skipped} failed=${failed}`
  );

  // ----- 4. Stats -----
  const stats = {
    archive: {
      zipPath: ARCHIVE_ZIP,
      total: parsed.total,
      originals: parsed.originals.length,
      dropped: parsed.dropped,
    },
    classifier: {
      classified: cache.size,
      kept: kept.length,
      threshold: RELEVANCE_THRESHOLD,
    },
    embedding: {
      indexed,
      skipped,
      failed,
      elapsedSeconds: Number(elapsed),
    },
    completedAt: new Date().toISOString(),
  };
  writeFileSync(STATS_OUT, JSON.stringify(stats, null, 2));
  console.log(`[ingest] wrote stats to ${STATS_OUT}`);
}

main().catch((err) => {
  console.error("[ingest] FATAL:", err);
  process.exit(1);
});
