/**
 * Tests for the fresh-DB bootstrap path (mt#2439).
 *
 * Covers the pure pieces (snapshot loading, stamp-entry selection, statement
 * splitting, ledger-emptiness detection) and the bootstrap orchestration
 * against mock postgres/fs deps — including the critical invariants: a stale
 * snapshot stamps only its own prefix (newer migrations stay pending), ledger
 * hashes mirror drizzle's sha256-of-file-content derivation, and a
 * tables-but-no-ledger database is refused rather than auto-bootstrapped.
 */

import { describe, test, expect } from "bun:test";
import { join } from "path";
import { createHash } from "crypto";
import {
  loadBootstrapSnapshot,
  selectStampEntries,
  splitSqlStatements,
  assertDatabaseTrulyEmpty,
  bootstrapFreshPostgres,
  isMigrationLedgerEmpty,
  type BootstrapFsDeps,
} from "./postgres-bootstrap";
import type { Journal } from "./postgres-migration-operations";

const MIGRATIONS_DIR = "/mock/migrations/pg";
const TAG_BASELINE = "0000_empty_baseline";
const TAG_FIRST = "0001_first_real";
const TAG_NEWER = "0002_newer";

const JOURNAL: Journal = {
  version: "7",
  dialect: "postgresql",
  entries: [
    { idx: 0, version: "7", when: 1000, tag: TAG_BASELINE, breakpoints: true },
    { idx: 1, version: "7", when: 2000, tag: TAG_FIRST, breakpoints: true },
    { idx: 2, version: "7", when: 3000, tag: TAG_NEWER, breakpoints: true },
  ],
};

const SNAPSHOT_SQL = `CREATE TABLE "a" (id int);\n--> statement-breakpoint\nCREATE TABLE "b" (id int);`;

/** In-memory fs fixture covering the snapshot artifact + migration files. */
function makeFsDeps(files: Record<string, string>): BootstrapFsDeps {
  return {
    existsSync: (path: string) => path in files,
    readFileSync: (path: string) => {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return content;
    },
  };
}

function fixtureFiles(
  meta: object = { throughTag: TAG_FIRST, when: 2000 }
): Record<string, string> {
  const files: Record<string, string> = {
    [join(MIGRATIONS_DIR, "bootstrap", "full-schema.sql")]: SNAPSHOT_SQL,
    [join(MIGRATIONS_DIR, "bootstrap", "meta.json")]: JSON.stringify(meta),
  };
  for (const entry of JOURNAL.entries) {
    files[join(MIGRATIONS_DIR, `${entry.tag}.sql`)] = `-- sql for ${entry.tag}`;
  }
  return files;
}

/** Mock postgres client that records every unsafe() statement. */
function makeMockClient(opts: { existingTables?: string[] } = {}) {
  const txExecuted: string[] = [];
  const client = {
    unsafe(query: string): PromiseLike<unknown> {
      if (query.includes("information_schema.tables")) {
        return Promise.resolve((opts.existingTables ?? []).map((t) => ({ table_name: t })));
      }
      return Promise.resolve([]);
    },
    begin(fn: (tx: { unsafe(q: string): PromiseLike<unknown> }) => Promise<unknown>) {
      return fn({
        unsafe(query: string) {
          txExecuted.push(query);
          return Promise.resolve([]);
        },
      });
    },
  };
  return { client, txExecuted };
}

describe("loadBootstrapSnapshot", () => {
  test("returns the parsed snapshot when both artifacts exist", () => {
    const snapshot = loadBootstrapSnapshot(MIGRATIONS_DIR, makeFsDeps(fixtureFiles()));
    expect(snapshot?.meta.throughTag).toBe(TAG_FIRST);
    expect(snapshot?.sql).toBe(SNAPSHOT_SQL);
  });

  test("returns null when the artifact is absent (older bundle fallback)", () => {
    expect(loadBootstrapSnapshot(MIGRATIONS_DIR, makeFsDeps({}))).toBeNull();
  });

  test("throws on malformed meta.json (packaging bug, not a fallback case)", () => {
    const fsDeps = makeFsDeps(fixtureFiles({ nope: true }));
    expect(() => loadBootstrapSnapshot(MIGRATIONS_DIR, fsDeps)).toThrow(
      /Malformed bootstrap snapshot meta/
    );
  });
});

describe("selectStampEntries", () => {
  test("snapshot through the last entry covers the whole journal", () => {
    const entries = selectStampEntries(JOURNAL, { throughTag: TAG_NEWER, when: 3000 });
    expect(entries.map((e) => e.tag)).toEqual([TAG_BASELINE, TAG_FIRST, TAG_NEWER]);
  });

  test("STALE snapshot covers only its prefix — newer entries stay pending", () => {
    const entries = selectStampEntries(JOURNAL, { throughTag: TAG_FIRST, when: 2000 });
    expect(entries.map((e) => e.tag)).toEqual([TAG_BASELINE, TAG_FIRST]);
  });

  test("throws when throughTag is not in the journal", () => {
    expect(() => selectStampEntries(JOURNAL, { throughTag: "0099_ghost", when: 9000 })).toThrow(
      /not in/
    );
  });

  test("throws when meta.when disagrees with the journal entry", () => {
    expect(() => selectStampEntries(JOURNAL, { throughTag: TAG_FIRST, when: 1234 })).toThrow(
      /does not match/
    );
  });
});

describe("splitSqlStatements", () => {
  test("splits on the drizzle statement-breakpoint and drops empties", () => {
    expect(splitSqlStatements(SNAPSHOT_SQL)).toEqual([
      `CREATE TABLE "a" (id int);`,
      `CREATE TABLE "b" (id int);`,
    ]);
    expect(splitSqlStatements("--> statement-breakpoint")).toEqual([]);
  });
});

describe("isMigrationLedgerEmpty", () => {
  function ledgerClient(opts: { tableExists: boolean; rowCount?: number }) {
    return {
      unsafe(query: string): PromiseLike<unknown> {
        if (query.includes("information_schema.tables")) {
          return Promise.resolve([{ exists: opts.tableExists }]);
        }
        return Promise.resolve([{ count: String(opts.rowCount ?? 0) }]);
      },
    };
  }

  test("true when the ledger table is absent", async () => {
    expect(await isMigrationLedgerEmpty(ledgerClient({ tableExists: false }))).toBe(true);
  });

  test("true when the ledger table exists with zero rows (failed prior replay)", async () => {
    expect(await isMigrationLedgerEmpty(ledgerClient({ tableExists: true, rowCount: 0 }))).toBe(
      true
    );
  });

  test("false when the ledger has applied rows (existing database)", async () => {
    expect(await isMigrationLedgerEmpty(ledgerClient({ tableExists: true, rowCount: 46 }))).toBe(
      false
    );
  });
});

describe("assertDatabaseTrulyEmpty", () => {
  test("passes on a database with no public tables", async () => {
    const { client } = makeMockClient();
    await assertDatabaseTrulyEmpty(client);
  });

  test("throws on a tables-but-no-ledger database (ledger-lost state)", async () => {
    const { client } = makeMockClient({ existingTables: ["tasks", "sessions"] });
    await expect(assertDatabaseTrulyEmpty(client)).rejects.toThrow(/ledger-lost/);
  });
});

describe("bootstrapFreshPostgres", () => {
  test("returns null when no snapshot artifact exists", async () => {
    const { client } = makeMockClient();
    expect(
      await bootstrapFreshPostgres(client, MIGRATIONS_DIR, JOURNAL, makeFsDeps({}))
    ).toBeNull();
  });

  test("refuses a non-empty database before executing any DDL", async () => {
    const { client, txExecuted } = makeMockClient({ existingTables: ["tasks"] });
    await expect(
      bootstrapFreshPostgres(client, MIGRATIONS_DIR, JOURNAL, makeFsDeps(fixtureFiles()))
    ).rejects.toThrow(/ledger-lost/);
    expect(txExecuted).toEqual([]);
  });

  test("applies the snapshot, creates the ledger, and stamps covered entries with drizzle-equivalent hashes", async () => {
    const { client, txExecuted } = makeMockClient();
    const result = await bootstrapFreshPostgres(
      client,
      MIGRATIONS_DIR,
      JOURNAL,
      makeFsDeps(fixtureFiles())
    );

    expect(result).toEqual({
      stampedCount: 2,
      throughTag: TAG_FIRST,
      statementCount: 2,
    });

    // Snapshot DDL first, in order.
    expect(txExecuted[0]).toBe(`CREATE TABLE "a" (id int);`);
    expect(txExecuted[1]).toBe(`CREATE TABLE "b" (id int);`);
    // Ledger schema + table.
    expect(txExecuted[2]).toContain(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
    expect(txExecuted[3]).toContain(`"drizzle"."__drizzle_migrations"`);
    // One stamp per covered entry — hash mirrors drizzle (sha256 of file content),
    // created_at mirrors the journal 'when'. The newer entry is NOT stamped.
    const stamps = txExecuted.slice(4);
    expect(stamps).toHaveLength(2);
    const expectedHash0 = createHash("sha256").update(`-- sql for ${TAG_BASELINE}`).digest("hex");
    expect(stamps[0]).toContain(expectedHash0);
    expect(stamps[0]).toContain("1000");
    expect(stamps[1]).toContain("2000");
    expect(txExecuted.join("\n")).not.toContain("3000");
  });
});
