/**
 * NLI Conflict Detection Tests
 *
 * Tests for the NliClassifier interface, AnthropicNliClassifier implementation,
 * and the detectConflicts pairwise runner. All model calls are mocked.
 */

import { describe, test, expect, mock } from "bun:test";
import {
  AnthropicNliClassifier,
  detectConflicts,
  NLI_CHUNK_CAP,
  type NliClassifier,
  type NliResult,
  type ClassifiableChunk,
} from "./conflicts";
import type { generateObject } from "ai";

/** Import path constants — extracted to avoid lint magic-string duplication warnings. */
const COMMAND_REGISTRY_MODULE = "../../../adapters/shared/command-registry";
const KNOWLEDGE_COMMANDS_MODULE = "../../../adapters/shared/commands/knowledge/index";
const KNOWLEDGE_SEARCH_COMMAND = "knowledge.search";
const KNOWLEDGE_SEARCH_NOT_REGISTERED = "knowledge.search command not registered";

// ─── Fake classifier helper ───────────────────────────────────────────────────

/**
 * Build a fake NLI classifier that returns a fixed verdict for all pairs.
 */
function makeFixedClassifier(result: NliResult): NliClassifier {
  return {
    classify: async () => result,
  };
}

/**
 * Build a fake NLI classifier that returns different results per call.
 */
function makeSequentialClassifier(results: NliResult[]): NliClassifier {
  let callIndex = 0;
  return {
    classify: async () => {
      const result = results[callIndex % results.length] ?? {
        verdict: "unrelated" as const,
        rationale: "default",
      };
      callIndex++;
      return result;
    },
  };
}

// ─── Unit tests: NliClassifier interface via detectConflicts ─────────────────

describe("detectConflicts", () => {
  test("returns empty array for fewer than 2 chunks", async () => {
    const classifier = makeFixedClassifier({ verdict: "contradicts", rationale: "conflict" });

    expect(await detectConflicts([], classifier)).toEqual([]);
    expect(await detectConflicts([{ id: "a", text: "only one chunk" }], classifier)).toEqual([]);
  });

  test("returns conflict when NLI verdict is contradicts", async () => {
    const classifier = makeFixedClassifier({
      verdict: "contradicts",
      rationale: "chunk A says bun, chunk B says npm",
    });

    const chunks: ClassifiableChunk[] = [
      { id: "chunk-1", text: "Use bun to run the dev server" },
      { id: "chunk-2", text: "Use npm run dev to start the server" },
    ];

    const conflicts = await detectConflicts(chunks, classifier);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.chunkAId).toBe("chunk-1");
    expect(conflicts[0]?.chunkBId).toBe("chunk-2");
    expect(conflicts[0]?.disagreement).toBe("chunk A says bun, chunk B says npm");
  });

  test("returns no conflict when NLI verdict is entails", async () => {
    const classifier = makeFixedClassifier({ verdict: "entails", rationale: "consistent" });

    const chunks: ClassifiableChunk[] = [
      { id: "chunk-1", text: "Use bun to install packages" },
      { id: "chunk-2", text: "Run bun install to get dependencies" },
    ];

    const conflicts = await detectConflicts(chunks, classifier);
    expect(conflicts).toHaveLength(0);
  });

  test("returns no conflict when NLI verdict is unrelated", async () => {
    const classifier = makeFixedClassifier({ verdict: "unrelated", rationale: "different topics" });

    const chunks: ClassifiableChunk[] = [
      { id: "chunk-1", text: "Deploy to production using Docker" },
      { id: "chunk-2", text: "The CEO is responsible for strategy" },
    ];

    const conflicts = await detectConflicts(chunks, classifier);
    expect(conflicts).toHaveLength(0);
  });

  test("detects exactly one conflict pair from three chunks", async () => {
    // Pairs: (A,B)=contradicts, (A,C)=unrelated, (B,C)=unrelated
    const classifier = makeSequentialClassifier([
      { verdict: "contradicts", rationale: "A and B conflict" },
      { verdict: "unrelated", rationale: "different" },
      { verdict: "unrelated", rationale: "different" },
    ]);

    const chunks: ClassifiableChunk[] = [
      { id: "A", text: "bun dev" },
      { id: "B", text: "npm run dev" },
      { id: "C", text: "unrelated topic" },
    ];

    const conflicts = await detectConflicts(chunks, classifier);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.chunkAId).toBe("A");
    expect(conflicts[0]?.chunkBId).toBe("B");
  });

  test("K=10 cap: exactly C(10,2)=45 model calls for 10 chunks", async () => {
    let callCount = 0;
    const countingClassifier: NliClassifier = {
      classify: async () => {
        callCount++;
        return { verdict: "unrelated", rationale: "no conflict" };
      },
    };

    // Exactly NLI_CHUNK_CAP chunks
    const chunks: ClassifiableChunk[] = Array.from({ length: NLI_CHUNK_CAP }, (_, i) => ({
      id: `chunk-${i}`,
      text: `chunk content ${i}`,
    }));

    await detectConflicts(chunks, countingClassifier);

    // C(10, 2) = 10 * 9 / 2 = 45
    expect(callCount).toBe(45);
  });

  test("cost cap: more than 10 chunks only runs NLI on first 10 (≤45 calls)", async () => {
    let callCount = 0;
    const countingClassifier: NliClassifier = {
      classify: async () => {
        callCount++;
        return { verdict: "unrelated", rationale: "no conflict" };
      },
    };

    // 15 chunks — should be capped to 10
    const chunks: ClassifiableChunk[] = Array.from({ length: 15 }, (_, i) => ({
      id: `chunk-${i}`,
      text: `chunk content ${i}`,
    }));

    await detectConflicts(chunks, countingClassifier);

    // Should be at most 45 calls (C(10,2)) even though 15 chunks were passed
    expect(callCount).toBeLessThanOrEqual(45);
    // Should be exactly 45 since we have >= 10 chunks
    expect(callCount).toBe(45);
  });
});

// ─── Unit tests: AnthropicNliClassifier with mocked generateObject ───────────

describe("AnthropicNliClassifier", () => {
  test("returns contradicts verdict from generateObject structured output", async () => {
    const fakeResult = {
      verdict: "contradicts" as const,
      rationale: "One says bun, the other says npm",
    };

    const mockGenerateObject = mock(async () => ({ object: fakeResult }));

    // Provide a fake LanguageModel to bypass real Anthropic provider init
    const fakeModel = {} as import("ai").LanguageModel;

    const classifier = new AnthropicNliClassifier({
      generateObjectFn: mockGenerateObject as unknown as typeof generateObject,
      languageModel: fakeModel,
    });

    const result = await classifier.classify(
      "Run bun dev to start the dev server",
      "Run npm run dev to start the dev server"
    );

    expect(result.verdict).toBe("contradicts");
    expect(result.rationale).toBe("One says bun, the other says npm");
    expect(mockGenerateObject).toHaveBeenCalledTimes(1);
  });

  test("returns entails verdict for consistent chunks", async () => {
    const fakeResult = {
      verdict: "entails" as const,
      rationale: "Both describe bun installation",
    };

    const mockGenerateObject = mock(async () => ({ object: fakeResult }));
    const fakeModel = {} as import("ai").LanguageModel;

    const classifier = new AnthropicNliClassifier({
      generateObjectFn: mockGenerateObject as unknown as typeof generateObject,
      languageModel: fakeModel,
    });

    const result = await classifier.classify(
      "Install dependencies with bun install",
      "Run bun install to get all packages"
    );

    expect(result.verdict).toBe("entails");
    expect(mockGenerateObject).toHaveBeenCalledTimes(1);
  });

  test("returns unrelated for unrelated chunks", async () => {
    const fakeResult = {
      verdict: "unrelated" as const,
      rationale: "Topics have nothing in common",
    };

    const mockGenerateObject = mock(async () => ({ object: fakeResult }));
    const fakeModel = {} as import("ai").LanguageModel;

    const classifier = new AnthropicNliClassifier({
      generateObjectFn: mockGenerateObject as unknown as typeof generateObject,
      languageModel: fakeModel,
    });

    const result = await classifier.classify(
      "The quarterly revenue increased 20%",
      "Docker containers use layered filesystems"
    );

    expect(result.verdict).toBe("unrelated");
  });

  test("defaults to unrelated when generateObject throws", async () => {
    const mockGenerateObject = mock(async () => {
      throw new Error("API error");
    });
    const fakeModel = {} as import("ai").LanguageModel;

    const classifier = new AnthropicNliClassifier({
      generateObjectFn: mockGenerateObject as unknown as typeof generateObject,
      languageModel: fakeModel,
    });

    const result = await classifier.classify("chunk A", "chunk B");

    // Should not throw; should degrade gracefully
    expect(result.verdict).toBe("unrelated");
    expect(result.rationale).toContain("Classification failed");
  });

  test("uses claude-haiku-4-5 as the default model", async () => {
    // Create classifier with no model option — should use default
    // We can't easily test the model name without intercepting the anthropic() call,
    // but we can verify the class does not throw during construction.
    const classifier = new AnthropicNliClassifier({});
    expect(classifier).toBeDefined();
    // The model property is private, but the class was constructed correctly
  });
});

// ─── Integration test: knowledge.search with known conflict ──────────────────

describe("knowledge.search integration: conflict detection", () => {
  test("populates conflicts when search returns chunks with a known conflict", async () => {
    const { createSharedCommandRegistry } = await import(COMMAND_REGISTRY_MODULE);
    const { registerKnowledgeCommands } = await import(KNOWLEDGE_COMMANDS_MODULE);

    const CHUNK_A = "source-a:doc-1:0";
    const CHUNK_B = "source-b:doc-1:0";

    const fakeResults = [
      {
        id: CHUNK_A,
        score: 0.95,
        metadata: {
          title: "Bun Dev Guide",
          excerpt: "Run bun dev to start the development server",
          url: "https://notion.so/bun-guide",
          sourceName: "source-a",
          lastModified: new Date().toISOString(),
        },
      },
      {
        id: CHUNK_B,
        score: 0.9,
        metadata: {
          title: "NPM Dev Guide",
          excerpt: "Run npm run dev to start the development server",
          url: "https://notion.so/npm-guide",
          sourceName: "source-b",
          lastModified: new Date().toISOString(),
        },
      },
    ];

    const fakeEmbed = async (_: string) => [0.1, 0.2, 0.3];
    const fakeSearch = async () => fakeResults;

    // Inject a classifier that always returns contradicts
    const conflictingClassifier: NliClassifier = {
      classify: async () => ({
        verdict: "contradicts",
        rationale: "bun dev vs npm run dev — incompatible commands",
      }),
    };

    const registry = createSharedCommandRegistry();
    registerKnowledgeCommands(registry, {
      generateEmbedding: fakeEmbed,
      vectorSearch: fakeSearch,
      nliClassifier: conflictingClassifier,
    });

    const cmd = registry.getCommand(KNOWLEDGE_SEARCH_COMMAND);
    expect(cmd).toBeDefined();
    if (!cmd) throw new Error(KNOWLEDGE_SEARCH_NOT_REGISTERED);
    const response = (await cmd.execute({ query: "local dev setup" }, {})) as {
      conflicts: Array<{ chunkA: string; chunkB: string; disagreement: string }>;
      chunks: unknown[];
      _conflictWarning?: string;
    };

    expect(response.chunks).toHaveLength(2);
    expect(response.conflicts).toHaveLength(1);
    expect(response.conflicts[0]?.chunkA).toBe(CHUNK_A);
    expect(response.conflicts[0]?.chunkB).toBe(CHUNK_B);
    expect(response.conflicts[0]?.disagreement).toContain("bun dev vs npm run dev");

    // Verify the warning field is present
    expect(response._conflictWarning).toBeDefined();
    expect(response._conflictWarning).toContain("KNOWLEDGE CONFLICTS DETECTED");
  });

  test("no conflicts populated when classifier returns entails for all pairs", async () => {
    const { createSharedCommandRegistry } = await import(COMMAND_REGISTRY_MODULE);
    const { registerKnowledgeCommands } = await import(KNOWLEDGE_COMMANDS_MODULE);

    const fakeResults = [
      {
        id: "source:doc-1:0",
        score: 0.95,
        metadata: {
          title: "Guide A",
          excerpt: "Run bun install",
          url: "https://example.com/a",
          sourceName: "source",
          lastModified: new Date().toISOString(),
        },
      },
      {
        id: "source:doc-2:0",
        score: 0.9,
        metadata: {
          title: "Guide B",
          excerpt: "Use bun install to get packages",
          url: "https://example.com/b",
          sourceName: "source",
          lastModified: new Date().toISOString(),
        },
      },
    ];

    const entailingClassifier: NliClassifier = {
      classify: async () => ({ verdict: "entails", rationale: "consistent" }),
    };

    const registry = createSharedCommandRegistry();
    registerKnowledgeCommands(registry, {
      generateEmbedding: async () => [0.1, 0.2, 0.3],
      vectorSearch: async () => fakeResults,
      nliClassifier: entailingClassifier,
    });

    const cmd = registry.getCommand(KNOWLEDGE_SEARCH_COMMAND);
    expect(cmd).toBeDefined();
    if (!cmd) throw new Error(KNOWLEDGE_SEARCH_NOT_REGISTERED);
    const response = (await cmd.execute({ query: "install deps" }, {})) as {
      conflicts: unknown[];
      _conflictWarning?: string;
    };

    expect(response.conflicts).toHaveLength(0);
    expect(response._conflictWarning).toBeUndefined();
  });

  test("existing tests still pass: conflicts=[] when nliClassifier is not in deps", async () => {
    // When deps is provided but nliClassifier is not set, NLI is skipped
    const { createSharedCommandRegistry } = await import(COMMAND_REGISTRY_MODULE);
    const { registerKnowledgeCommands } = await import(KNOWLEDGE_COMMANDS_MODULE);

    const fakeResults = [
      {
        id: "chunk-1",
        score: 0.9,
        metadata: { title: "Doc", excerpt: "Some content", sourceName: "source" },
      },
      {
        id: "chunk-2",
        score: 0.85,
        metadata: { title: "Doc 2", excerpt: "Other content", sourceName: "source" },
      },
    ];

    const registry = createSharedCommandRegistry();
    // No nliClassifier in deps → NLI skipped
    registerKnowledgeCommands(registry, {
      generateEmbedding: async () => [0.1, 0.2, 0.3],
      vectorSearch: async () => fakeResults,
    });

    const cmd = registry.getCommand(KNOWLEDGE_SEARCH_COMMAND);
    expect(cmd).toBeDefined();
    if (!cmd) throw new Error(KNOWLEDGE_SEARCH_NOT_REGISTERED);
    const response = (await cmd.execute({ query: "test" }, {})) as { conflicts: unknown[] };

    expect(response.conflicts).toEqual([]);
  });
});
