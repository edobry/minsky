/**
 * Tests for postgres-migration-operations.ts — unmerged-migration guard
 * (mt#2277)
 *
 * This file tests the pure decision predicates that are separated from
 * git and connection I/O so they can be unit-tested without real DB or
 * real git infrastructure.
 */

import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { createHash } from "crypto";
import {
  isProdPostgresConnection,
  checkUnmergedMigrations,
  computeMigrationHash,
  resolvePendingMigrations,
  UNMERGED_MIGRATION_CHECK_OVERRIDE_ENV,
  type JournalEntry,
} from "./postgres-migration-operations";
import * as childProcess from "child_process";

// ---------------------------------------------------------------------------
// isProdPostgresConnection
// ---------------------------------------------------------------------------

describe("isProdPostgresConnection", () => {
  describe("local / dev connections → NOT prod", () => {
    test("localhost is not prod", () => {
      expect(isProdPostgresConnection("postgresql://user:pass@localhost:5432/db")).toBe(false);
    });

    test("localhost with UPPER CASE host is not prod", () => {
      expect(isProdPostgresConnection("postgresql://user:pass@LOCALHOST:5432/db")).toBe(false);
    });

    test("127.0.0.1 is not prod", () => {
      expect(isProdPostgresConnection("postgresql://user:pass@127.0.0.1:5432/db")).toBe(false);
    });

    test("::1 (IPv6 loopback) is not prod — both bracketed and unbracketed hostname forms", () => {
      // Bun's URL.hostname keeps brackets ("[::1]"); Node's strips them ("::1").
      // The classifier matches both forms so it's correct under either runtime (mt#2277 review).
      // (Under Bun all IPv6 hosts serialize bracketed and normalized, so the unbracketed
      // "::1" pattern is defensive coverage for Node; both expanded and compact forms below
      // normalize to "[::1]" under Bun and are correctly classified non-prod.)
      expect(isProdPostgresConnection("postgresql://user:pass@[::1]:5432/db")).toBe(false);
      expect(isProdPostgresConnection("postgresql://user:pass@[0:0:0:0:0:0:0:1]:5432/db")).toBe(
        false
      );
    });

    test("host.docker.internal is not prod", () => {
      expect(isProdPostgresConnection("postgresql://user:pass@host.docker.internal:5432/db")).toBe(
        false
      );
    });

    test("'postgres' service alias is not prod", () => {
      expect(isProdPostgresConnection("postgresql://user:pass@postgres:5432/db")).toBe(false);
    });

    test("'db' service alias is not prod", () => {
      expect(isProdPostgresConnection("postgresql://user:pass@db:5432/db")).toBe(false);
    });

    test("'database' service alias is not prod", () => {
      expect(isProdPostgresConnection("postgresql://user:pass@database:5432/db")).toBe(false);
    });
  });

  describe("remote connections → IS prod", () => {
    test("Supabase Supavisor pooler host is prod", () => {
      expect(
        isProdPostgresConnection(
          "postgresql://postgres.abc:pass@aws-0-us-west-2.pooler.supabase.com:6543/postgres"
        )
      ).toBe(true);
    });

    test("Supabase direct host is prod", () => {
      expect(
        isProdPostgresConnection(
          "postgresql://postgres:pass@db.yvkkrpyjhoiilmizlnac.supabase.co:5432/postgres"
        )
      ).toBe(true);
    });

    test("Neon.tech host is prod", () => {
      expect(
        isProdPostgresConnection(
          "postgresql://user:pass@ep-quiet-forest-abc.us-east-2.aws.neon.tech:5432/db"
        )
      ).toBe(true);
    });

    test("AWS RDS host is prod", () => {
      expect(
        isProdPostgresConnection(
          "postgresql://admin:pass@mydb.cluster-xyz.us-east-1.rds.amazonaws.com:5432/mydb"
        )
      ).toBe(true);
    });

    test("any unknown remote hostname is prod (conservative)", () => {
      expect(
        isProdPostgresConnection("postgresql://user:pass@some-remote-postgres.example.com:5432/db")
      ).toBe(true);
    });
  });

  describe("edge cases", () => {
    test("unparseable connection string is treated as prod (fail-closed)", () => {
      expect(isProdPostgresConnection("not-a-url")).toBe(true);
    });

    test("empty string is treated as prod (fail-closed)", () => {
      expect(isProdPostgresConnection("")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// checkUnmergedMigrations
// ---------------------------------------------------------------------------

/**
 * Helper to build a JournalEntry with defaults.
 */
function makeEntry(idx: number, tag: string): JournalEntry {
  return { idx, version: "7", when: 1000000 + idx, tag, breakpoints: false };
}

describe("checkUnmergedMigrations", () => {
  // We spy on child_process.execFile and util.promisify chain so we can
  // control git's exit code without a real git repo or real filesystem.

  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  test("returns not-blocked when there are no pending entries", async () => {
    const entries = [makeEntry(0, "0000_initial"), makeEntry(1, "0001_second")];
    // appliedCount = entries.length → no pending
    const result = await checkUnmergedMigrations("migrations/pg", entries, entries.length);
    expect(result.blocked).toBe(false);
    expect(result.unmergedTags).toEqual([]);
  });

  test("returns not-blocked when all pending entries are present on origin/main", async () => {
    // Inject a git that always succeeds (all files present on main)
    const execFileMock = mock(
      (
        _file: string,
        _args: string[],
        _opts: object,
        callback: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        callback(null, "", "");
      }
    );

    const spyExecFile = spyOn(childProcess, "execFile").mockImplementation(execFileMock as any);

    try {
      const entries = [makeEntry(0, "0000_initial"), makeEntry(1, "0001_second")];
      // 0 applied → both are pending; mock says both are on main
      const result = await checkUnmergedMigrations("migrations/pg", entries, 0, "/repo");
      expect(result.blocked).toBe(false);
      expect(result.unmergedTags).toEqual([]);
    } finally {
      spyExecFile.mockRestore();
    }
  });

  // Args-aware mock: `git rev-parse ... origin/main` succeeds (ref resolves);
  // `git cat-file -e origin/main:<path>` succeeds unless the path is in `absent`.
  function gitMock(absentTags: string[]) {
    return mock(
      (
        _file: string,
        args: string[],
        _opts: object,
        callback: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (args[0] === "rev-parse") {
          // `--show-toplevel` returns the repo root; `--verify origin/main` resolves.
          callback(null, args[1] === "--show-toplevel" ? "/repo\n" : "", "");
          return;
        }
        const target = args[2] ?? ""; // "origin/main:<path>"
        if (absentTags.some((tag) => target.includes(tag))) {
          callback(new Error("not found") as any, "", "");
        } else {
          callback(null, "", "");
        }
      }
    );
  }

  test("returns blocked when a pending entry is NOT on origin/main", async () => {
    const spyExecFile = spyOn(childProcess, "execFile").mockImplementation(
      gitMock(["0002_third"]) as any
    );
    try {
      const entries = [
        makeEntry(0, "0000_initial"),
        makeEntry(1, "0001_second"),
        makeEntry(2, "0002_third"),
      ];
      // 1 applied → entries[1] and entries[2] are pending; only 0002_third is absent
      const result = await checkUnmergedMigrations("migrations/pg", entries, 1, "/repo");
      expect(result.blocked).toBe(true);
      expect(result.unmergedTags).toEqual(["0002_third"]);
    } finally {
      spyExecFile.mockRestore();
    }
  });

  test("returns all unmerged tags when multiple pending entries are absent from origin/main", async () => {
    const spyExecFile = spyOn(childProcess, "execFile").mockImplementation(
      gitMock(["0000_initial", "0001_second", "0002_third"]) as any
    );
    try {
      const entries = [
        makeEntry(0, "0000_initial"),
        makeEntry(1, "0001_second"),
        makeEntry(2, "0002_third"),
      ];
      // 0 applied → all 3 are pending; none on origin/main
      const result = await checkUnmergedMigrations("migrations/pg", entries, 0, "/repo");
      expect(result.blocked).toBe(true);
      expect(result.unmergedTags).toEqual(["0000_initial", "0001_second", "0002_third"]);
    } finally {
      spyExecFile.mockRestore();
    }
  });

  test("FAILS OPEN (not blocked, skippedReason set) when origin/main does not resolve", async () => {
    // rev-parse fails → guard cannot run → must NOT block (mt#2277 review fix:
    // a missing/unfetched/differently-named remote is an infra issue, not a true
    // unmerged migration).
    const execFileMock = mock(
      (
        _file: string,
        args: string[],
        _opts: object,
        callback: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (args[0] === "rev-parse") {
          callback(new Error("fatal: bad revision 'origin/main'") as any, "", "");
          return;
        }
        // cat-file would also fail, but we must never reach it
        callback(new Error("should not be called") as any, "", "");
      }
    );
    const spyExecFile = spyOn(childProcess, "execFile").mockImplementation(execFileMock as any);
    try {
      const entries = [makeEntry(0, "0000_initial"), makeEntry(1, "0001_second")];
      const result = await checkUnmergedMigrations("migrations/pg", entries, 0, "/repo");
      expect(result.blocked).toBe(false);
      expect(result.unmergedTags).toEqual([]);
      expect(result.skippedReason).toBeDefined();
      expect(result.skippedReason).toContain("origin/main");
    } finally {
      spyExecFile.mockRestore();
    }
  });

  test("computes a REPO-ROOT-relative cat-file path (no '../') even when cwd is a subdirectory (mt#2278)", async () => {
    // Repo root is /repo; the CLI is invoked from a subdirectory /repo/services/x,
    // and migrationsFolder is an ABSOLUTE path. The cat-file path must be relative
    // to the repo root ("packages/.../<tag>.sql"), NOT cwd-relative (which would
    // contain "../" and make git report the file absent → false block).
    const catFileTargets: string[] = [];
    const execFileMock = mock(
      (
        _file: string,
        args: string[],
        _opts: object,
        callback: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (args[0] === "rev-parse") {
          callback(null, args[1] === "--show-toplevel" ? "/repo\n" : "", "");
          return;
        }
        catFileTargets.push(args[2] ?? ""); // "origin/main:<path>"
        callback(null, "", ""); // present on main
      }
    );
    const spyExecFile = spyOn(childProcess, "execFile").mockImplementation(execFileMock as any);
    try {
      const entries = [makeEntry(0, "0000_initial")];
      const result = await checkUnmergedMigrations(
        "/repo/packages/domain/src/storage/migrations/pg",
        entries,
        0,
        "/repo/services/x" // subdirectory, NOT the repo root
      );
      expect(result.blocked).toBe(false);
      expect(catFileTargets).toHaveLength(1);
      const target = catFileTargets[0] ?? "";
      expect(target).toBe("origin/main:packages/domain/src/storage/migrations/pg/0000_initial.sql");
      expect(target).not.toContain(".."); // the bug this fixes
    } finally {
      spyExecFile.mockRestore();
    }
  });

  test("FAILS OPEN when the repo root cannot be determined (show-toplevel fails)", async () => {
    const execFileMock = mock(
      (
        _file: string,
        args: string[],
        _opts: object,
        callback: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (args[0] === "rev-parse" && args[1] === "--verify") {
          callback(null, "", ""); // origin/main resolves
          return;
        }
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          callback(new Error("not a git repository") as any, "", "");
          return;
        }
        callback(new Error("should not be called") as any, "", "");
      }
    );
    const spyExecFile = spyOn(childProcess, "execFile").mockImplementation(execFileMock as any);
    try {
      const entries = [makeEntry(0, "0000_initial")];
      const result = await checkUnmergedMigrations("migrations/pg", entries, 0, "/repo");
      expect(result.blocked).toBe(false);
      expect(result.unmergedTags).toEqual([]);
      expect(result.skippedReason).toContain("repository root");
    } finally {
      spyExecFile.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// UNMERGED_MIGRATION_CHECK_OVERRIDE_ENV constant
// ---------------------------------------------------------------------------

describe("UNMERGED_MIGRATION_CHECK_OVERRIDE_ENV", () => {
  test("constant is the correct env var name", () => {
    expect(UNMERGED_MIGRATION_CHECK_OVERRIDE_ENV).toBe("MINSKY_SKIP_UNMERGED_MIGRATION_CHECK");
  });
});

// ---------------------------------------------------------------------------
// computeMigrationHash / resolvePendingMigrations — the mt#2936 fix
// ---------------------------------------------------------------------------
//
// mt#2936: getPostgresMigrationsStatus previously computed
// `pendingCount = Math.max(fileCount - appliedCount, 0)` — a raw row-COUNT
// subtraction. When the DB's applied-row count meets or exceeds the local
// file count (for ANY reason unrelated to whether a SPECIFIC migration was
// applied — e.g. a historical ledger squash/consolidation, a duplicate or
// orphaned ledger row), this formula silently clamps to 0 pending even
// though a real migration was never applied. The fix replaces the count
// subtraction with a per-migration HASH set difference: pending = journal
// entries whose file hash is not present in the full set of hashes recorded
// in `__drizzle_migrations`, regardless of raw counts on either side.
//
// These tests exercise the pure core of the fix (`resolvePendingMigrations`)
// with an injected file reader, so they run without touching disk or a real
// DB connection — mirroring the `checkUnmergedMigrations` tests above.

describe("computeMigrationHash", () => {
  test("computes the sha256 hex digest of the raw file content", () => {
    const content = "CREATE TABLE foo (id serial primary key);";
    const expected = createHash("sha256").update(content).digest("hex");
    expect(computeMigrationHash(content)).toBe(expected);
  });

  test("is sensitive to the full raw content, not just a prefix", () => {
    const a = computeMigrationHash("CREATE TABLE foo (id serial);");
    const b = computeMigrationHash("CREATE TABLE foo (id serial); -- trailing comment");
    expect(a).not.toBe(b);
  });

  test("is deterministic — same content always yields the same hash", () => {
    const content = "ALTER TABLE bar ADD COLUMN baz text;";
    expect(computeMigrationHash(content)).toBe(computeMigrationHash(content));
  });
});

describe("resolvePendingMigrations", () => {
  const FAKE_MIGRATIONS_FOLDER = "/fake/migrations/pg";
  const SQL_INITIAL = "CREATE TABLE initial (id serial primary key);";
  const SQL_SECOND = "CREATE TABLE second (id serial primary key);";
  const SCHEDULED_FOLLOW_UPS_TAG = "0002_scheduled_follow_ups";

  /** Build a fake file reader over an in-memory tag → content map. */
  function fakeReader(contents: Record<string, string>): (absPath: string) => string {
    return (absPath: string) => {
      // The entry's tag is embedded in the constructed filename
      // (`<migrationsFolder>/<tag>.sql`); match by suffix so the fake
      // reader doesn't need to replicate path-joining logic.
      const tag = Object.keys(contents).find((t) => absPath.endsWith(`${t}.sql`));
      if (!tag) {
        throw new Error(`fakeReader: no fixture content for path ${absPath}`);
      }
      return contents[tag];
    };
  }

  test(
    "mt#2936 repro: DB ledger row count >= local file count, but a specific " +
      "migration's hash is absent — reports it pending, NOT silently 0",
    () => {
      // Mirrors the exact reported shape: 62 applied rows vs 61 files (ledger
      // AHEAD of files by 1, due to a historical squash/consolidation offset
      // unrelated to any specific migration's apply state), yet the NEWEST
      // migration (0060-equivalent) was never actually applied. Scaled down
      // to 3 journal entries / 4 ledger hashes for a minimal repro.
      const entries: JournalEntry[] = [
        { idx: 0, version: "7", when: 1000, tag: "0000_initial", breakpoints: false },
        { idx: 1, version: "7", when: 2000, tag: "0001_second", breakpoints: false },
        { idx: 2, version: "7", when: 3000, tag: SCHEDULED_FOLLOW_UPS_TAG, breakpoints: false },
      ];
      const contents: Record<string, string> = {
        "0000_initial": SQL_INITIAL,
        "0001_second": SQL_SECOND,
        // The genuinely-unapplied migration — its hash was never recorded.
        [SCHEDULED_FOLLOW_UPS_TAG]: "CREATE TABLE scheduled_follow_ups (id serial primary key);",
      };

      // Ledger has 4 rows (MORE than the 3 local files): the two genuinely
      // applied migrations' hashes, PLUS two extra/orphaned rows (simulating
      // the historical duplicate/consolidation offset) whose hashes match
      // NEITHER local file. Raw count math would compute
      // `Math.max(3 - 4, 0) = 0 pending` — the exact false-0 this task fixes.
      const appliedHashes = new Set<string>([
        computeMigrationHash(contents["0000_initial"]),
        computeMigrationHash(contents["0001_second"]),
        "orphan-hash-from-historical-squash-1",
        "orphan-hash-from-historical-squash-2",
      ]);
      expect(appliedHashes.size).toBeGreaterThanOrEqual(entries.length);

      const pending = resolvePendingMigrations(
        entries,
        FAKE_MIGRATIONS_FOLDER,
        appliedHashes,
        fakeReader(contents)
      );

      expect(pending).toHaveLength(1);
      expect(pending[0]?.tag).toBe(SCHEDULED_FOLLOW_UPS_TAG);
    }
  );

  test("normal case: fewer ledger rows than files — pending computed correctly (no regression)", () => {
    const entries: JournalEntry[] = [
      { idx: 0, version: "7", when: 1000, tag: "0000_initial", breakpoints: false },
      { idx: 1, version: "7", when: 2000, tag: "0001_second", breakpoints: false },
      { idx: 2, version: "7", when: 3000, tag: "0002_third", breakpoints: false },
    ];
    const contents: Record<string, string> = {
      "0000_initial": SQL_INITIAL,
      "0001_second": SQL_SECOND,
      "0002_third": "CREATE TABLE third (id serial primary key);",
    };

    // Only the first migration has been applied — the common/expected shape
    // (ledger behind the file tree).
    const appliedHashes = new Set<string>([computeMigrationHash(contents["0000_initial"])]);
    expect(appliedHashes.size).toBeLessThan(entries.length);

    const pending = resolvePendingMigrations(
      entries,
      FAKE_MIGRATIONS_FOLDER,
      appliedHashes,
      fakeReader(contents)
    );

    expect(pending.map((e) => e.tag)).toEqual(["0001_second", "0002_third"]);
  });

  test("fully applied: every entry's hash is present in the ledger — 0 pending", () => {
    const entries: JournalEntry[] = [
      { idx: 0, version: "7", when: 1000, tag: "0000_initial", breakpoints: false },
      { idx: 1, version: "7", when: 2000, tag: "0001_second", breakpoints: false },
    ];
    const contents: Record<string, string> = {
      "0000_initial": SQL_INITIAL,
      "0001_second": SQL_SECOND,
    };
    const appliedHashes = new Set<string>([
      computeMigrationHash(contents["0000_initial"]),
      computeMigrationHash(contents["0001_second"]),
    ]);

    const pending = resolvePendingMigrations(
      entries,
      FAKE_MIGRATIONS_FOLDER,
      appliedHashes,
      fakeReader(contents)
    );

    expect(pending).toEqual([]);
  });

  test("empty journal — 0 pending regardless of ledger contents", () => {
    const pending = resolvePendingMigrations(
      [],
      FAKE_MIGRATIONS_FOLDER,
      new Set(["some-hash"]),
      fakeReader({})
    );
    expect(pending).toEqual([]);
  });

  test("a migration whose content changed after apply is treated as pending (hash no longer matches)", () => {
    // Not the immutable-migration scenario itself (out of scope here — see
    // memory 59f68687) — just confirms the comparison is content-hash-based,
    // not tag-based: if the recorded hash doesn't match the CURRENT file
    // content, the entry is reported pending.
    const entries: JournalEntry[] = [
      { idx: 0, version: "7", when: 1000, tag: "0000_initial", breakpoints: false },
    ];
    const oldContent = SQL_INITIAL;
    const newContent = "CREATE TABLE initial (id serial primary key, extra text);";
    const appliedHashes = new Set<string>([computeMigrationHash(oldContent)]);

    const pending = resolvePendingMigrations(
      entries,
      FAKE_MIGRATIONS_FOLDER,
      appliedHashes,
      fakeReader({ "0000_initial": newContent })
    );

    expect(pending).toHaveLength(1);
  });
});
