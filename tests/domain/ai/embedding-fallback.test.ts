import { describe, test, expect } from "bun:test";
import type { EmbeddingService } from "../../../packages/domain/src/ai/embeddings/types";

class MockEmbeddingService implements EmbeddingService {
  name: string;
  shouldFail: boolean;
  failError: Error;
  callCount = 0;

  constructor(name: string, shouldFail = false, failError?: Error) {
    this.name = name;
    this.shouldFail = shouldFail;
    this.failError = failError || new Error(`${name} failed`);
  }

  async generateEmbedding(content: string): Promise<number[]> {
    this.callCount++;
    if (this.shouldFail) throw this.failError;
    return new Array(1536).fill(0).map((_, i) => i * 0.001);
  }

  async generateEmbeddings(contents: string[]): Promise<number[][]> {
    this.callCount++;
    if (this.shouldFail) throw this.failError;
    return contents.map(() => new Array(1536).fill(0).map((_, i) => i * 0.001));
  }
}

const QUOTA_EXHAUSTED_MSG = "insufficient_quota";

function isQuotaExhausted(error: unknown): boolean {
  const msg = String((error as Error)?.message || "");
  return /insufficient_quota|RESOURCE_EXHAUSTED/i.test(msg);
}

function createFallbackService(
  primary: EmbeddingService,
  fallback: EmbeddingService
): EmbeddingService {
  return {
    async generateEmbedding(content: string): Promise<number[]> {
      try {
        return await primary.generateEmbedding(content);
      } catch (err) {
        if (!isQuotaExhausted(err)) throw err;
        return fallback.generateEmbedding(content);
      }
    },
    async generateEmbeddings(contents: string[]): Promise<number[][]> {
      try {
        return await primary.generateEmbeddings(contents);
      } catch (err) {
        if (!isQuotaExhausted(err)) throw err;
        return fallback.generateEmbeddings(contents);
      }
    },
  };
}

describe("FallbackEmbeddingService", () => {
  test("uses primary when healthy", async () => {
    const primary = new MockEmbeddingService("openai");
    const fallback = new MockEmbeddingService("gemini");
    const service = createFallbackService(primary, fallback);

    const result = await service.generateEmbedding("test");
    expect(result).toHaveLength(1536);
    expect(primary.callCount).toBe(1);
    expect(fallback.callCount).toBe(0);
  });

  test("falls back on insufficient_quota", async () => {
    const primary = new MockEmbeddingService("openai", true, new Error(QUOTA_EXHAUSTED_MSG));
    const fallback = new MockEmbeddingService("gemini");
    const service = createFallbackService(primary, fallback);

    const result = await service.generateEmbedding("test");
    expect(result).toHaveLength(1536);
    expect(primary.callCount).toBe(1);
    expect(fallback.callCount).toBe(1);
  });

  test("falls back on RESOURCE_EXHAUSTED", async () => {
    const primary = new MockEmbeddingService("openai", true, new Error("RESOURCE_EXHAUSTED"));
    const fallback = new MockEmbeddingService("gemini");
    const service = createFallbackService(primary, fallback);

    const result = await service.generateEmbedding("test");
    expect(result).toHaveLength(1536);
    expect(fallback.callCount).toBe(1);
  });

  test("propagates non-quota errors", async () => {
    const primary = new MockEmbeddingService("openai", true, new Error("network timeout"));
    const fallback = new MockEmbeddingService("gemini");
    const service = createFallbackService(primary, fallback);

    await expect(service.generateEmbedding("test")).rejects.toThrow("network timeout");
    expect(fallback.callCount).toBe(0);
  });

  test("falls back for generateEmbeddings batch call", async () => {
    const primary = new MockEmbeddingService("openai", true, new Error(QUOTA_EXHAUSTED_MSG));
    const fallback = new MockEmbeddingService("gemini");
    const service = createFallbackService(primary, fallback);

    const result = await service.generateEmbeddings(["a", "b"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(1536);
    expect(fallback.callCount).toBe(1);
  });

  test("propagates fallback errors when both fail", async () => {
    const primary = new MockEmbeddingService("openai", true, new Error(QUOTA_EXHAUSTED_MSG));
    const fallback = new MockEmbeddingService("gemini", true, new Error("gemini also failed"));
    const service = createFallbackService(primary, fallback);

    await expect(service.generateEmbedding("test")).rejects.toThrow("gemini also failed");
  });
});

describe("isQuotaExhausted", () => {
  test("detects insufficient_quota", () => {
    expect(isQuotaExhausted(new Error(QUOTA_EXHAUSTED_MSG))).toBe(true);
  });

  test("detects RESOURCE_EXHAUSTED", () => {
    expect(isQuotaExhausted(new Error("RESOURCE_EXHAUSTED"))).toBe(true);
  });

  test("rejects non-quota errors", () => {
    expect(isQuotaExhausted(new Error("ECONNRESET"))).toBe(false);
    expect(isQuotaExhausted(new Error("network timeout"))).toBe(false);
    expect(isQuotaExhausted(new Error("429 rate limited"))).toBe(false);
  });
});
