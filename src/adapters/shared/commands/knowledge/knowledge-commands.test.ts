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
import type {
  KnowledgeSourceConfig,
  SyncReport,
  KnowledgeSearchResponse,
} from "../../../../domain/knowledge/types";
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

interface FakeReconciliationConfig {
  staleness?: { agingDays?: number; staleDays?: number };
  sourceAuthority?: Record<string, number>;
  epsilon?: number;
}

function makeFakeConfig(
  sources: KnowledgeSourceConfig[] = [],
  reconciliation?: FakeReconciliationConfig
): () => Promise<{
  knowledgeBases: KnowledgeSourceConfig[];
  knowledgeReconciliation?: FakeReconciliationConfig;
}> {
  return async () => ({ knowledgeBases: sources, knowledgeReconciliation: reconciliation });
}

function makeFakeKnowledgeService(syncReports: SyncReport[] = []): () => KnowledgeService {
  const service = {
    sync: async (_sourceName?: string, _options?: { force?: boolean }) => syncReports,
    getConfiguredSources: () => [] as KnowledgeSourceConfig[],
  } as unknown as KnowledgeService;
  return () => service;
}

// ─── Test constants ───────────────────────────────────────────────────────────

/** Recent timestamp: 5 days before now — always "fresh" under default thresholds */
const RECENT_ISO = new Date(new Date().getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
/** Stale timestamp: 100 days before now — always "stale" under default thresholds */
const STALE_ISO = new Date(new Date().getTime() - 100 * 24 * 60 * 60 * 1000).toISOString();
/** Chunk ID used in full-shape tests */
const CHUNK_ID_PAGE_1 = "my-notion:page-1:0";

const SAMPLE_SOURCE: KnowledgeSourceConfig = {
  name: "my-notion",
  type: "notion",
  auth: { tokenEnvVar: "NOTION_TOKEN" },
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

    test("returns structured KnowledgeSearchResponse when embedding service and vector storage are injected", async () => {
      const fakeResults: SearchResult[] = [
        {
          id: CHUNK_ID_PAGE_1,
          score: 0.95,
          metadata: {
            title: "Hello World",
            excerpt: "This is a snippet",
            url: "https://notion.so/page-1",
            sourceName: "my-notion",
            lastModified: RECENT_ISO,
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

      const result = (await cmd?.execute({ query: "test query" }, {})) as
        | (KnowledgeSearchResponse & { backend: string; degraded: boolean })
        | undefined;

      expect(result).toBeDefined();
      if (!result) return;

      // Core shape fields
      expect(result.backend).toBe("embeddings");
      expect(result.degraded).toBe(false);

      // chunks field (primary result list)
      expect(result.chunks).toHaveLength(1);
      const firstChunk = result.chunks[0];
      expect(firstChunk?.id).toBe(CHUNK_ID_PAGE_1);
      expect(firstChunk?.title).toBe("Hello World");
      expect(firstChunk?.score).toBe(0.95);
      expect(firstChunk?.source).toBe("my-notion");

      // freshness map
      const chunkFreshness = result.freshness[CHUNK_ID_PAGE_1];
      expect(chunkFreshness).toBeDefined();
      expect(chunkFreshness?.staleness).toBe("fresh");
      expect(chunkFreshness?.lastModified).toBe(RECENT_ISO);

      // authority list
      expect(Array.isArray(result.authority)).toBe(true);
      expect(result.authority).toContain(CHUNK_ID_PAGE_1);

      // Phase 2a stubs
      expect(result.conflicts).toEqual([]);
      expect(result.redundancies).toEqual([]);
    });

    test("backward compat: reading response.chunks still works unchanged", async () => {
      const fakeResults: SearchResult[] = [
        {
          id: "chunk-1",
          score: 0.8,
          metadata: {
            title: "Doc",
            sourceName: "source-A",
          },
        },
      ];
      const fakeEmbed = makeFakeEmbeddingService();
      const fakeStorage = makeFakeVectorStorage(fakeResults);

      registry = createSharedCommandRegistry();
      registerKnowledgeCommands(registry, {
        generateEmbedding: fakeEmbed.generateEmbedding.bind(fakeEmbed),
        vectorSearch: fakeStorage.search.bind(fakeStorage),
      });

      const cmd = registry.getCommand(SEARCH_CMD);
      expect(cmd).toBeDefined();
      // Simulate existing consumer pattern: only read `chunks`
      const response = (await cmd?.execute({ query: "q" }, {})) as
        | { chunks: unknown[] }
        | undefined;
      expect(response).toBeDefined();
      expect(Array.isArray(response?.chunks)).toBe(true);
      expect(response?.chunks).toHaveLength(1);
    });

    test("staleness rendering: stale chunk shows warning in freshness map", async () => {
      // STALE_ISO is 100 days before 2024-06-01, well past the 90-day stale threshold
      const fakeResults: SearchResult[] = [
        {
          id: "stale-chunk",
          score: 0.7,
          metadata: {
            title: "Old Doc",
            sourceName: "source-A",
            lastModified: STALE_ISO,
          },
        },
      ];

      const fakeEmbed = makeFakeEmbeddingService();
      const fakeStorage = makeFakeVectorStorage(fakeResults);

      registry = createSharedCommandRegistry();
      registerKnowledgeCommands(registry, {
        generateEmbedding: fakeEmbed.generateEmbedding.bind(fakeEmbed),
        vectorSearch: fakeStorage.search.bind(fakeStorage),
      });

      const cmd = registry.getCommand(SEARCH_CMD);
      expect(cmd).toBeDefined();
      const result = (await cmd?.execute({ query: "old" }, {})) as
        | KnowledgeSearchResponse
        | undefined;
      expect(result).toBeDefined();
      expect(result?.freshness["stale-chunk"]?.staleness).toBe("stale");
    });

    test("authority ranking: within-epsilon chunks sorted by source authority", async () => {
      const fakeResults: SearchResult[] = [
        {
          id: "chunk-low",
          score: 0.83,
          metadata: { title: "Low Authority", sourceName: "low-source" },
        },
        {
          id: "chunk-high",
          score: 0.82,
          metadata: { title: "High Authority", sourceName: "high-source" },
        },
      ];

      const fakeEmbed = makeFakeEmbeddingService();
      const fakeStorage = makeFakeVectorStorage(fakeResults);

      registry = createSharedCommandRegistry();
      registerKnowledgeCommands(registry, {
        generateEmbedding: fakeEmbed.generateEmbedding.bind(fakeEmbed),
        vectorSearch: fakeStorage.search.bind(fakeStorage),
        getConfig: makeFakeConfig([], {
          sourceAuthority: { "high-source": 10, "low-source": 2 },
          epsilon: 0.05,
        }),
      });

      const cmd = registry.getCommand(SEARCH_CMD);
      expect(cmd).toBeDefined();
      const result = (await cmd?.execute({ query: "auth" }, {})) as
        | KnowledgeSearchResponse
        | undefined;
      expect(result).toBeDefined();

      // chunks is in relevance order: chunk-low (0.83) first
      expect(result?.chunks[0]?.id).toBe("chunk-low");

      // authority is in authority-priority order: chunk-high (auth=10) first
      expect(result?.authority[0]).toBe("chunk-high");
      expect(result?.authority[1]).toBe("chunk-low");
    });

    test("returns empty structured response when vector storage returns nothing", async () => {
      const fakeEmbed = makeFakeEmbeddingService();
      const fakeStorage = makeFakeVectorStorage([]);

      const deps: KnowledgeCommandsDeps = {
        generateEmbedding: fakeEmbed.generateEmbedding.bind(fakeEmbed),
        vectorSearch: fakeStorage.search.bind(fakeStorage),
      };

      registry = createSharedCommandRegistry();
      registerKnowledgeCommands(registry, deps);

      const cmd = registry.getCommand(SEARCH_CMD);
      expect(cmd).toBeDefined();
      const result = (await cmd?.execute({ query: "nothing" }, {})) as
        | (KnowledgeSearchResponse & { backend: string; degraded: boolean })
        | undefined;
      expect(result).toBeDefined();

      expect(result?.backend).toBe("embeddings");
      expect(result?.degraded).toBe(false);
      expect(result?.chunks).toHaveLength(0);
      expect(result?.authority).toHaveLength(0);
      expect(result?.conflicts).toEqual([]);
      expect(result?.redundancies).toEqual([]);
    });

    test("returns degraded structured result when no vector storage is provided", async () => {
      const fakeEmbed = makeFakeEmbeddingService();

      // Only generateEmbedding injected, no vectorSearch
      const deps: KnowledgeCommandsDeps = {
        generateEmbedding: fakeEmbed.generateEmbedding.bind(fakeEmbed),
      };

      registry = createSharedCommandRegistry();
      registerKnowledgeCommands(registry, deps);

      const cmd = registry.getCommand(SEARCH_CMD);
      expect(cmd).toBeDefined();
      const result = (await cmd?.execute({ query: "test" }, {})) as
        | (KnowledgeSearchResponse & { backend: string; degraded: boolean })
        | undefined;
      expect(result).toBeDefined();

      expect(result?.backend).toBe("none");
      expect(result?.degraded).toBe(true);
      expect(result?.chunks).toHaveLength(0);
      expect(result?.conflicts).toEqual([]);
      expect(result?.redundancies).toEqual([]);
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
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = (await cmd!.execute({}, {})) as { sources: unknown[] };

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
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = (await cmd!.execute({}, {})) as { sources: unknown[] };

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
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        cmd!.execute({ source: "nonexistent-source", documentId: "doc-1" }, {})
      ).rejects.toThrow('Knowledge source not found: "nonexistent-source"');
    });

    test("throws when source exists but token env var is not set", async () => {
      // Ensure the env var is not set
      const tokenVar = "KNOWLEDGE_TEST_TOKEN_THAT_DOES_NOT_EXIST_12345";
      const sourceWithMissingToken: KnowledgeSourceConfig = {
        name: "test-source",
        type: "notion",
        auth: { tokenEnvVar: tokenVar },
      };

      const deps: KnowledgeCommandsDeps = {
        getConfig: makeFakeConfig([sourceWithMissingToken]),
      };

      registry = createSharedCommandRegistry();
      registerKnowledgeCommands(registry, deps);

      const cmd = registry.getCommand(FETCH_CMD);
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        cmd!.execute({ source: "test-source", documentId: "doc-1" }, {})
      ).rejects.toThrow("API token not found.");
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
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = (await cmd!.execute({}, {})) as { reports: SyncReport[] };

      expect(result.reports).toHaveLength(1);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const firstReport = result.reports[0]!;
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
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = (await cmd!.execute({ source: "my-notion", force: false }, {})) as {
        reports: SyncReport[];
      };

      expect(result.reports).toHaveLength(1);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(result.reports[0]!.sourceName).toBe("my-notion");
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
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await cmd!.execute({ force: true }, {});

      expect(capturedOptions?.force).toBe(true);
    });
  });
});
