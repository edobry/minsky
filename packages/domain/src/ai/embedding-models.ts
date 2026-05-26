const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

export function getEmbeddingDimension(model: string | undefined, fallback = 1536): number {
  if (!model) return fallback;
  return MODEL_DIMENSIONS[model] || fallback;
}
