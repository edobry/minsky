import type { SearchResult } from "../storage/vector/types";
import type { PersistenceProvider } from "../persistence/types";
import { createRuleSimilarityCore } from "../similarity/create-rule-similarity-core";
import { createHash } from "crypto";
import { log } from "../../utils/logger";
import { resolveWorkspacePath } from "../workspace";

export interface RuleSimilarityServiceConfig {
  similarityThreshold?: number; // maximum distance for inclusion (backend-specific semantics)
}

/**
 * RuleSimilarityService: embedding-based rule retrieval
 */
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
    // Create a mock persistence provider for backward compatibility
    const mockPersistence = {
      capabilities: {
        vectorStorage: true,
        sql: true,
        transactions: true,
        jsonb: true,
        migrations: true,
      },
      async getVectorStorage() {
        return null;
      },
    } as PersistenceProvider;

    return new RuleSimilarityService(mockPersistence, workspacePath, config);
  }

  /**
   * Search rules by natural language query using embeddings
   */
  async searchByText(query: string, limit = 10, threshold?: number): Promise<SearchResult[]> {
    const core = await createRuleSimilarityCore(this.workspacePath);
    const items = await core.search({ queryText: query, limit });
    // Map to SearchResult shape (id/score compatible)
    return items.map((i) => ({ id: i.id, score: i.score }) as SearchResult);
  }

  /**
   * Index a rule for embedding-based search
   * Returns true if the rule was indexed, false if skipped (up-to-date)
   */
  async indexRule(ruleId: string): Promise<boolean> {
    const core = await createRuleSimilarityCore(this.workspacePath);

    // Get the embeddings backend from the core
    const backends = (core as any).backends;
    const embeddingsBackend = backends?.find((b: any) => b.name === "embeddings");

    if (!embeddingsBackend) {
      throw new Error("Embeddings backend not available for indexing");
    }

    // Get the embeddings storage and service
    const storage = (embeddingsBackend as any).vectorStorage;
    const embeddingService = (embeddingsBackend as any).embeddingService;

    if (!storage) {
      throw new Error("Vector storage not available from embeddings backend");
    }

    if (!embeddingService) {
      throw new Error("Embedding service not available from embeddings backend");
    }

    // Get rule content from the lexical backend resolvers
    const lexicalBackend = backends?.find((b: any) => b.name === "lexical");
    if (!lexicalBackend) {
      throw new Error("Lexical backend not available");
    }

    // Get rule content using the same resolvers as search
    const resolvers = (lexicalBackend as any).resolvers;
    if (!resolvers || typeof resolvers.getContent !== "function") {
      throw new Error("Content resolver not available from lexical backend");
    }

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
export async function createRuleSimilarityService(): Promise<RuleSimilarityService> {
  const workspacePath = await resolveWorkspacePath({});

  // Use PersistenceService instead of direct dependencies
  const { PersistenceService } = await import("../persistence/service");

  // PersistenceService should already be initialized at application startup
  const provider = PersistenceService.getProvider();

  const service = new RuleSimilarityService(provider, workspacePath);

  return service;
}
