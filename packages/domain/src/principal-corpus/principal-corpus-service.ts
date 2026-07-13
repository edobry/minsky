/**
 * Principal-corpus service.
 *
 * Wraps the embedding service + vector storage with the corpus-specific
 * content extraction and metadata shape. Originating task: mt#1930.
 *
 * Architectural decision (mt#1930): the principal-corpus is intentionally a
 * separate namespace from the product `memory_*` store. The product store
 * holds "durable findings not derivable from code, git history, specs, or
 * rules" per CLAUDE.md `§Memory Usage`; the principal-corpus holds raw
 * tweets (derivable from the local Twitter archive), so it does not satisfy
 * that inclusion criterion.
 */

import { injectable } from "tsyringe";
import { createHash } from "crypto";
import type { EmbeddingService } from "../ai/embeddings/types";
import type { VectorStorage } from "../storage/vector/types";
import type { PersistenceProvider } from "../persistence/types";
import { createEmbeddingServiceFromConfig } from "../ai/embedding-service-factory";
import { createVectorStorageForDomain } from "../storage/vector/vector-storage-factory";
import { getConfiguration } from "../configuration";
import { getEmbeddingDimension } from "../ai/embedding-models";
import { log } from "@minsky/shared/logger";
import type {
  TweetRecord,
  TweetMetadata,
  PrincipalCorpusSearchResponse,
  PrincipalCorpusSearchResult,
} from "./types";

export interface PrincipalCorpusServiceConfig {
  model?: string;
  dimension?: number;
}

@injectable()
export class PrincipalCorpusService {
  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly vectorStorage: VectorStorage,
    private readonly config: PrincipalCorpusServiceConfig = {}
  ) {}

  /**
   * Index a single tweet. Returns true if a new embedding was written,
   * false if the existing entry was up-to-date (content hash unchanged).
   */
  async indexTweet(
    tweet: TweetRecord,
    classifier?: { relevance?: number; theme?: string }
  ): Promise<boolean> {
    const content = this.extractContent(tweet);
    const contentHash = createHash("sha256").update(content).digest("hex");

    // Skip if up-to-date
    try {
      if (typeof this.vectorStorage.getMetadata === "function") {
        const existing = await this.vectorStorage.getMetadata(tweet.id);
        const storedHash = existing?.content_hash || existing?.contentHash;
        const storedModel = (existing?.metadata as Record<string, unknown> | undefined)?.model;
        const currentModel = this.config.model;
        if (
          storedHash &&
          storedHash === contentHash &&
          (!storedModel || storedModel === currentModel)
        ) {
          return false;
        }
      }
    } catch {
      // ignore metadata read errors
    }

    const vector = await this.embeddingService.generateEmbedding(content);
    const metadata: Record<string, unknown> = {
      text: tweet.text,
      created_at: tweet.createdAt,
      favorite_count: tweet.favoriteCount,
      retweet_count: tweet.retweetCount,
      reply_count: tweet.replyCount,
      in_reply_to_status_id: tweet.inReplyToStatusId ?? null,
      in_reply_to_user_id: tweet.inReplyToUserId ?? null,
      url: tweet.url,
      relevance: classifier?.relevance,
      classifier_theme: classifier?.theme,
      contentHash,
      model: this.config.model,
    };

    await this.vectorStorage.store(tweet.id, vector, metadata);
    return true;
  }

  /**
   * Semantic search over the corpus.
   */
  async searchByText(query: string, limit = 10): Promise<PrincipalCorpusSearchResponse> {
    if (!query || query.trim().length === 0) {
      return { results: [], backend: "none", degraded: false };
    }

    try {
      const vector = await this.embeddingService.generateEmbedding(query);
      const rawResults = await this.vectorStorage.search(vector, { limit });
      const results = await this.enrichResults(rawResults);
      return { results, backend: "embeddings", degraded: false };
    } catch (error) {
      log.warn("[principal-corpus] search failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        results: [],
        backend: "none",
        degraded: true,
        degradedReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Similarity by tweet ID. Loads the tweet's stored text from metadata,
   * then performs a semantic search using that text as the query.
   */
  async similar(tweetId: string, limit = 10): Promise<PrincipalCorpusSearchResponse> {
    if (typeof this.vectorStorage.getMetadata !== "function") {
      return {
        results: [],
        backend: "none",
        degraded: true,
        degradedReason: "vector storage does not expose getMetadata",
      };
    }
    const meta = await this.vectorStorage.getMetadata(tweetId);
    if (!meta) {
      return { results: [], backend: "none", degraded: false };
    }
    const metadataInner = (meta.metadata as Record<string, unknown> | undefined) ?? {};
    const text =
      (metadataInner.text as string | undefined) || ((meta.text as string | undefined) ?? "");
    if (!text) {
      return {
        results: [],
        backend: "none",
        degraded: true,
        degradedReason: "tweet has no text in metadata",
      };
    }

    const response = await this.searchByText(text, limit + 1);
    // Exclude the source tweet from results.
    return {
      ...response,
      results: response.results.filter((r) => r.id !== tweetId).slice(0, limit),
    };
  }

  /**
   * Fetch a single tweet's metadata by ID. Returns null when not indexed.
   */
  async getTweet(tweetId: string): Promise<TweetMetadata | null> {
    if (typeof this.vectorStorage.getMetadata !== "function") {
      return null;
    }
    const meta = await this.vectorStorage.getMetadata(tweetId);
    if (!meta) {
      return null;
    }
    const inner = (meta.metadata as Record<string, unknown> | undefined) ?? {};
    return this.toTweetMetadata(inner);
  }

  /**
   * The text representation embedded into the vector. Currently just the
   * tweet text — engagement metadata is intentionally NOT embedded, since
   * popularity is a separate signal from semantics.
   */
  private extractContent(tweet: TweetRecord): string {
    return tweet.text;
  }

  private async enrichResults(
    raw: Array<{ id: string; score: number }>
  ): Promise<PrincipalCorpusSearchResult[]> {
    const enriched: PrincipalCorpusSearchResult[] = [];
    for (const item of raw) {
      const meta = await this.getTweet(item.id);
      enriched.push({
        id: item.id,
        score: item.score,
        metadata: meta ?? undefined,
      });
    }
    return enriched;
  }

  private toTweetMetadata(raw: Record<string, unknown>): TweetMetadata {
    return {
      text: String(raw.text ?? ""),
      created_at: String(raw.created_at ?? raw.createdAt ?? ""),
      favorite_count: Number(raw.favorite_count ?? raw.favoriteCount ?? 0),
      retweet_count: Number(raw.retweet_count ?? raw.retweetCount ?? 0),
      reply_count: Number(raw.reply_count ?? raw.replyCount ?? 0),
      in_reply_to_status_id:
        (raw.in_reply_to_status_id as string | null | undefined) ??
        (raw.inReplyToStatusId as string | null | undefined) ??
        null,
      in_reply_to_user_id:
        (raw.in_reply_to_user_id as string | null | undefined) ??
        (raw.inReplyToUserId as string | null | undefined) ??
        null,
      url: String(raw.url ?? ""),
      relevance: typeof raw.relevance === "number" ? raw.relevance : undefined,
      classifier_theme: typeof raw.classifier_theme === "string" ? raw.classifier_theme : undefined,
    };
  }
}

/**
 * Build a PrincipalCorpusService from a persistence provider. Resolves the
 * embedding model from configuration and routes vector storage to the
 * `principal-corpus` namespace.
 */
export async function createPrincipalCorpusService(
  persistenceProvider: PersistenceProvider
): Promise<PrincipalCorpusService> {
  const cfg = await getConfiguration();
  const model =
    (cfg as Record<string, unknown>)?.embeddings &&
    typeof (cfg as Record<string, unknown>).embeddings === "object"
      ? ((cfg as { embeddings: { model?: string } }).embeddings.model ?? "text-embedding-3-small")
      : "text-embedding-3-small";
  const dimension = getEmbeddingDimension(model, 1536);

  const embedding = await createEmbeddingServiceFromConfig();
  const vectorStorage = await createVectorStorageForDomain(
    "principal-corpus",
    dimension,
    persistenceProvider
  );

  return new PrincipalCorpusService(embedding, vectorStorage, { model, dimension });
}
