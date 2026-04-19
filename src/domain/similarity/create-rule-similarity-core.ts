import { SimilaritySearchService } from "./similarity-search-service";
import { EmbeddingsSimilarityBackend } from "./backends/embeddings-backend";
import { LexicalSimilarityBackend } from "./backends/lexical-backend";
import { getEmbeddingDimension } from "../ai/embedding-models";
import { createEmbeddingServiceFromConfig } from "../ai/embedding-service-factory";
import { createRulesVectorStorageFromConfig } from "../storage/vector/vector-storage-factory";
import { RuleService } from "../rules";
import { getConfiguration } from "../configuration";
import type { PersistenceProvider } from "../persistence/types";
import { resolveProvider } from "../persistence/service";

export interface RuleSimilarityCoreOptions {
  disableEmbeddings?: boolean;
  persistenceProvider?: PersistenceProvider;
}

export async function createRuleSimilarityCore(
  workspacePath: string,
  options: RuleSimilarityCoreOptions = {}
) {
  const cfg = getConfiguration();
  const model = cfg?.embeddings?.model || "text-embedding-3-small";
  const dimension = getEmbeddingDimension(model, 1536);

  let embeddings: EmbeddingsSimilarityBackend | null = null;
  if (!options.disableEmbeddings) {
    try {
      const resolvedProvider = resolveProvider(options.persistenceProvider);
      const embedding = await createEmbeddingServiceFromConfig();
      const storage = await createRulesVectorStorageFromConfig(dimension, resolvedProvider);
      embeddings = new EmbeddingsSimilarityBackend(embedding, storage);
    } catch {
      embeddings = null;
    }
  }

  // Build lexical resolvers from rules service
  const rulesService = new RuleService(workspacePath);
  const lexical = new LexicalSimilarityBackend({
    getById: async (id: string) => {
      try {
        return (await rulesService.getRule(id)) as { id: string } | null;
      } catch {
        return null;
      }
    },
    listCandidateIds: async () => {
      const rules = await rulesService.listRules();
      return rules.map((r) => r.id);
    },
    getContent: async (id: string) => {
      const rule = await rulesService.getRule(id);
      return rule?.content || "";
    },
  });

  // Fallback order: embeddings -> ai (future) -> lexical
  const backends = [embeddings, /* ai (future) */ lexical].filter(
    (b): b is NonNullable<typeof b> => b != null
  );
  return new SimilaritySearchService(backends);
}
