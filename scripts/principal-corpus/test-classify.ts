#!/usr/bin/env bun
/**
 * One-off diagnostic script: run the relevance filter against a small
 * sample and surface failure reasons. Not part of production code.
 */

import "reflect-metadata";
import { setupConfiguration } from "../../src/config-setup";
import { parseTwitterArchive } from "@minsky/domain/principal-corpus/tweet-archive-parser";
import { classifyAndFilterTweets } from "@minsky/domain/principal-corpus/relevance-filter";

async function main() {
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
  if (!archiveZip || !accountUserId || !screenName) {
    console.error(
      "Usage: bun scripts/principal-corpus/test-classify.ts --archive=<path> --account-id=<id> --screen-name=<handle>"
    );
    console.error("Or set PRINCIPAL_CORPUS_{ARCHIVE,ACCOUNT_ID,SCREEN_NAME} env vars.");
    process.exit(2);
  }

  await setupConfiguration();
  const parsed = parseTwitterArchive({
    zipPath: archiveZip,
    accountUserId,
    screenName,
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
