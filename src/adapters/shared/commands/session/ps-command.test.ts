/**
 * Tests for `session ps` / `session attached` (mt#2284).
 */
import { describe, test, expect, mock } from "bun:test";
import { createSessionPsCommand, createSessionAttachedCommand } from "./ps-command";
import type {
  PersistenceProvider,
  SqlCapablePersistenceProvider,
} from "@minsky/domain/persistence/types";
import type { SessionCommandDependencies } from "./types";

function buildGetDeps(
  overrides: Partial<SessionCommandDependencies> = {}
): () => Promise<SessionCommandDependencies> {
  return async () => overrides as unknown as SessionCommandDependencies;
}

/** Chainable fake db matching the drizzle select/delete surface the presence repo uses. */
function makeFakeDb(rows: unknown[] = []) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => Promise.resolve(rows),
    returning: () => Promise.resolve([]),
  };
  return {
    select: mock(() => chain),
    delete: mock(() => chain),
  };
}

function makeGetPersistenceProvider(db: unknown): () => PersistenceProvider | undefined {
  const sqlProvider = {
    getDatabaseConnection: mock(async () => db),
  } as unknown as SqlCapablePersistenceProvider;
  return () => sqlProvider as unknown as PersistenceProvider;
}

describe("createSessionPsCommand", () => {
  test("returns a warning and empty entries when no DB connection is available", async () => {
    const command = createSessionPsCommand(buildGetDeps(), undefined);
    const result = (await command.execute({}, {})) as {
      success: boolean;
      entries: unknown[];
      warning?: string;
    };

    expect(result.success).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.warning).toMatch(/No database connection/);
  });

  test("returns entries from buildSessionPsReport when a DB connection resolves", async () => {
    const db = makeFakeDb([]);
    const getPersistenceProvider = makeGetPersistenceProvider(db);
    const command = createSessionPsCommand(buildGetDeps(), getPersistenceProvider);

    const result = (await command.execute({}, {})) as { success: boolean; entries: unknown[] };

    expect(result.success).toBe(true);
    expect(Array.isArray(result.entries)).toBe(true);
  });

  test("filters entries by sessionId when provided", async () => {
    const db = makeFakeDb([]);
    const getPersistenceProvider = makeGetPersistenceProvider(db);
    const command = createSessionPsCommand(buildGetDeps(), getPersistenceProvider);

    const result = (await command.execute({ sessionId: "session-x" }, {})) as {
      success: boolean;
      entries: unknown[];
    };

    // No stored/live data exists for "session-x" in this fake, so filtering
    // yields an empty (not error) result.
    expect(result.success).toBe(true);
    expect(result.entries).toEqual([]);
  });

  test("runs the stale-attachment reaper when --reap is passed and reports the outcome", async () => {
    const db = makeFakeDb([]);
    const getPersistenceProvider = makeGetPersistenceProvider(db);
    const command = createSessionPsCommand(buildGetDeps(), getPersistenceProvider);

    const result = (await command.execute({ reap: true }, {})) as {
      success: boolean;
      reaped?: { reapedCount: number; skippedRemoteHostCount: number };
    };

    expect(result.success).toBe(true);
    expect(result.reaped).toEqual({ reapedCount: 0, skippedRemoteHostCount: 0 });
  });

  test("does not include a reaped field when --reap is not passed", async () => {
    const db = makeFakeDb([]);
    const getPersistenceProvider = makeGetPersistenceProvider(db);
    const command = createSessionPsCommand(buildGetDeps(), getPersistenceProvider);

    const result = (await command.execute({}, {})) as { reaped?: unknown };

    expect(result.reaped).toBeUndefined();
  });
});

describe("createSessionAttachedCommand", () => {
  test("is a thin alias sharing session.ps's execute behavior", async () => {
    const db = makeFakeDb([]);
    const getPersistenceProvider = makeGetPersistenceProvider(db);
    const command = createSessionAttachedCommand(buildGetDeps(), getPersistenceProvider);

    expect(command.id).toBe("session.attached");
    expect(command.name).toBe("attached");

    const result = (await command.execute({}, {})) as { success: boolean; entries: unknown[] };
    expect(result.success).toBe(true);
    expect(Array.isArray(result.entries)).toBe(true);
  });
});
