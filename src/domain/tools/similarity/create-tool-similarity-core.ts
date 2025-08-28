import { SimilaritySearchService } from "../../similarity/similarity-search-service";
import { EmbeddingsSimilarityBackend } from "../../similarity/backends/embeddings-backend";
import { LexicalSimilarityBackend } from "../../similarity/backends/lexical-backend";
import { ToolKeywordBackend } from "./tool-keyword-backend";
import { createEmbeddingServiceFromConfig } from "../../ai/embedding-service-factory";
import { createToolsVectorStorageFromConfig } from "../../storage/vector-storage-factory";
import { getEmbeddingDimension } from "../../ai/embedding-models";
import { getConfiguration } from "../../configuration";
import { sharedCommandRegistry } from "../../../adapters/shared/command-registry";

export interface ToolSimilarityCoreOptions {
  disableEmbeddings?: boolean;
}

export async function createToolSimilarityCore(
  options: ToolSimilarityCoreOptions = {}
) {
  const cfg: any = await getConfiguration();
  const model = cfg?.embeddings?.model || "text-embedding-3-small";
  const dimension = getEmbeddingDimension(model, 1536);

  let embeddings: EmbeddingsSimilarityBackend | null = null;
  if (!options.disableEmbeddings) {
    try {
      const embedding = await createEmbeddingServiceFromConfig();
      const storage = await createToolsVectorStorageFromConfig(dimension);
      embeddings = new EmbeddingsSimilarityBackend(embedding, storage);
    } catch {
      embeddings = null; // Treat embeddings as unavailable when misconfigured in tests
    }
  }

  // Tool-specific keyword backend for intent-based matching
  const keywords = new ToolKeywordBackend();

  // Build lexical resolvers from shared command registry
  const lexical = new LexicalSimilarityBackend({
    getById: async (id: string) => {
      try {
        return sharedCommandRegistry.getCommand(id) as any;
      } catch {
        return null;
      }
    },
    listCandidateIds: async () => {
      const tools = sharedCommandRegistry.getAllCommands();
      return tools.map((t) => t.id);
    },
    getContent: async (id: string) => {
      const tool = sharedCommandRegistry.getCommand(id);
      if (!tool) return "";

      // Extract same content as ToolEmbeddingService for consistency
      const parts = [
        tool.name,
        tool.description,
        tool.category.toLowerCase(),
      ];

      // Add parameter names and descriptions if available
      if (tool.parameters) {
        Object.entries(tool.parameters).forEach(([paramName, paramDef]) => {
          parts.push(paramName);
          if (paramDef.description) {
            parts.push(paramDef.description);
          }
        });
      }

      return parts.filter(Boolean).join(" ");
    },
  });

  // Fallback order: embeddings -> ai (future) -> keywords -> lexical
  const backends = [embeddings, /* ai (future) */ keywords, lexical].filter(Boolean) as any;
  return new SimilaritySearchService(backends);
}
