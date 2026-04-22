/**
 * Memory Commands Integration Tests
 *
 * Tests for the 8 memory commands using fake/injectable MemoryService.
 * Mirrors the structure of knowledge-commands.test.ts.
 */

import { describe, test, expect } from "bun:test";
import { createSharedCommandRegistry } from "../../command-registry";
import { registerMemoryCommands, type MemoryCommandsDeps } from "./index";
import type {
  MemoryRecord,
  MemoryCreateInput,
  MemorySearchResult,
} from "../../../../domain/memory/types";
import type { MemoryService } from "../../../../domain/memory/memory-service";

// ─── Command IDs ──────────────────────────────────────────────────────────────

const SEARCH_CMD = "memory.search";
const GET_CMD = "memory.get";
const LIST_CMD = "memory.list";
const CREATE_CMD = "memory.create";
const UPDATE_CMD = "memory.update";
const DELETE_CMD = "memory.delete";
const SIMILAR_CMD = "memory.similar";
const SUPERSEDE_CMD = "memory.supersede";
const REGISTERED_MSG = "is registered with correct metadata";

// ─── Fake helpers ─────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-1",
    type: "user",
    name: "Test Memory",
    description: "A test memory record",
    content: "edobry prefers strict TypeScript",
    scope: "user",
    projectId: null,
    tags: [],
    sourceAgentId: null,
    sourceSessionId: null,
    confidence: null,
    supersededBy: null,
    metadata: null,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    lastAccessedAt: null,
    accessCount: 0,
    ...overrides,
  };
}

function makeFakeMemoryService(
  overrides: Partial<{
    searchResults: MemorySearchResult[];
    listResults: MemoryRecord[];
    getResult: MemoryRecord | null;
    createResult: MemoryRecord;
    updateResult: MemoryRecord | null;
    similarResults: MemorySearchResult[];
    supersedeResult: { old: MemoryRecord; replacement: MemoryRecord };
  }> = {}
): MemoryService {
  const defaultRecord = makeRecord();
  const defaultReplacement = makeRecord({ id: "mem-2", name: "Replacement" });

  return {
    search: async (_query, _opts) =>
      overrides.searchResults !== undefined
        ? { results: overrides.searchResults, backend: "embeddings", degraded: false }
        : { results: [], backend: "embeddings", degraded: false },

    get: async (_id) => (overrides.getResult !== undefined ? overrides.getResult : defaultRecord),

    list: async (_filter) =>
      overrides.listResults !== undefined ? overrides.listResults : [defaultRecord],

    create: async (_input) =>
      overrides.createResult !== undefined ? overrides.createResult : defaultRecord,

    update: async (_id, _input) =>
      overrides.updateResult !== undefined ? overrides.updateResult : defaultRecord,

    delete: async (_id) => {},

    similar: async (_id, _opts) =>
      overrides.similarResults !== undefined ? overrides.similarResults : [],

    supersede: async (_oldId, _newInput, _reason) =>
      overrides.supersedeResult !== undefined
        ? overrides.supersedeResult
        : { old: defaultRecord, replacement: defaultReplacement },
  } as unknown as MemoryService;
}

function makeDeps(
  serviceOverrides?: Parameters<typeof makeFakeMemoryService>[0]
): MemoryCommandsDeps {
  const service = makeFakeMemoryService(serviceOverrides);
  return { memoryService: service };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Memory Commands", () => {
  // ── memory.search ───────────────────────────────────────────────────────────
  describe(SEARCH_CMD, () => {
    test(REGISTERED_MSG, () => {
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, {});
      const cmd = registry.getCommand(SEARCH_CMD);
      expect(cmd).toBeDefined();
      expect(cmd?.name).toBe("search");
      expect(cmd?.parameters["query"]?.required).toBe(true);
      expect(cmd?.parameters["limit"]?.required).toBe(false);
    });

    test("returns search results from service", async () => {
      const hit = makeRecord({ id: "mem-42", name: "Relevant Memory" });
      const searchResults: MemorySearchResult[] = [{ record: hit, score: 0.9 }];
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, makeDeps({ searchResults }));

      const cmd = registry.getCommand(SEARCH_CMD);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = (await cmd!.execute({ query: "typescript preference" }, {})) as {
        results: MemorySearchResult[];
        backend: string;
        degraded: boolean;
      };

      expect(result.backend).toBe("embeddings");
      expect(result.degraded).toBe(false);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.record.id).toBe("mem-42");
      expect(result.results[0]?.score).toBe(0.9);
    });

    test("returns empty results when service returns none", async () => {
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, makeDeps({ searchResults: [] }));

      const cmd = registry.getCommand(SEARCH_CMD);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = (await cmd!.execute({ query: "nothing" }, {})) as {
        results: MemorySearchResult[];
      };
      expect(result.results).toHaveLength(0);
    });
  });

  // ── memory.get ──────────────────────────────────────────────────────────────
  describe(GET_CMD, () => {
    test(REGISTERED_MSG, () => {
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, {});
      const cmd = registry.getCommand(GET_CMD);
      expect(cmd).toBeDefined();
      expect(cmd?.name).toBe("get");
      expect(cmd?.parameters["id"]?.required).toBe(true);
    });

    test("returns the memory record when found", async () => {
      const record = makeRecord({ id: "mem-77", name: "Found Record" });
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, makeDeps({ getResult: record }));

      const cmd = registry.getCommand(GET_CMD);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = (await cmd!.execute({ id: "mem-77" }, {})) as MemoryRecord;
      expect(result.id).toBe("mem-77");
      expect(result.name).toBe("Found Record");
    });

    test("throws when memory is not found", async () => {
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, makeDeps({ getResult: null }));

      const cmd = registry.getCommand(GET_CMD);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await expect(cmd!.execute({ id: "missing-id" }, {})).rejects.toThrow(
        'Memory not found: "missing-id"'
      );
    });
  });

  // ── memory.list ─────────────────────────────────────────────────────────────
  describe(LIST_CMD, () => {
    test(REGISTERED_MSG, () => {
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, {});
      const cmd = registry.getCommand(LIST_CMD);
      expect(cmd).toBeDefined();
      expect(cmd?.name).toBe("list");
      expect(cmd?.parameters["type"]?.required).toBe(false);
      expect(cmd?.parameters["excludeSuperseded"]?.required).toBe(false);
    });

    test("returns list of records", async () => {
      const records = [makeRecord({ id: "a" }), makeRecord({ id: "b" })];
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, makeDeps({ listResults: records }));

      const cmd = registry.getCommand(LIST_CMD);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = (await cmd!.execute({}, {})) as { records: MemoryRecord[] };
      expect(result.records).toHaveLength(2);
    });

    test("applies limit to results", async () => {
      const records = [makeRecord({ id: "a" }), makeRecord({ id: "b" }), makeRecord({ id: "c" })];
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, makeDeps({ listResults: records }));

      const cmd = registry.getCommand(LIST_CMD);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = (await cmd!.execute({ limit: 2 }, {})) as { records: MemoryRecord[] };
      expect(result.records).toHaveLength(2);
    });
  });

  // ── memory.create ───────────────────────────────────────────────────────────
  describe(CREATE_CMD, () => {
    test(REGISTERED_MSG, () => {
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, {});
      const cmd = registry.getCommand(CREATE_CMD);
      expect(cmd).toBeDefined();
      expect(cmd?.name).toBe("create");
      expect(cmd?.parameters["content"]?.required).toBe(true);
      expect(cmd?.parameters["force"]?.required).toBe(false);
    });

    test("rejects derivable content without force", async () => {
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, makeDeps());

      const cmd = registry.getCommand(CREATE_CMD);
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        cmd!.execute(
          {
            type: "user",
            name: "Code fact",
            description: "Derivable from code",
            content: "The function foo in src/bar.ts does X",
            scope: "user",
          },
          {}
        )
      ).rejects.toThrow("mt#960 rubric");
    });

    test("accepts derivable content with force=true and returns record", async () => {
      const created = makeRecord({ id: "forced-1", name: "Forced" });
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, makeDeps({ createResult: created }));

      const cmd = registry.getCommand(CREATE_CMD);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = (await cmd!.execute(
        {
          type: "user",
          name: "Code fact",
          description: "Derivable from code",
          content: "The function foo in src/bar.ts does X",
          scope: "user",
          force: true,
        },
        {}
      )) as MemoryRecord;
      expect(result.id).toBe("forced-1");
    });

    test("accepts clean content and returns created record", async () => {
      const created = makeRecord({ id: "clean-1", name: "Clean Memory" });
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, makeDeps({ createResult: created }));

      const cmd = registry.getCommand(CREATE_CMD);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = (await cmd!.execute(
        {
          type: "user",
          name: "Clean Memory",
          description: "A genuine cross-conversation insight",
          content: "edobry prefers incremental commits so failures are recoverable",
          scope: "user",
        },
        {}
      )) as MemoryRecord;
      expect(result.id).toBe("clean-1");
    });
  });

  // ── memory.update ───────────────────────────────────────────────────────────
  describe(UPDATE_CMD, () => {
    test(REGISTERED_MSG, () => {
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, {});
      const cmd = registry.getCommand(UPDATE_CMD);
      expect(cmd).toBeDefined();
      expect(cmd?.name).toBe("update");
      expect(cmd?.parameters["id"]?.required).toBe(true);
      expect(cmd?.parameters["name"]?.required).toBe(false);
    });

    test("returns updated record", async () => {
      const updated = makeRecord({ id: "mem-1", name: "Updated Name" });
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, makeDeps({ updateResult: updated }));

      const cmd = registry.getCommand(UPDATE_CMD);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = (await cmd!.execute(
        { id: "mem-1", name: "Updated Name" },
        {}
      )) as MemoryRecord;
      expect(result.name).toBe("Updated Name");
    });

    test("throws when memory is not found", async () => {
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, makeDeps({ updateResult: null }));

      const cmd = registry.getCommand(UPDATE_CMD);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await expect(cmd!.execute({ id: "missing" }, {})).rejects.toThrow(
        'Memory not found: "missing"'
      );
    });
  });

  // ── memory.delete ───────────────────────────────────────────────────────────
  describe(DELETE_CMD, () => {
    test(REGISTERED_MSG, () => {
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, {});
      const cmd = registry.getCommand(DELETE_CMD);
      expect(cmd).toBeDefined();
      expect(cmd?.name).toBe("delete");
      expect(cmd?.parameters["id"]?.required).toBe(true);
    });

    test("returns { deleted: true, id } on success", async () => {
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, makeDeps());

      const cmd = registry.getCommand(DELETE_CMD);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = (await cmd!.execute({ id: "mem-99" }, {})) as { deleted: boolean; id: string };
      expect(result.deleted).toBe(true);
      expect(result.id).toBe("mem-99");
    });
  });

  // ── memory.similar ──────────────────────────────────────────────────────────
  describe(SIMILAR_CMD, () => {
    test(REGISTERED_MSG, () => {
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, {});
      const cmd = registry.getCommand(SIMILAR_CMD);
      expect(cmd).toBeDefined();
      expect(cmd?.name).toBe("similar");
      expect(cmd?.parameters["id"]?.required).toBe(true);
      expect(cmd?.parameters["limit"]?.required).toBe(false);
      expect(cmd?.parameters["threshold"]?.required).toBe(false);
    });

    test("returns similar results excluding the source id", async () => {
      // Service already filters out source — we verify the command passes results through
      const sourceId = "src-mem";
      const similar: MemorySearchResult[] = [
        { record: makeRecord({ id: "neighbor-1" }), score: 0.88 },
        { record: makeRecord({ id: "neighbor-2" }), score: 0.75 },
      ];
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, makeDeps({ similarResults: similar }));

      const cmd = registry.getCommand(SIMILAR_CMD);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = (await cmd!.execute({ id: sourceId }, {})) as {
        results: MemorySearchResult[];
      };
      expect(result.results).toHaveLength(2);
      // Source id must not appear in results
      const ids = result.results.map((r) => r.record.id);
      expect(ids).not.toContain(sourceId);
    });

    test("returns empty when no similar memories found", async () => {
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, makeDeps({ similarResults: [] }));

      const cmd = registry.getCommand(SIMILAR_CMD);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = (await cmd!.execute({ id: "any-id" }, {})) as {
        results: MemorySearchResult[];
      };
      expect(result.results).toHaveLength(0);
    });
  });

  // ── memory.supersede ────────────────────────────────────────────────────────
  describe(SUPERSEDE_CMD, () => {
    test(REGISTERED_MSG, () => {
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, {});
      const cmd = registry.getCommand(SUPERSEDE_CMD);
      expect(cmd).toBeDefined();
      expect(cmd?.name).toBe("supersede");
      expect(cmd?.parameters["oldId"]?.required).toBe(true);
      expect(cmd?.parameters["reason"]?.required).toBe(false);
    });

    test("returns { old, replacement } from service", async () => {
      const oldRecord = makeRecord({ id: "old-1", name: "Old" });
      const replacement = makeRecord({ id: "new-1", name: "New" });
      const registry = createSharedCommandRegistry();
      registerMemoryCommands(
        registry,
        makeDeps({ supersedeResult: { old: oldRecord, replacement } })
      );

      const cmd = registry.getCommand(SUPERSEDE_CMD);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = (await cmd!.execute(
        {
          oldId: "old-1",
          type: "user",
          name: "New",
          description: "Updated memory",
          content: "edobry now prefers 4-space indent",
          scope: "user",
          reason: "preference changed",
        },
        {}
      )) as { old: MemoryRecord; replacement: MemoryRecord };

      expect(result.old.id).toBe("old-1");
      expect(result.replacement.id).toBe("new-1");
    });

    test("superseded record's metadata contains the reason", async () => {
      // The service writes metadata.supersession_reason — we verify the command
      // passes reason through (service is fake, so we capture the call).
      const REFINED_REASON = "refined understanding";
      let capturedReason: string | undefined;
      const fakeService: MemoryService = {
        ...makeFakeMemoryService(),
        supersede: async (_oldId: string, _newInput: MemoryCreateInput, reason?: string) => {
          capturedReason = reason;
          const old = makeRecord({
            id: "old-1",
            supersededBy: "new-1",
            metadata: { supersession_reason: reason ?? null, superseded_at: "2025-01-01" },
          });
          const replacement = makeRecord({ id: "new-1" });
          return { old, replacement };
        },
      } as unknown as MemoryService;

      const registry = createSharedCommandRegistry();
      registerMemoryCommands(registry, { memoryService: fakeService });

      const cmd = registry.getCommand(SUPERSEDE_CMD);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = (await cmd!.execute(
        {
          oldId: "old-1",
          type: "user",
          name: "New",
          description: "Replacement",
          content: "edobry values type safety above all else",
          scope: "user",
          reason: REFINED_REASON,
        },
        {}
      )) as { old: MemoryRecord; replacement: MemoryRecord };

      expect(capturedReason).toBe(REFINED_REASON);
      expect(result.old.metadata?.["supersession_reason"]).toBe(REFINED_REASON);
    });
  });
});
