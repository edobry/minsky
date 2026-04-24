/**
 * Architectural regression tests for persistence/session layers.
 *
 * These tests verify structural invariants that prevent the three systemic
 * issues identified in mt#788 from recurring:
 * 1. Cache-before-init: field assigned before async init, not cleaned on failure
 * 2. Error swallowing: catch blocks returning defaults instead of propagating
 * 3. DI bypass: commands importing *FromParams instead of using getDeps()
 */
import { describe, test, expect, beforeAll } from "bun:test";

// Source file paths — single source of truth for all test references
const PATHS = {
  sessionAdapter: "src/domain/session/session-db-adapter.ts",
  persistenceService: "src/domain/persistence/service.ts",
  postgresProvider: "src/domain/persistence/providers/postgres-provider.ts",
  basicCommands: "src/adapters/shared/commands/session/basic-commands.ts",
  managementCommands: "src/adapters/shared/commands/session/management-commands.ts",
  workflowCommands: "src/adapters/shared/commands/session/workflow-commands.ts",
  conflictsCommand: "src/adapters/shared/commands/session/conflicts-command.ts",
  promptCommand: "src/adapters/shared/commands/session/prompt-command.ts",
} as const;

const sourceCache: Record<string, string> = {};
const SOURCE_FILES = Object.values(PATHS);

beforeAll(async () => {
  const root = [import.meta.dir, "..", "..", ".."].join("/");
  for (const f of SOURCE_FILES) {
    sourceCache[f] = await Bun.file([root, f].join("/")).text();
  }
});

function getSource(key: string): string {
  const content = sourceCache[key];
  if (!content) throw new Error(`Source not preloaded: ${key}`);
  return content;
}

describe("Cache-before-init detection", () => {
  test("SessionDbAdapter.getStorage() assigns storage only after initialize()", () => {
    const source = getSource(PATHS.sessionAdapter);

    const getStorageMethod = source.match(
      /private async getStorage\(\)[\s\S]*?return this\.storage/
    )?.[0];
    expect(getStorageMethod).toBeDefined();

    // Verify: "this.storage = storage" appears AFTER "await storage.initialize()"
    const initIdx = getStorageMethod?.indexOf("await storage.initialize()") ?? -1;
    const assignIdx = getStorageMethod?.indexOf("this.storage = storage") ?? -1;
    expect(initIdx).toBeGreaterThan(-1);
    expect(assignIdx).toBeGreaterThan(-1);
    expect(assignIdx).toBeGreaterThan(initIdx);
  });

  test("PersistenceService.performInitialization() assigns provider only after initialize()", () => {
    const source = getSource(PATHS.persistenceService);

    const method = source.match(
      /private async performInitialization[\s\S]*?throw error;\s*\}/
    )?.[0];
    expect(method).toBeDefined();

    const initIdx = method?.indexOf("await provider.initialize()") ?? -1;
    const assignIdx = method?.indexOf("this.provider = provider") ?? -1;
    expect(initIdx).toBeGreaterThan(-1);
    expect(assignIdx).toBeGreaterThan(-1);
    expect(assignIdx).toBeGreaterThan(initIdx);

    // Verify: catch block nulls provider
    const catchBlock = method?.match(/catch[\s\S]*?throw error/)?.[0];
    expect(catchBlock).toContain("this.provider = null");
  });

  test("PostgresPersistenceProvider.initialize() assigns fields only after SELECT 1 verification", () => {
    const source = getSource(PATHS.postgresProvider);

    const method = source.match(/async initialize\(deps[\s\S]*?throw error;\s*\}\s*\}/)?.[0];
    expect(method).toBeDefined();

    // Accept either the original literal form or the withPgPoolRetry wrapper (mt#1193).
    const verifyIdx = method?.search(/sql`SELECT 1`/) ?? -1;
    const assignIdx = method?.indexOf("this.sql = sql") ?? -1;
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(assignIdx).toBeGreaterThan(-1);
    expect(assignIdx).toBeGreaterThan(verifyIdx);

    // The SELECT 1 must be wrapped by withPgPoolRetry so boot-time pool
    // saturation is absorbed rather than cascading to init failure (mt#1193).
    // Matches the specific arrow-fn wrapper form: withPgPoolRetry(() => sql`SELECT 1`)
    expect(method).toMatch(/withPgPoolRetry\(\s*\(\)\s*=>\s*sql`SELECT 1`/);

    const catchBlock = method?.match(/catch[\s\S]*?throw error/)?.[0];
    expect(catchBlock).toContain("this.sql = null");
    expect(catchBlock).toContain("this.db = null");
  });
});

describe("Error swallowing prevention", () => {
  test("SessionDbAdapter does not catch-and-return-default in core query methods", () => {
    const source = getSource(PATHS.sessionAdapter);

    const dangerousPatterns = [
      { method: "getSession", badReturn: "return null" },
      { method: "listSessions", badReturn: "return []" },
      { method: "doesSessionExist", badReturn: "return false" },
    ];

    for (const { method, badReturn } of dangerousPatterns) {
      const methodRegex = new RegExp(
        `async ${method}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)(?=\\n  async |\\n  // Internal|\\n  private)`
      );
      const methodBody = source.match(methodRegex)?.[1];
      expect(methodBody).toBeDefined();

      const hasCatchWithDefault = methodBody?.includes("catch") && methodBody?.includes(badReturn);
      expect(hasCatchWithDefault).toBe(false);
    }
  });
});

describe("DI bypass prevention", () => {
  test("session command handlers do not import *FromParams without eslint-disable", () => {
    const commandFiles = [
      PATHS.basicCommands,
      PATHS.managementCommands,
      PATHS.workflowCommands,
      PATHS.conflictsCommand,
      PATHS.promptCommand,
    ];

    for (const key of commandFiles) {
      const source = getSource(key);
      const lines = source.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (
          line.match(/FromParams/) &&
          line.match(/domain\/session/) &&
          (line.includes("import") || line.includes("await import"))
        ) {
          const prevLine = i > 0 ? (lines[i - 1] ?? "") : "";
          const hasDisable = prevLine.includes("eslint-disable");
          expect(hasDisable).toBe(true);
        }
      }
    }
  });

  test("session command handlers call getDeps() before domain operations", () => {
    const commandFiles = [PATHS.basicCommands, PATHS.managementCommands];

    for (const key of commandFiles) {
      const source = getSource(key);
      const executeBlocks = source.match(/execute:\s*withErrorLogging\([^,]+,\s*async/g);
      const getDepsCount = (source.match(/await getDeps\(\)/g) || []).length;

      expect(getDepsCount).toBeGreaterThanOrEqual(executeBlocks?.length || 0);
    }
  });
});

describe("Provider reuse (runtime)", () => {
  test("container returns the same sessionDeps instance on consecutive get() calls", async () => {
    const { TsyringeContainer } = await import("../../composition/container");
    const container = new TsyringeContainer();

    // Inject a mock sessionDeps via set() — tests use the public API
    const mockDeps = { sessionProvider: { id: "singleton-test" } } as any;
    container.set("sessionDeps", mockDeps);

    // Verify the container returns the same reference on consecutive calls —
    // this is the invariant getDeps() relies on for provider reuse
    const result1 = container.get("sessionDeps");
    const result2 = container.get("sessionDeps");
    expect(result1).toBe(result2);
    expect(result1).toBe(mockDeps);
  });
});
