import { SimilaritySearchService } from "./similarity-search-service";
import { EmbeddingsSimilarityBackend } from "./backends/embeddings-backend";
import { LexicalSimilarityBackend } from "./backends/lexical-backend";
import { createEmbeddingServiceFromConfig } from "../ai/embedding-service-factory";
import { createVectorStorageFromConfig } from "../storage/vector/vector-storage-factory";
import { getEmbeddingDimension } from "../ai/embedding-models";
import { getConfiguration } from "../configuration";

export async function createTaskSimilarityCore(resolvers: {
  getById(id: string): Promise<any | null>;
  listCandidateIds(): Promise<string[]>;
  getContent(id: string): Promise<string>;
}) {
  const cfg: any = await getConfiguration();
  const model = cfg?.embeddings?.model || "text-embedding-3-small";
  const dimension = getEmbeddingDimension(model, 1536);

  const embedding = await createEmbeddingServiceFromConfig();
  const storage = await createVectorStorageFromConfig(dimension);

  const embeddings = new EmbeddingsSimilarityBackend(embedding, storage);
  const lexical = new LexicalSimilarityBackend({
    getById: resolvers.getById,
    listCandidateIds: resolvers.listCandidateIds,
    getContent: async (id: string) => await resolvers.getContent(id),
  });

  const backends = [embeddings /* ai (future) */, lexical];
  return new SimilaritySearchService(backends);
}
