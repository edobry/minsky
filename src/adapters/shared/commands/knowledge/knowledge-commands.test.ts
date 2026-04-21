/**
 * Knowledge Commands Tests
 *
 * Tests for the 4 knowledge base commands using fake/injectable dependencies.
 */
import { describe, test, expect } from "bun:test";

const SEARCH_CMD = "knowledge.search";
const SOURCES_CMD = "knowledge.sources";
const SYNC_CMD = "knowledge.sync";
const FETCH_CMD = "knowledge.fetch";
const REGISTERED_MSG = "is registered with correct metadata";
import { createSharedCommandRegistry } from "../../command-registry";
import { registerKnowledgeCommands, type KnowledgeCommandsDeps } from "./index";
import type { KnowledgeSourceConfig, SyncReport } from "../../../../domain/knowledge/types";
import type { EmbeddingService } from "../../../../domain/ai/embeddings/types";
import type { VectorStorage, SearchResult } from "../../../../domain/storage/vector/types";
import type { KnowledgeService } from "../../../../domain/knowledge/knowledge-service";

// ─── Fake helpers ─────────────────────────────────────────────────────────────

function makeFakeEmbeddingService(): EmbeddingService {
  return {
    generateEmbedding: async (_content: string) => [0.1, 0.2, 0.3],
    generateEmbeddings: async (contents: string[]) => contents.map(() => [0.1, 0.2, 0.3]),
  };
}

function makeFakeVectorStorage(results: SearchResult[] = []): VectorStorage {
  return {
    store: async () => {},
    search: async () => results,
    delete: async () => {},
    getMetadata: async () => null,
  };
}

function makeFakeConfig(
  sources: KnowledgeSourceConfig[] = []
): () => Promise<{ knowledgeBases: KnowledgeSourceConfig[] }> {
  return async () => ({ knowledgeBases: sources });
}

function makeFakeKnowledgeService(syncReports: SyncReport[] = []): () => KnowledgeService {
  const service = {
    sync: async (_sourceName?: string, _options?: { force?: boolean }) => syncReports,
    getConfiguredSources: () => [] as KnowledgeSourceConfig[],
  } as unknown as KnowledgeService;
  return () => service;
}

const SAMPLE_SOURCE: KnowledgeSourceConfig = {
  name: "my-notion",
  type: "notion",
  auth: { token: "test-notion-token" },
  sync: { schedule: "on-demand" },
};

const SAMPLE_SYNC_REPORT: SyncReport = {
  sourceName: "my-notion",
  added: 3,
  updated: 1,
  skipped: 10,
  removed: 0,
  errors: [],
  duration: 500,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Knowledge Commands", () => {
  let registry: ReturnType<typeof createSharedCommandRegistry>;

  // ── knowledge.search ────────────────────────────────────────────────────────
  describe(SEARCH_CMD, () => {
    test(REGISTERED_MSG, () => {
      registry = createSharedCommandRegistry();
      registerKnowledgeCommands(registry, {});
      const cmd = registry.getCommand(SEARCH_CMD);
      expect(cmd).toBeDefined();
      expect(cmd?.name).toBe("search");
      expect(cmd?.parameters["query"]?.required).toBe(true);
    });

    test("returns results when embedding service and vector storage are injected", async () => {
      const fakeResults: SearchResult[] = [
        {
          id: "my-notion:page-1:0",
          score: 0.95,
          metadata: {
            title: "Hello World",
            excerpt: "This is a snippet",
            url: "https://notion.so/page-1",
            sourceName: "my-notion",
          },
        },
      ];

      const fakeEmbed = makeFakeEmbeddingService();
      const fakeStorage = makeFakeVectorStorage(fakeResults);

      const deps: KnowledgeCommandsDeps = {
        generateEmbedding: fakeEmbed.generateEmbedding.bind(fakeEmbed),
        vectorSearch: fakeStorage.search.bind(fakeStorage),
      };

      registry = createSharedCommandRegistry();
      registerKnowledgeCommands(registry, deps);

      const cmd = registry.getCommand(SEARCH_CMD);
      expect(cmd).toBeDefined();

      const result = (await cmd?.execute({ query: "test query" }, {})) as {
        results: unknown[];
        backend: string;
        degraded: boolean;
      };

      expect(result.backend).toBe("embeddings");
      expect(result.degraded).toBe(false);
      expect(result.results).toHaveLength(1);
      const first = result.results[0] as {
        id: string;
        title: string;
        score: number;
        source: string;
      };
      expect(first.id).toBe("my-notion:page-1:0");
      expect(first.title).toBe("Hello World");
      expect(first.score).toBe(0.95);
      expect(first.source).toBe("my-notion");
    });

    test("returns empty results when vector storage returns nothing", async () => {
      const fakeEmbed = makeFakeEmbeddingService();
      const fakeStorage = makeFakeVectorStorage([]);

      const deps: KnowledgeCommandsDeps = {
        generateEmbedding: fakeEmbed.generateEmbedding.bind(fakeEmbed),
        vectorSearch: fakeStorage.search.bind(fakeStorage),
      };

      registry = createSharedCommandRegistry();
      registerKnowledgeCommands(registry, deps);

      const cmd = registry.getCommand(SEARCH_CMD);
      const result = (await cmd?.execute({ query: "nothing" }, {})) as {
        results: unknown[];
        backend: string;
        degraded: boolean;
      };

      expect(result.backend).toBe("embeddings");
      expect(result.degraded).toBe(false);
      expect(result.results).toHaveLength(0);
    });

    test("returns degraded result when no vector storage is provided", async () => {
      const fakeEmbed = makeFakeEmbeddingService();

      // Only generateEmbedding injected, no vectorSearch
      const deps: KnowledgeCommandsDeps = {
        generateEmbedding: fakeEmbed.generateEmbedding.bind(fakeEmbed),
      };

      registry = createSharedCommandRegistry();
      registerKnowledgeCommands(registry, deps);

      const cmd = registry.getCommand(SEARCH_CMD);
      const result = (await cmd?.execute({ query: "test" }, {})) as {
        results: unknown[];
        backend: string;
        degraded: boolean;
      };

      expect(result.backend).toBe("none");
      expect(result.degraded).toBe(true);
      expect(result.results).toHaveLength(0);
    });
  });

  // ── knowledge.sources ───────────────────────────────────────────────────────
  describe(SOURCES_CMD, () => {
    test(REGISTERED_MSG, () => {
      registry = createSharedCommandRegistry();
      registerKnowledgeCommands(registry, {});
      const cmd = registry.getCommand(SOURCES_CMD);
      expect(cmd).toBeDefined();
      expect(cmd?.name).toBe("sources");
    });

    test("returns configured sources", async () => {
      const deps: KnowledgeCommandsDeps = {
        getConfig: makeFakeConfig([SAMPLE_SOURCE]),
      };

      registry = createSharedCommandRegistry();
      registerKnowledgeCommands(registry, deps);

      const cmd = registry.getCommand(SOURCES_CMD);
      const result = (await cmd?.execute({}, {})) as { sources: unknown[] };

      expect(result.sources).toHaveLength(1);
      const first = result.sources[0] as { name: string; type: string; syncSchedule: string };
      expect(first.name).toBe("my-notion");
      expect(first.type).toBe("notion");
      expect(first.syncSchedule).toBe("on-demand");
    });

    test("returns empty sources list when none configured", async () => {
      const deps: KnowledgeCommandsDeps = {
        getConfig: makeFakeConfig([]),
      };

      registry = createSharedCommandRegistry();
      registerKnowledgeCommands(registry, deps);

      const cmd = registry.getCommand(SOURCES_CMD);
      const result = (await cmd?.execute({}, {})) as { sources: unknown[] };

      expect(result.sources).toHaveLength(0);
    });
  });

  // ── knowledge.fetch ─────────────────────────────────────────────────────────
  describe(FETCH_CMD, () => {
    test(REGISTERED_MSG, () => {
      registry = createSharedCommandRegistry();
      registerKnowledgeCommands(registry, {});
      const cmd = registry.getCommand(FETCH_CMD);
      expect(cmd).toBeDefined();
      expect(cmd?.name).toBe("fetch");
      expect(cmd?.parameters["source"]?.required).toBe(true);
      expect(cmd?.parameters["documentId"]?.required).toBe(true);
    });

    test("throws when source name is not found in config", async () => {
      const deps: KnowledgeCommandsDeps = {
        getConfig: makeFakeConfig([]),
      };

      registry = createSharedCommandRegistry();
      registerKnowledgeCommands(registry, deps);

      const cmd = registry.getCommand(FETCH_CMD);
      await expect(
        cmd?.execute({ source: "nonexistent-source", documentId: "doc-1" }, {})
      ).rejects.toThrow('Knowledge source not found: "nonexistent-source"');
    });

    test("throws when source exists but token is empty", async () => {
      const sourceWithMissingToken: KnowledgeSourceConfig = {
        name: "test-source",
        type: "notion",
        auth: { token: "" },
      };

      const deps: KnowledgeCommandsDeps = {
        getConfig: makeFakeConfig([sourceWithMissingToken]),
      };

      registry = createSharedCommandRegistry();
      registerKnowledgeCommands(registry, deps);

      const cmd = registry.getCommand(FETCH_CMD);
      await expect(
        cmd?.execute({ source: "test-source", documentId: "doc-1" }, {})
      ).rejects.toThrow("API token not found");
    });
  });

  // ── knowledge.sync ──────────────────────────────────────────────────────────
  describe(SYNC_CMD, () => {
    test(REGISTERED_MSG, () => {
      registry = createSharedCommandRegistry();
      registerKnowledgeCommands(registry, {});
      const cmd = registry.getCommand(SYNC_CMD);
      expect(cmd).toBeDefined();
      expect(cmd?.name).toBe("sync");
      expect(cmd?.parameters.source?.required).toBe(false);
      expect(cmd?.parameters.force?.required).toBe(false);
    });

    test("returns sync reports for all sources", async () => {
      const fakeEmbed = makeFakeEmbeddingService();
      const fakeStorage = makeFakeVectorStorage();
      const fakeSyncFactory = makeFakeKnowledgeService([SAMPLE_SYNC_REPORT]);

      const deps: KnowledgeCommandsDeps = {
        getConfig: makeFakeConfig([SAMPLE_SOURCE]),
        generateEmbedding: fakeEmbed.generateEmbedding.bind(fakeEmbed),
        vectorSearch: fakeStorage.search.bind(fakeStorage),
        createKnowledgeService: fakeSyncFactory,
      };

      registry = createSharedCommandRegistry();
      registerKnowledgeCommands(registry, deps);

      const cmd = registry.getCommand(SYNC_CMD);
      const result = (await cmd?.execute({}, {})) as { reports: SyncReport[] };

      expect(result.reports).toHaveLength(1);
      const firstReport = result.reports[0];
      if (!firstReport) throw new Error("Expected first report to exist");
      expect(firstReport.sourceName).toBe("my-notion");
      expect(firstReport.added).toBe(3);
    });

    test("returns sync reports for a single named source", async () => {
      const fakeEmbed = makeFakeEmbeddingService();
      const fakeStorage = makeFakeVectorStorage();
      const fakeSyncFactory = makeFakeKnowledgeService([SAMPLE_SYNC_REPORT]);

      const deps: KnowledgeCommandsDeps = {
        getConfig: makeFakeConfig([SAMPLE_SOURCE]),
        generateEmbedding: fakeEmbed.generateEmbedding.bind(fakeEmbed),
        vectorSearch: fakeStorage.search.bind(fakeStorage),
        createKnowledgeService: fakeSyncFactory,
      };

      registry = createSharedCommandRegistry();
      registerKnowledgeCommands(registry, deps);

      const cmd = registry.getCommand(SYNC_CMD);
      const result = (await cmd?.execute({ source: "my-notion", force: false }, {})) as {
        reports: SyncReport[];
      };

      expect(result.reports).toHaveLength(1);
      expect(result.reports[0]?.sourceName).toBe("my-notion");
    });

    test("passes force flag to sync service", async () => {
      let capturedOptions: { force?: boolean } | undefined;

      const fakeService = {
        sync: async (_sourceName?: string, options?: { force?: boolean }) => {
          capturedOptions = options;
          return [SAMPLE_SYNC_REPORT];
        },
        getConfiguredSources: () => [] as KnowledgeSourceConfig[],
      } as unknown as KnowledgeService;

      const deps: KnowledgeCommandsDeps = {
        getConfig: makeFakeConfig([SAMPLE_SOURCE]),
        createKnowledgeService: () => fakeService,
      };

      registry = createSharedCommandRegistry();
      registerKnowledgeCommands(registry, deps);

      const cmd = registry.getCommand(SYNC_CMD);
      await cmd?.execute({ force: true }, {});

      expect(capturedOptions?.force).toBe(true);
    });
  });
});
