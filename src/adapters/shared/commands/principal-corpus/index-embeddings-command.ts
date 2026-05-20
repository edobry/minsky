/**
 * principal_corpus.index-embeddings command — ingest the principal's
 * Twitter archive into the `principal-corpus` namespace (mt#1930).
 *
 * Phases:
 *   1. Parse the archive ZIP, retain originals (drop retweets +
 *      replies-to-others, keep self-threads).
 *   2. Optionally run an LLM relevance filter (Haiku-class) to drop
 *      personal/observational/nonsense tweets.
 *   3. Embed each kept tweet and write to the vector store with the
 *      tweet metadata.
 */

import { z } from "zod";
import { composeParams, CommonParameters } from "../../common-parameters";
import type { CommandExecutionContext } from "../../command-registry";
import type { CommandParameterMap } from "../../schema-bridge";
import { parseTwitterArchive } from "../../../../domain/principal-corpus/tweet-archive-parser";
import { createPrincipalCorpusService } from "../../../../domain/principal-corpus/principal-corpus-service";
import { classifyAndFilterTweets } from "../../../../domain/principal-corpus/relevance-filter";
import { resolvePersistenceFromCtx } from "../principal-corpus";
import type { TweetRecord } from "../../../../domain/principal-corpus/types";
import { readFileSync, existsSync, writeFileSync } from "fs";

export interface PrincipalCorpusIndexEmbeddingsParams {
  archivePath: string;
  accountUserId: string;
  screenName: string;
  filterPath?: string;
  skipFilter?: boolean;
  limit?: number;
  concurrency?: number;
  json?: boolean;
}

export const principalCorpusIndexEmbeddingsParams = composeParams(
  {
    archivePath: {
      schema: z.string().min(1),
      description: "Path to the Twitter archive ZIP",
      required: true,
    },
    accountUserId: {
      schema: z.string().min(1),
      description: "Principal's Twitter user_id (numeric string)",
      required: true,
    },
    screenName: {
      schema: z.string().min(1),
      description: "Principal's @-handle (without the @)",
      required: true,
    },
    filterPath: {
      schema: z.string().min(1),
      description:
        "Path to a JSON file of classifier results to reuse (skips classifier when present)",
      required: false,
    },
    skipFilter: {
      schema: z.boolean(),
      description: "If true, index every original tweet without running the relevance classifier",
      required: false,
      defaultValue: false,
    },
    limit: {
      schema: z.number().int().positive(),
      description: "Max number of tweets to index (debug aid)",
      required: false,
    },
    concurrency: {
      schema: z.number().int().positive(),
      description: "Concurrent embedding requests (default 4)",
      required: false,
      defaultValue: 4,
    },
  },
  {
    json: CommonParameters.json,
  }
) satisfies CommandParameterMap;

export class PrincipalCorpusIndexEmbeddingsCommand {
  readonly id = "principal_corpus.index-embeddings";
  readonly name = "index-embeddings";
  readonly description =
    "Ingest the principal's Twitter archive into the principal-corpus embedding namespace";
  readonly parameters = principalCorpusIndexEmbeddingsParams;

  async execute(
    params: PrincipalCorpusIndexEmbeddingsParams,
    ctx: CommandExecutionContext
  ): Promise<{
    success: boolean;
    parsed: number;
    droppedRetweets: number;
    droppedRepliesToOthers: number;
    classifierKept: number;
    classifierDropped: number;
    classifierSkipped: boolean;
    indexed: number;
    skipped: number;
    failed: number;
  }> {
    const { log } = await import("../../../../utils/logger");
    const isJson = Boolean(params.json) || ctx.format === "json";

    if (!isJson) log.cli(`[principal-corpus] parsing ${params.archivePath}...`);
    const parsed = parseTwitterArchive({
      zipPath: params.archivePath,
      accountUserId: params.accountUserId,
      screenName: params.screenName,
    });
    if (!isJson) {
      log.cli(
        `[principal-corpus] parsed ${parsed.total} entries → ${parsed.originals.length} originals ` +
          `(dropped: ${parsed.dropped.retweets} retweets, ${parsed.dropped.repliesToOthers} replies-to-others)`
      );
    }

    let toIndex: TweetRecord[] = parsed.originals;
    let classifierKept = parsed.originals.length;
    let classifierDropped = 0;
    const classifierSkipped = Boolean(params.skipFilter);
    let classifierMap = new Map<string, { relevance: number; theme?: string }>();

    if (!classifierSkipped) {
      if (params.filterPath && existsSync(params.filterPath)) {
        if (!isJson)
          log.cli(`[principal-corpus] loading classifier results from ${params.filterPath}...`);
        const filterBuf = readFileSync(params.filterPath, { encoding: "utf8" });
        const raw = JSON.parse(String(filterBuf));
        if (!Array.isArray(raw)) {
          throw new Error(`Filter file at ${params.filterPath} did not contain a JSON array`);
        }
        for (const row of raw as Array<{
          id: string;
          relevance: number;
          theme?: string;
        }>) {
          classifierMap.set(row.id, { relevance: row.relevance, theme: row.theme });
        }
        toIndex = parsed.originals.filter((t) => {
          const c = classifierMap.get(t.id);
          if (!c) return false;
          return c.relevance >= 0.5;
        });
        classifierKept = toIndex.length;
        classifierDropped = parsed.originals.length - toIndex.length;
      } else {
        if (!isJson) log.cli(`[principal-corpus] classifying ${parsed.originals.length} tweets...`);
        const result = await classifyAndFilterTweets(parsed.originals, {
          concurrency: params.concurrency ?? 4,
          relevanceThreshold: 0.5,
        });
        classifierMap = result.classifications;
        toIndex = result.kept;
        classifierKept = result.kept.length;
        classifierDropped = result.dropped.length;
        if (params.filterPath) {
          const entries: Array<[string, { relevance: number; theme?: string }]> = Array.from(
            result.classifications.entries()
          );
          const serialized = entries.map(([id, v]) => ({
            id,
            relevance: v.relevance,
            theme: v.theme,
          }));
          writeFileSync(params.filterPath, JSON.stringify(serialized, null, 2));
          if (!isJson)
            log.cli(`[principal-corpus] wrote classifier results to ${params.filterPath}`);
        }
      }
    }

    if (typeof params.limit === "number" && params.limit > 0) {
      toIndex = toIndex.slice(0, params.limit);
    }

    if (!isJson) log.cli(`[principal-corpus] embedding ${toIndex.length} tweets...`);

    const persistence = resolvePersistenceFromCtx(ctx, "principal_corpus.index-embeddings");
    const service = await createPrincipalCorpusService(persistence);

    let indexed = 0;
    let skipped = 0;
    let failed = 0;
    let i = 0;
    const concurrency = Math.max(1, Math.min(16, params.concurrency ?? 4));

    const worker = async () => {
      while (true) {
        const idx = i++;
        if (idx >= toIndex.length) break;
        const tweet = toIndex[idx];
        if (!tweet) break;
        try {
          const classification = classifierMap.get(tweet.id);
          const changed = await service.indexTweet(tweet, classification);
          if (changed) indexed++;
          else skipped++;
        } catch (err) {
          failed++;
          log.warn(
            `[principal-corpus] embed failed for ${tweet.id}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (!isJson) {
      log.cli(
        `[principal-corpus] indexed ${indexed}, skipped ${skipped}, failed ${failed}; ` +
          `classifier kept ${classifierKept}, dropped ${classifierDropped}${
            classifierSkipped ? " (classifier skipped)" : ""
          }`
      );
    }

    return {
      success: failed === 0,
      parsed: parsed.originals.length,
      droppedRetweets: parsed.dropped.retweets,
      droppedRepliesToOthers: parsed.dropped.repliesToOthers,
      classifierKept,
      classifierDropped,
      classifierSkipped,
      indexed,
      skipped,
      failed,
    };
  }
}

export function createPrincipalCorpusIndexEmbeddingsCommand(): PrincipalCorpusIndexEmbeddingsCommand {
  return new PrincipalCorpusIndexEmbeddingsCommand();
}
