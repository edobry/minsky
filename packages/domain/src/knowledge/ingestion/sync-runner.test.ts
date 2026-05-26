import { describe, it, expect, beforeEach } from "bun:test";
import { runSync } from "./sync-runner";
import type { KnowledgeSourceProvider, KnowledgeDocument } from "../types";
import type { EmbeddingService } from "../../ai/embeddings/types";
import type { VectorStorage, SearchResult, SearchOptions } from "../../storage/vector/types";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeDocument(
  id: string,
  content: string,
  extra?: Partial<KnowledgeDocument>
): KnowledgeDocument {
  return {
    id,
    title: `Title ${id}`,
    content,
    url: `https://example.com/${id}`,
    lastModified: new Date("2024-01-01"),
    metadata: {},
    ...extra,
  };
}

function makeProvider(
  docs: KnowledgeDocument[],
  sourceType = "fake",
  sourceName = "test-source"
): KnowledgeSourceProvider {
  return {
    sourceType,
    sourceName,
    async *listDocuments() {
      yield* docs;
    },
    async fetchDocument(id: string) {
      const doc = docs.find((d) => d.id === id);
      if (!doc) throw new Error(`Document not found: ${id}`);
      return doc;
    },
    async *getChangedSince() {
      // no-op
    },
  };
}

class FakeEmbeddingService implements EmbeddingService {
  calls: string[] = [];

  async generateEmbedding(content: string): Promise<number[]> {
    this.calls.push(content);
    return [0.1, 0.2, 0.3];
  }

  async generateEmbeddings(contents: string[]): Promise<number[][]> {
    return contents.map(() => [0.1, 0.2, 0.3]);
  }
}

class InMemoryVectorStorage implements VectorStorage {
  private store_: Map<string, { vector: number[]; metadata?: Record<string, unknown> }> = new Map();

  async store(id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void> {
    this.store_.set(id, { vector, metadata });
  }

  async search(_queryVector: number[], _options?: SearchOptions): Promise<SearchResult[]> {
    return [];
  }

  async delete(id: string): Promise<void> {
    this.store_.delete(id);
  }

  async getMetadata(id: string): Promise<Record<string, unknown> | null> {
    return this.store_.get(id)?.metadata ?? null;
  }

  get size(): number {
    return this.store_.size;
  }

  storedIds(): string[] {
    return Array.from(this.store_.keys());
  }

  getEntry(id: string) {
    return this.store_.get(id);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runSync", () => {
  let embeddingService: FakeEmbeddingService;
  let vectorStorage: InMemoryVectorStorage;

  beforeEach(() => {
    embeddingService = new FakeEmbeddingService();
    vectorStorage = new InMemoryVectorStorage();
  });

  describe("full sync", () => {
    it("indexes all documents from the provider", async () => {
      const docs = [
        makeDocument("doc1", "Content for document one"),
        makeDocument("doc2", "Content for document two"),
      ];
      const provider = makeProvider(docs);

      const report = await runSync(provider, { embeddingService, vectorStorage });

      expect(report.sourceName).toBe("test-source");
      expect(report.errors).toHaveLength(0);
      expect(report.skipped).toBe(0);
      expect(vectorStorage.size).toBeGreaterThanOrEqual(2);
    });

    it("stores metadata including contentHash, sourceType, and title", async () => {
      const doc = makeDocument("doc1", "Hello world content");
      const provider = makeProvider([doc], "notion", "my-notion");

      await runSync(provider, { embeddingService, vectorStorage });

      const id = "my-notion:doc1:0";
      const meta = await vectorStorage.getMetadata(id);

      expect(meta).not.toBeNull();
      expect(meta?.["sourceType"]).toBe("notion");
      expect(meta?.["sourceName"]).toBe("my-notion");
      expect(meta?.["title"]).toBe("Title doc1");
      expect(typeof meta?.["contentHash"]).toBe("string");
      expect(meta?.["chunkIndex"]).toBe(0);
    });

    it("calls embeddingService once per chunk", async () => {
      const doc = makeDocument("doc1", "Short content");
      const provider = makeProvider([doc]);

      await runSync(provider, { embeddingService, vectorStorage });

      // Short content = 1 chunk
      expect(embeddingService.calls).toHaveLength(1);
    });

    it("reports duration in the sync report", async () => {
      const provider = makeProvider([makeDocument("doc1", "content")]);

      const report = await runSync(provider, { embeddingService, vectorStorage });

      expect(typeof report.duration).toBe("number");
      expect(report.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe("skip unchanged (hash check)", () => {
    it("skips a document when its content hash is unchanged", async () => {
      const doc = makeDocument("doc1", "Stable content");
      const provider = makeProvider([doc]);

      // First sync
      await runSync(provider, { embeddingService, vectorStorage });
      const callsAfterFirst = embeddingService.calls.length;

      // Second sync — same content
      const report = await runSync(provider, { embeddingService, vectorStorage });

      expect(report.skipped).toBe(1);
      expect(report.added).toBe(0);
      // No new embedding calls
      expect(embeddingService.calls.length).toBe(callsAfterFirst);
    });

    it("re-indexes a document when content has changed", async () => {
      const provider1 = makeProvider([makeDocument("doc1", "Original content")]);
      await runSync(provider1, { embeddingService, vectorStorage });
      const callsAfterFirst = embeddingService.calls.length;

      const provider2 = makeProvider([makeDocument("doc1", "Updated content — different!")]);
      await runSync(provider2, { embeddingService, vectorStorage });

      // New embedding should have been generated
      expect(embeddingService.calls.length).toBeGreaterThan(callsAfterFirst);
    });
  });

  describe("force re-index", () => {
    it("re-indexes all documents when force=true, ignoring hash", async () => {
      const doc = makeDocument("doc1", "Stable content");
      const provider = makeProvider([doc]);

      // First sync
      await runSync(provider, { embeddingService, vectorStorage });
      const callsAfterFirst = embeddingService.calls.length;

      // Force sync
      const report = await runSync(provider, { embeddingService, vectorStorage }, { force: true });

      expect(report.skipped).toBe(0);
      // Embedding was called again
      expect(embeddingService.calls.length).toBeGreaterThan(callsAfterFirst);
    });
  });

  describe("error handling", () => {
    it("continues syncing other documents when one embedding fails", async () => {
      let callCount = 0;
      const failingEmbeddingService: EmbeddingService = {
        async generateEmbedding(content: string) {
          callCount++;
          if (callCount === 1) {
            throw new Error("Embedding API error");
          }
          return [0.1, 0.2, 0.3];
        },
        async generateEmbeddings(contents: string[]) {
          return contents.map(() => [0.1, 0.2, 0.3]);
        },
      };

      const docs = [
        makeDocument("doc1", "Content that will fail"),
        makeDocument("doc2", "Content that will succeed"),
      ];
      const provider = makeProvider(docs);

      const report = await runSync(provider, {
        embeddingService: failingEmbeddingService,
        vectorStorage,
      });

      // Should have at least one error
      expect(report.errors.length).toBeGreaterThanOrEqual(1);
      expect(report.errors[0]?.documentId).toBe("doc1");

      // doc2 should still be stored
      const doc2Id = "test-source:doc2:0";
      const meta = await vectorStorage.getMetadata(doc2Id);
      expect(meta).not.toBeNull();
    });

    it("records error message for failed documents", async () => {
      const failingEmbeddingService: EmbeddingService = {
        async generateEmbedding() {
          throw new Error("Rate limit exceeded");
        },
        async generateEmbeddings() {
          return [];
        },
      };

      const provider = makeProvider([makeDocument("doc1", "content")]);
      const report = await runSync(provider, {
        embeddingService: failingEmbeddingService,
        vectorStorage,
      });

      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]?.message).toContain("Rate limit exceeded");
    });
  });

  describe("stale detection", () => {
    it("tracks which IDs were seen during this sync", async () => {
      const docs = [makeDocument("doc1", "content1"), makeDocument("doc2", "content2")];
      const provider = makeProvider(docs);

      await runSync(provider, { embeddingService, vectorStorage });

      // Both docs should have been stored
      const ids = vectorStorage.storedIds();
      expect(ids).toContain("test-source:doc1:0");
      expect(ids).toContain("test-source:doc2:0");
    });
  });

  describe("chunked documents", () => {
    it("stores multiple chunks for large documents", async () => {
      // Create content large enough to produce multiple chunks
      // 8192 tokens * 4 chars/token = 32768 chars per chunk
      // Use 70000 chars to force at least 2 chunks
      const largeContent = "Word ".repeat(14000); // ~70000 chars
      const doc = makeDocument("big-doc", largeContent);
      const provider = makeProvider([doc]);

      await runSync(provider, { embeddingService, vectorStorage });

      const ids = vectorStorage.storedIds();
      const docIds = ids.filter((id) => id.startsWith("test-source:big-doc:"));
      expect(docIds.length).toBeGreaterThanOrEqual(2);
    });

    it("includes totalChunks in metadata for each chunk", async () => {
      const largeContent = "X".repeat(40000);
      const doc = makeDocument("big-doc", largeContent);
      const provider = makeProvider([doc]);

      await runSync(provider, { embeddingService, vectorStorage });

      const meta0 = await vectorStorage.getMetadata("test-source:big-doc:0");
      expect(meta0).not.toBeNull();
      expect(typeof meta0?.["totalChunks"]).toBe("number");
      expect(meta0?.["totalChunks"] as number).toBeGreaterThanOrEqual(1);
    });
  });
});
