export interface EmbeddingService {
  generateEmbedding(content: string): Promise<number[]>;
  generateEmbeddings(contents: string[]): Promise<number[][]>;
}
