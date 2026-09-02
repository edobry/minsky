import { injectable } from "tsyringe";
import type { SearchResult } from "../storage/vector/types";
import { PersistenceProvider } from "../persistence/types";
import { createRuleSimilarityCore } from "../similarity/create-rule-similarity-core";
import { EmbeddingsSimilarityBackend } from "../similarity/backends/embeddings-backend";
import { LexicalSimilarityBackend } from "../similarity/backends/lexical-backend";
import { createHash } from "crypto";
import { log } from "@minsky/shared/logger";
import { resolveWorkspacePath } from "../workspace";

export interface RuleSimilarityServiceConfig {
  similarityThreshold?: number; // maximum distance for inclusion (backend-specific semantics)
}

/**
 * RuleSimilarityService: embedding-based rule retrieval
 */
@injectable()
export class RuleSimilarityService {
  constructor(
    private readonly persistence: PersistenceProvider,
    private readonly workspacePath: string,
    private readonly config: RuleSimilarityServiceConfig = {}
  ) {}

  /**
   * @deprecated Use constructor with PersistenceProvider instead
   */
  static createWithWorkspacePath(
    workspacePath: string,
    config: RuleSimilarityServiceConfig = {}
  ): RuleSimilarityService {
    // Concrete no-op subclass used as a backward-compat stub — persistence is unused in this class.
    class StubPersistenceProvider extends PersistenceProvider {
      readonly capabilities = {
        vectorStorage: true as const,
        sql: true as const,
        transactions: true as const,
        jsonb: true as const,
        migrations: true as const,
      };
      getCapabilities() {
        return this.capabilities;
      }
      async initialize() {}
      async close() {}
      getConnectionInfo() {
        return "stub";
      }
    }

    return new RuleSimilarityService(new StubPersistenceProvider(), workspacePath, config);
  }

  /**
   * Search rules by natural language query using embeddings.
   *
   * `threshold` is a minimum SIMILARITY — higher is more similar (mt#4805).
   *
   * It was accepted here and silently dropped: declared on the signature, never
   * read, so `suggestRules`' documented "Minimum similarity threshold for
   * agent-requested rules" (`rule-suggestion-enhanced.ts`) had no effect and the
   * `threshold: 0.1` that `workspace-rules.ts` passes did nothing. Same shape as
   * the tasks-side defect mt#3305 fixed, on the third of the three services that
   * share this backend — found while enumerating consumers for mt#4805.
   *
   * Applied on every backend. `SimilarityItem.score` guarantees DIRECTION across
   * backends but not UNITS, so a threshold calibrated against cosine similarity
   * over-filters `lexical-backend`'s Jaccard coefficient — but it over-filters in
   * the right direction, keeping the best matches. Silently dropping the filter
   * instead is the failure mt#3305 was filed for, and the degraded flag on
   * `SimilaritySearchResponse` is what tells a caller which backend answered.
   */
  async searchByText(query: string, limit = 10, threshold?: number): Promise<SearchResult[]> {
    const core = await createRuleSimilarityCore(this.workspacePath, {
      persistenceProvider: this.persistence,
    });
    const response = await core.search({ queryText: query, limit });
    // Map to SearchResult shape (id/score compatible)
    const results = response.items.map((i) => ({ id: i.id, score: i.score }) as SearchResult);
    if (threshold === undefined) return results;
    return results.filter((r) => r.score >= threshold);
  }

  /**
   * Index a rule for embedding-based search
   * Returns true if the rule was indexed, false if skipped (up-to-date)
   */
  async indexRule(ruleId: string): Promise<boolean> {
    const core = await createRuleSimilarityCore(this.workspacePath, {
      persistenceProvider: this.persistence,
    });

    // Get the embeddings backend from the core using typed accessor
    const rawEmbeddingsBackend = core.getBackend("embeddings");
    if (!rawEmbeddingsBackend || !(rawEmbeddingsBackend instanceof EmbeddingsSimilarityBackend)) {
      throw new Error("Embeddings backend not available for indexing");
    }
    const embeddingsBackend = rawEmbeddingsBackend;

    // Get the embeddings storage and service via typed accessors
    const storage = embeddingsBackend.getVectorStorage();
    const embeddingService = embeddingsBackend.getEmbeddingService();

    if (!storage) {
      throw new Error("Vector storage not available from embeddings backend");
    }

    if (!embeddingService) {
      throw new Error("Embedding service not available from embeddings backend");
    }

    // Get rule content from the lexical backend resolvers using typed accessor
    const rawLexicalBackend = core.getBackend("lexical");
    if (!rawLexicalBackend || !(rawLexicalBackend instanceof LexicalSimilarityBackend)) {
      throw new Error("Lexical backend not available");
    }
    const resolvers = rawLexicalBackend.getResolvers();

    const content = await resolvers.getContent(ruleId);
    if (!content) {
      throw new Error(`Rule not found: ${ruleId}`);
    }

    const contentHash = createHash("sha256").update(content).digest("hex");

    // Check if up-to-date using the embeddings backend storage
    try {
      if (typeof storage.getMetadata === "function") {
        const meta = await storage.getMetadata(ruleId);
        const storedHash = meta?.content_hash || meta?.contentHash;
        if (storedHash && storedHash === contentHash) {
          log.debug(`[index] skip up-to-date rule ${ruleId}`);
          return false;
        }
      }
    } catch {
      // ignore metadata read errors
    }

    // Generate and store embedding
    const vector = await embeddingService.generateEmbedding(content);
    await storage.store(ruleId, vector, { contentHash });

    log.debug(`[index] indexed rule ${ruleId}`);
    return true;
  }
}

/**
 * Create a configured RuleSimilarityService instance with PersistenceProvider
 */
export async function createRuleSimilarityService(
  persistenceProvider: PersistenceProvider
): Promise<RuleSimilarityService> {
  const workspacePath = await resolveWorkspacePath({});
  return new RuleSimilarityService(persistenceProvider, workspacePath);
}
