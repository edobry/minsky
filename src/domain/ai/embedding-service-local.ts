import type { EmbeddingService } from "./embeddings/types";
import { getEmbeddingDimension } from "./embedding-models";
import { getConfiguration } from "../configuration";

export class LocalEmbeddingService implements EmbeddingService {
  private readonly dimension: number;
  private readonly normalize: boolean;

  constructor(dimension: number, normalize: boolean) {
    this.dimension = dimension;
    this.normalize = normalize;
  }

  static async fromConfig(): Promise<LocalEmbeddingService> {
    const cfg = await getConfiguration();
    const model = (cfg as any).embeddings?.model || "text-embedding-3-small";
    const normalize = Boolean((cfg as any).embeddings?.normalize);
    const dim = getEmbeddingDimension(model, 1536);
    return new LocalEmbeddingService(dim, normalize);
  }

  async generateEmbedding(content: string): Promise<number[]> {
    // Simple deterministic hash-based embedding for offline/dev
    const vec = new Array(this.dimension).fill(0).map((_, i) => this.hash(content, i));
    if (!this.normalize) return vec;
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }

  async generateEmbeddings(contents: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const c of contents) out.push(await this.generateEmbedding(c));
    return out;
  }

  private hash(text: string, seed: number): number {
    let h = 2166136261 ^ seed;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
      h |= 0;
    }
    // map to [-1, 1]
    return (h % 1000) / 500;
  }
}
