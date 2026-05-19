#!/usr/bin/env bun
/**
 * One-off diagnostic script: run the relevance filter against a small
 * sample and surface failure reasons. Not part of production code.
 */

import "reflect-metadata";
import { setupConfiguration } from "../../src/config-setup";
import { parseTwitterArchive } from "../../src/domain/principal-corpus/tweet-archive-parser";
import { classifyAndFilterTweets } from "../../src/domain/principal-corpus/relevance-filter";

async function main() {
  await setupConfiguration();
  const parsed = parseTwitterArchive({
    zipPath:
      "/Users/edobry/Downloads/twitter-2025-09-21-7b577fd37a1599577caac86a86d9f0a69b739bb5a741dce078dba1ffa9237906.zip",
    accountUserId: "1278573670739464192",
    screenName: "pee_zombie",
  });

  const sample = parsed.originals.slice(0, 50);
  console.log(`Classifying ${sample.length} tweets...`);
  const t0 = Date.now();
  const result = await classifyAndFilterTweets(sample, {
    concurrency: 6,
    relevanceThreshold: 0.5,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `Done in ${elapsed}s. kept=${result.kept.length} dropped=${result.dropped.length} failed=${result.failed}`
  );

  const classified = result.classifications.size;
  console.log(`Classified ${classified}/${sample.length} (missing: ${sample.length - classified})`);

  const missingIds = sample
    .filter((t) => !result.classifications.has(t.id))
    .map((t) => ({ id: t.id, text: t.text.slice(0, 80) }));
  if (missingIds.length > 0) {
    console.log("Missing classifications:");
    for (const m of missingIds) console.log(`  ${m.id}: ${m.text}`);
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
