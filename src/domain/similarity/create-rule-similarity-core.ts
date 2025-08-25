import { SimilaritySearchService } from "./similarity-search-service";
import { EmbeddingsSimilarityBackend } from "./backends/embeddings-backend";
import { LexicalSimilarityBackend } from "./backends/lexical-backend";
import { getEmbeddingDimension } from "../ai/embedding-models";
import { createEmbeddingServiceFromConfig } from "../ai/embedding-service-factory";
import { createRulesVectorStorageFromConfig } from "../storage/vector/vector-storage-factory";
import { ModularRulesService } from "../rules/rules-service-modular";
import { getConfiguration } from "../configuration";

export interface RuleSimilarityCoreOptions {
  disableEmbeddings?: boolean;
}

export async function createRuleSimilarityCore(
  workspacePath: string,
  options: RuleSimilarityCoreOptions = {}
) {
  const cfg: any = await getConfiguration();
  const model = cfg?.embeddings?.model || "text-embedding-3-small";
  const dimension = getEmbeddingDimension(model, 1536);

  let embeddings: EmbeddingsSimilarityBackend | null = null;
  if (!options.disableEmbeddings) {
    try {
      const embedding = await createEmbeddingServiceFromConfig();
      const storage = await createRulesVectorStorageFromConfig(dimension);
      embeddings = new EmbeddingsSimilarityBackend(embedding, storage);
    } catch {
      embeddings = null;
    }
  }

  // Build lexical resolvers from rules service
  const rulesService = new ModularRulesService(workspacePath);
  const lexical = new LexicalSimilarityBackend({
    getById: async (id: string) => {
      try {
        return (await rulesService.getRule(id)) as any;
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
  const backends = [embeddings, /* ai (future) */ lexical].filter(Boolean) as any;
  return new SimilaritySearchService(backends);
}
